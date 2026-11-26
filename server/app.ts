import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { argon2id, hash } from 'argon2'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import swagger from '@fastify/swagger'
import { ZodError, z } from 'zod'
import { authRoutes } from './auth.js'
import { connectDatabase } from './db.js'
import { ApiError, pageInput, requireUser, schema } from './http.js'
import { startJobs } from './jobs.js'
import { kpiRoutes } from './kpi.js'
import { orderRoutes } from './orders.js'
import { seedDemo } from './seed.js'
import { stockRoutes } from './stock.js'

interface AppOptions {
  databaseUrl?: string
  databasePath?: string
  demo?: boolean
  demoSessionSecret?: string
  secure?: boolean
  origin?: string
  ingestKey?: string
  smtp?: string
  smtpFrom?: string
  dataFolder?: string
  logger?: boolean
  trustProxy?: boolean
  jobs?: boolean
  onDemand?: boolean
  serveFrontend?: boolean
  admin?: { email: string; password: string }
}

export async function buildApp(options: AppOptions = {}) {
  const demoSessionSecret = options.demoSessionSecret
  if (demoSessionSecret !== undefined && (!options.demo || !options.secure || demoSessionSecret.length < 32)) {
    throw new Error('DEMO_SESSION_SECRET memerlukan setidaknya 32 karakter, mode demo, dan HTTPS.')
  }
  const app = Fastify({
    logger: options.logger ? {
      serializers: {
        req(request) {
          return { method: request.method, path: request.url?.split('?')[0], remoteAddress: request.ip }
        },
      },
    } : false,
    trustProxy: options.trustProxy ?? false,
  })
  const db = await connectDatabase(options.databaseUrl, options.databasePath)
  app.addHook('onClose', () => db.close())
  try {
    await db.migrate()
    if (options.demo) await seedDemo(db)
    if (options.admin) {
      const [{ exists }] = await db.rows<{ exists: boolean }>('SELECT EXISTS(SELECT 1 FROM users) AS exists')
      if (!exists) {
        const password = z.string().min(12).max(128).parse(options.admin.password)
        const email = z.email().max(254).parse(options.admin.email.toLowerCase())
        await db.rows("INSERT INTO users (email,name,password_hash,role) VALUES($1,'Administrator',$2,'admin') ON CONFLICT(email) DO NOTHING",
          [email, await hash(password, { type: argon2id })])
      }
    }
    let refreshedAt = ''
    let refreshing: Promise<void> | undefined
    const refreshKpi = () => {
      refreshing ??= db.rows(`REFRESH MATERIALIZED VIEW ${db.embedded ? '' : 'CONCURRENTLY '}sales_daily`)
        .then(() => { refreshedAt = new Date().toISOString() })
        .finally(() => { refreshing = undefined })
      return refreshing
    }
    await refreshKpi()
    const refreshTimer = options.onDemand ? undefined : setInterval(() => {
      void refreshKpi().catch((err: unknown) => app.log.error({ err }, 'Gagal menyegarkan KPI'))
    }, 60_000)
    app.addHook('preClose', async () => {
      clearInterval(refreshTimer)
      await refreshing?.catch(() => undefined)
    })

    await app.register(cookie, { secret: demoSessionSecret })
    await app.register(swagger, {
      openapi: {
        info: { title: 'Ruang Operasi API', version: '0.1.0', description: 'Operasi penjualan, pesanan, stok, dan pengguna. Sertakan header X-CSRF-Token dari sesi untuk perubahan terautentikasi.' },
        components: {
          securitySchemes: {
            sessionCookie: { type: 'apiKey', in: 'cookie', name: 'ruang_session' },
            ingestKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          },
        },
      },
    })

    app.addHook('onRequest', async (request, reply) => {
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Referrer-Policy', 'no-referrer')
      reply.header('X-Frame-Options', 'DENY')
      if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store')
      if (options.secure && request.url !== '/healthz') {
        if (request.protocol !== 'https') throw new ApiError(426, 'HTTPS_REQUIRED', 'Permintaan harus menggunakan HTTPS.')
        reply.header('Strict-Transport-Security', 'max-age=31536000')
      }
    })

    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ApiError) {
        return reply.code(error.status).send({ error: { code: error.code, message: error.message } })
      }
      if (error instanceof ZodError) {
        const issue = error.issues[0]
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: issue.path.length
          ? `Periksa nilai untuk ${issue.path.join('.')}. ${issue.message}` : issue.message } })
      }
      const { statusCode, validation } = error as { statusCode?: number; validation?: unknown }
      if (validation || (statusCode && statusCode < 500)) {
        return reply.code(statusCode ?? 400).send({ error: { code: 'INVALID_REQUEST', message: 'Periksa format dan kelengkapan permintaan.' } })
      }
      request.log.error({ err: error }, 'Permintaan gagal')
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Terjadi masalah di server. Coba lagi.' } })
    })

    await authRoutes(app, db, {
      secure: options.secure ?? false,
      origin: options.origin,
      previewMail: !!options.demo && !options.smtp,
      portableDemoSessions: demoSessionSecret !== undefined,
    })
    app.get('/api/auth/options', { schema: { hide: true } }, () => ({ demo: !!options.demo }))
    orderRoutes(app, db, options.ingestKey ?? '')
    stockRoutes(app, db, options.origin)
    kpiRoutes(app, db, () => refreshedAt)

    app.get('/api/audit-logs', { schema: schema('Daftar log audit', ['Audit'], { query: pageInput }) }, async (request) => {
      requireUser(request, ['admin'])
      const { page, page_size } = pageInput.parse(request.query)
      const [result] = await db.rows<{ total: string | number; items: object[] }>(`
        SELECT (SELECT count(*) FROM audit_logs) AS total, coalesce((SELECT jsonb_agg(p) FROM (
          SELECT a.id,a.action,a.entity,a.entity_id,a.before,a.after,a.created_at,u.name AS actor
          FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC,a.id DESC
          LIMIT $1 OFFSET $2
        ) p), '[]'::jsonb) AS items
      `, [page_size, (page - 1) * page_size])
      return { items: result.items, total: Number(result.total), page, page_size }
    })
    const health = async () => {
      await db.rows('SELECT 1')
      return { status: 'ok' }
    }
    app.get('/healthz', { schema: schema('Kesehatan aplikasi dan database', ['Sistem'], { public: true }) }, health)
    if (options.onDemand) app.get('/api/healthz', { schema: { hide: true } }, health)
    app.get('/api/openapi.json', { schema: { hide: true } }, () => app.swagger())

    const staticRoot = resolve('dist')
    const hasFrontend = options.serveFrontend !== false && existsSync(resolve(staticRoot, 'index.html'))
    if (hasFrontend) {
      const { default: fastifyStatic } = await import('@fastify/static')
      await app.register(fastifyStatic, { root: staticRoot })
    }
    app.setNotFoundHandler((request, reply) => {
      if (hasFrontend && request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/assets/')) {
        return reply.sendFile('index.html', { maxAge: 0 })
      }
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Halaman atau endpoint tidak ditemukan.' } })
    })

    const jobs = options.jobs === false ? undefined : startJobs(db, {
        folder: resolve(options.dataFolder ?? '.data'),
        origin: options.origin ?? 'http://localhost:5173',
        smtp: options.smtp,
        from: options.smtpFrom ?? 'Ruang Operasi <ruang-operasi@example.test>',
        onDemand: options.onDemand,
        warn: (err) => app.log.warn({ err }, 'Job latar belakang gagal'),
      })
    if (jobs) app.addHook('preClose', jobs.close)
    await app.ready()
    return {
      app, db, refreshKpi, runJobs: jobs?.run,
      refreshKpiIfDue: () => Date.now() - Date.parse(refreshedAt) >= 60_000 ? refreshKpi() : Promise.resolve(),
    }
  } catch (error) {
    await app.close()
    throw error
  }
}
