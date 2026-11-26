import type { SessionUser } from '../shared/domain'

export interface Session {
  user: SessionUser
  csrf_token: string
}

export class RequestError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; csrf?: string; background?: boolean } = {}): Promise<T> {
  const response = await fetch('/api' + path, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
      ...(options.csrf && { 'X-CSRF-Token': options.csrf }),
      ...(options.background && { 'X-Background-Request': '1' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  if (!response.ok) {
    const failure = await response.json().catch(() => null)
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('session-expired'))
    throw new RequestError(response.status, failure?.error?.message ?? 'Permintaan gagal. Coba lagi.')
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

export function searchUrl(path: string, values: Record<string, string | number | undefined>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') query.set(key, String(value))
  return query.size ? path + '?' + query : path
}
