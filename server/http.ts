import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { FastifyRequest } from 'fastify'
import type { Role, SessionUser } from '../shared/domain'
import type { Sql } from './db'

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null
    session: { hash: string; csrf: string } | null
  }
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

export function requireUser(request: FastifyRequest, allowed?: Role[]) {
  if (!request.user) throw new ApiError(401, 'UNAUTHENTICATED', 'Silakan masuk untuk melanjutkan.')
  if (allowed && !allowed.includes(request.user.role)) throw new ApiError(403, 'FORBIDDEN', 'Anda tidak memiliki izin untuk tindakan ini.')
  return request.user
}

export function equalTokens(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const identifier = z.coerce.number().int().min(1).max(2147483647)
export const pageInput = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  page_size: z.coerce.number().refine((n) => [25, 50, 100].includes(n), 'Pilih 25, 50, atau 100 baris.').default(25),
})

export function schema(summary: string, tags: string[], options: { body?: z.ZodType; query?: z.ZodType; params?: z.ZodType; public?: boolean } = {}) {
  const json = (model: z.ZodType) => {
    const { $schema: _dialect, ...result } = z.toJSONSchema(model, { io: 'input', unrepresentable: 'any', target: 'openapi-3.0' })
    return result
  }
  return {
    summary, tags,
    security: options.public ? [] : [{ sessionCookie: [] }],
    ...(options.body && { body: json(options.body) }),
    ...(options.query && { querystring: json(options.query) }),
    ...(options.params && { params: json(options.params) }),
  }
}

export async function audit(sql: Sql, actor: number | null, action: string, entity: string, id: string | number | null, before: unknown, after: unknown) {
  await sql.rows(
    `INSERT INTO audit_logs(actor_id, action, entity, entity_id, before, after)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
    [actor, action, entity, id === null ? null : String(id), before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after)],
  )
}
