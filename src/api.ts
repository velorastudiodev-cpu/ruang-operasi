import type { SessionUser } from '../shared/domain'

export interface Session {
  user: SessionUser
  csrf_token: string
}

export class RequestError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message) }
  get unauthenticated() { return this.status === 401 && this.code === 'UNAUTHENTICATED' }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; csrf?: string; background?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch('/api' + path, {
    method: options.method ?? 'GET',
    signal: options.signal,
    headers: {
      ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
      ...(options.csrf && { 'X-CSRF-Token': options.csrf }),
      ...(options.background && { 'X-Background-Request': '1' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  if (!response.ok) {
    const failure = await response.json().catch(() => null)
    const error = new RequestError(response.status, failure?.error?.message ?? 'Permintaan gagal. Coba lagi.', failure?.error?.code)
    if (error.unauthenticated && !path.startsWith('/auth/')) window.dispatchEvent(new Event('session-check-required'))
    throw error
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

export function searchUrl(path: string, values: Record<string, string | number | undefined>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') query.set(key, String(value))
  return query.size ? path + '?' + query : path
}
