import type { FastifyReply, FastifyRequest } from 'fastify'
import { demoEmails } from './seed.js'

export const sessionCookie = 'ruang_session'
export const demoActivityCookie = 'ruang_demo_activity'
const idleLimit = 8 * 60 * 60_000
const refreshInterval = 60_000
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/', signed: true } as const

export function setDemoSession(reply: FastifyReply, email: string, csrf: string) {
  reply.setCookie(sessionCookie, `${email}|${csrf}|${Date.now()}`, cookieOptions)
}

export function readDemoSession(request: FastifyRequest, cookie: string) {
  const session = request.unsignCookie(cookie)
  if (!session.valid) return
  const [email, csrf, issuedAt] = session.value.split('|')
  if (!demoEmails.includes(email) || !/^[a-f0-9]{64}$/.test(csrf ?? '')) return

  let seenAt = Number(issuedAt)
  const activityCookie = request.cookies[demoActivityCookie]
  if (activityCookie) {
    const activity = request.unsignCookie(activityCookie)
    if (activity.valid) {
      const [activityCsrf, lastSeen] = activity.value.split('|')
      if (activityCsrf === csrf) seenAt = Math.max(seenAt, Number(lastSeen))
    }
  }
  if (!Number.isSafeInteger(seenAt) || Date.now() - seenAt >= idleLimit) return
  return { email, csrf, seenAt }
}

export function refreshDemoSession(reply: FastifyReply, csrf: string, seenAt: number) {
  const now = Date.now()
  // Aktivitas memakai cookie terpisah agar respons lama tidak memulihkan cookie login setelah logout.
  if (now - seenAt >= refreshInterval) reply.setCookie(demoActivityCookie, `${csrf}|${now}`, cookieOptions)
}
