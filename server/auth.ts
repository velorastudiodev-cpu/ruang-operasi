import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { argon2id, hash, verify } from 'argon2'
import { z } from 'zod'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { roles, type SessionUser } from '../shared/domain.js'
import type { Database, Sql } from './db.js'
import { demoActivityCookie, readDemoSession, refreshDemoSession, sessionCookie, setDemoSession } from './demo-session.js'
import { ApiError, audit, equalTokens, identifier, requireUser, schema } from './http.js'
import { demoEmails } from './seed.js'

const loginInput = z.object({ email: z.email().max(254), password: z.string().min(1).max(128) })
const passwordInput = z.string().min(12).max(128)
const inviteInput = z.object({ email: z.email().max(254), name: z.string().trim().min(2).max(100), role: z.enum(roles) })
const updateInput = z.object({ role: z.enum(roles).optional(), is_active: z.boolean().optional() })
const acceptInput = z.object({ token: z.string().length(64), password: passwordInput })
const userId = z.object({ id: identifier })

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
const newToken = () => randomBytes(32).toString('hex')

interface Account extends SessionUser {
  is_active: boolean
  password_hash: string | null
  failed_attempts: number
  locked_until: Date | string | null
}

async function createSession(sql: Sql, reply: FastifyReply, user: SessionUser, config: { secure: boolean; portableDemoSessions: boolean }) {
  const csrf_token = newToken()
  if (config.portableDemoSessions && demoEmails.includes(user.email)) {
    setDemoSession(reply, user.email, csrf_token)
  } else {
    const token = newToken()
    await sql.rows('INSERT INTO sessions(token_hash,user_id,csrf_token) VALUES($1,$2,$3)', [hashToken(token), user.id, csrf_token])
    reply.setCookie(sessionCookie, token, { httpOnly: true, secure: config.secure, sameSite: 'lax', path: '/' })
  }
  return { user: { id: user.id, name: user.name, email: user.email, role: user.role }, csrf_token }
}

export async function authRoutes(app: FastifyInstance, db: Database, config: { secure: boolean; origin?: string; previewMail: boolean; portableDemoSessions: boolean }) {
  const dummyHash = await hash(newToken(), { type: argon2id })
  const requests = new Map<string, { count: number; until: number }>()
  let cleanAfter = 0
  app.decorateRequest('user', null)
  app.decorateRequest('session', null)

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    const isIngest = request.url.split('?')[0] === '/api/ingest/orders'
    const origin = request.headers.origin
    const expected = config.origin ?? `${request.protocol}://${request.host}`
    if (isWrite && !isIngest && (request.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== expected))) {
      throw new ApiError(403, 'ORIGIN_INVALID', 'Asal permintaan tidak diizinkan.')
    }

    const token = request.cookies[sessionCookie]
    if (!isIngest && token?.length === 64) {
      const tokenHash = hashToken(token)
      const [user] = await db.rows<SessionUser & { csrf_token: string }>(`
        SELECT u.id, u.name, u.email, u.role, s.csrf_token
        FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.last_seen > now() - interval '8 hours' AND u.is_active
      `, [tokenHash])
      if (user) {
        request.user = { id: user.id, name: user.name, email: user.email, role: user.role }
        request.session = { hash: tokenHash, csrf: user.csrf_token }
      }
    } else if (!isIngest && config.portableDemoSessions && token) {
      const demoSession = readDemoSession(request, token)
      if (demoSession) {
        const [user] = await db.rows<SessionUser>('SELECT id, name, email, role FROM users WHERE email=$1 AND is_active', [demoSession.email])
        if (user) {
          request.user = user
          request.session = { hash: null, csrf: demoSession.csrf, seenAt: demoSession.seenAt }
        }
      }
    }

    const now = Date.now()
    if (now > cleanAfter) {
      for (const [key, value] of requests) if (value.until <= now) requests.delete(key)
      cleanAfter = now + 60_000
    }
    const key = request.user ? `user:${request.user.id}` : `${isIngest ? 'ingest' : 'ip'}:${request.ip}`
    let counter = requests.get(key)
    if (!counter || now >= counter.until) {
      counter = { count: 0, until: now + 60_000 }
      requests.set(key, counter)
    }
    if (++counter.count > 100) throw new ApiError(429, 'RATE_LIMITED', 'Terlalu banyak permintaan. Coba kembali dalam satu menit.')
    if (request.session && isWrite && !equalTokens(String(request.headers['x-csrf-token'] ?? ''), request.session.csrf)) {
      throw new ApiError(403, 'CSRF_INVALID', 'Sesi perlu disegarkan sebelum melakukan perubahan.')
    }
    const session = request.session
    if (session && request.headers['x-background-request'] !== '1') {
      if (session.hash !== null) {
        await db.rows("UPDATE sessions SET last_seen=now() WHERE token_hash=$1 AND last_seen < now() - interval '10 seconds'", [session.hash])
      } else if (!request.url.startsWith('/api/auth/')) {
        refreshDemoSession(reply, session.csrf, session.seenAt)
      }
    }
  })

  app.post('/api/auth/login', { schema: schema('Masuk', ['Sesi'], { body: loginInput, public: true }) }, async (request, reply) => {
    const { email, password } = loginInput.parse(request.body)
    const result = await db.transaction(async (sql) => {
      const [user] = await sql.rows<Account>('SELECT * FROM users WHERE email=$1 FOR UPDATE', [email.toLowerCase()])
      if (user?.locked_until && new Date(user.locked_until).getTime() > Date.now()) return 'locked'
      const matched = await verify(user?.password_hash ?? dummyHash, password)
      if (!user?.is_active || !user.password_hash) return 'invalid'
      if (!matched) {
        const failed = (user.locked_until ? 0 : user.failed_attempts) + 1
        await sql.rows(`UPDATE users SET failed_attempts=$1, locked_until=CASE WHEN $1 >= 5
          THEN now() + interval '15 minutes' ELSE NULL END WHERE id=$2`, [failed, user.id])
        return failed >= 5 ? 'locked' : 'invalid'
      }
      await sql.rows('UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1', [user.id])
      if (request.session?.hash) await sql.rows('DELETE FROM sessions WHERE token_hash=$1', [request.session.hash])
      return createSession(sql, reply, user, config)
    })
    if (result === 'locked') throw new ApiError(423, 'ACCOUNT_LOCKED', 'Akun dikunci selama 15 menit setelah lima percobaan gagal.')
    if (result === 'invalid') throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email atau kata sandi salah.')
    return result
  })

  app.get('/api/auth/session', { schema: schema('Periksa sesi', ['Sesi']) }, (request) => {
    const user = requireUser(request)
    return { user, csrf_token: request.session!.csrf }
  })

  app.post('/api/auth/logout', { schema: schema('Keluar', ['Sesi']) }, async (request, reply) => {
    if (request.session?.hash) await db.rows('DELETE FROM sessions WHERE token_hash=$1', [request.session.hash])
    const cookieOptions = { path: '/', secure: config.secure, httpOnly: true, sameSite: 'lax' } as const
    reply.clearCookie(sessionCookie, cookieOptions)
    if (config.portableDemoSessions) reply.clearCookie(demoActivityCookie, cookieOptions)
    return reply.code(204).send()
  })

  app.post('/api/auth/accept-invite', { schema: schema('Aktifkan akun dari undangan', ['Sesi'], { body: acceptInput, public: true }) }, async (request, reply) => {
    const { token, password } = acceptInput.parse(request.body)
    const passwordHash = await hash(password, { type: argon2id })
    return db.transaction(async (sql) => {
      const [user] = await sql.rows<Account>(`SELECT u.* FROM invitations i JOIN users u ON u.id=i.user_id
        WHERE i.token_hash=$1 AND i.expires_at > now() AND u.is_active AND u.password_hash IS NULL FOR UPDATE OF u, i`, [hashToken(token)])
      if (!user) throw new ApiError(400, 'INVITATION_INVALID', 'Tautan undangan tidak berlaku atau sudah digunakan.')
      await sql.rows('UPDATE users SET password_hash=$1,last_login_at=now() WHERE id=$2', [passwordHash, user.id])
      await sql.rows('DELETE FROM invitations WHERE user_id=$1', [user.id])
      await audit(sql, user.id, 'user.activate', 'users', user.id, { invited: true }, { invited: false })
      if (request.session?.hash) await sql.rows('DELETE FROM sessions WHERE token_hash=$1', [request.session.hash])
      return createSession(sql, reply, user, config)
    })
  })

  const usersFields = 'id,name,email,role,is_active,last_login_at,(password_hash IS NULL) AS invited'
  app.get('/api/users', { schema: schema('Daftar anggota', ['Pengguna']) }, async (request) => {
    requireUser(request, ['admin'])
    return { items: await db.rows(`SELECT ${usersFields} FROM users ORDER BY name,id`) }
  })

  function inviteLink(request: FastifyRequest, token: string) {
    return `${config.origin ?? `${request.protocol}://${request.host}`}/?undangan=${token}`
  }

  app.post('/api/users', { schema: schema('Undang anggota', ['Pengguna'], { body: inviteInput }) }, async (request, reply) => {
    const actor = requireUser(request, ['admin'])
    const { name, email, role } = inviteInput.parse(request.body)
    const token = newToken()
    const link = inviteLink(request, token)
    const lowerEmail = email.toLowerCase()
    const user = await db.transaction(async (sql) => {
      const [newUser] = await sql.rows<SessionUser>(`INSERT INTO users(name,email,role) VALUES($1,$2,$3)
        ON CONFLICT(email) DO NOTHING RETURNING id,name,email,role`, [name, lowerEmail, role])
      if (!newUser) throw new ApiError(409, 'EMAIL_EXISTS', 'Alamat email sudah terdaftar.')
      await sql.rows("INSERT INTO invitations VALUES($1,$2,now() + interval '48 hours')", [hashToken(token), newUser.id])
      await sql.rows("INSERT INTO jobs(id,kind,payload) VALUES($1,'email',$2::jsonb)", [randomUUID(), JSON.stringify({
        to: lowerEmail, subject: 'Undangan bergabung ke Ruang Operasi',
        text: `Halo ${name},\n\nAktifkan akun Ruang Operasi dalam 48 jam melalui tautan ini.\n${link}`,
      })])
      await audit(sql, actor.id, 'user.invite', 'users', newUser.id, null, { name, email: lowerEmail, role })
      return newUser
    })
    return reply.code(201).send({ user, ...(config.previewMail && { preview_url: link }) })
  })

  app.patch('/api/users/:id', { schema: schema('Ubah peran atau status anggota', ['Pengguna'], { body: updateInput, params: userId }) }, async (request) => {
    const actor = requireUser(request, ['admin'])
    const { id } = userId.parse(request.params)
    const updates = updateInput.parse(request.body)
    return db.transaction(async (sql) => {
      const admins = await sql.rows<{ id: number }>(`SELECT id FROM users
        WHERE role='admin' AND is_active AND password_hash IS NOT NULL ORDER BY id FOR UPDATE`)
      if (!admins.some((admin) => admin.id === actor.id)) throw new ApiError(403, 'FORBIDDEN', 'Akses Admin telah berubah.')
      const [target] = await sql.rows<Account>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id])
      if (!target) throw new ApiError(404, 'USER_NOT_FOUND', 'Pengguna tidak ditemukan.')
      const before = { role: target.role, is_active: target.is_active }
      const after = { role: updates.role ?? before.role, is_active: updates.is_active ?? before.is_active }
      if (admins.length === 1 && admins[0].id === id && (after.role !== 'admin' || !after.is_active)) {
        throw new ApiError(409, 'LAST_ADMIN', 'Admin aktif terakhir harus tetap memiliki akses.')
      }
      if (before.role === after.role && before.is_active === after.is_active) return { id, ...after }
      await sql.rows('UPDATE users SET role=$1,is_active=$2 WHERE id=$3', [after.role, after.is_active, id])
      if (!after.is_active) await sql.rows('DELETE FROM sessions WHERE user_id=$1', [id])
      await audit(sql, actor.id, 'user.update', 'users', id, before, after)
      return { id, ...after }
    })
  })
}
