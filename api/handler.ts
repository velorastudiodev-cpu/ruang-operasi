import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../server/app.js'

let preview: ReturnType<typeof buildApp> | undefined

async function buildPreview() {
  const demoSessionSecret = process.env.DEMO_SESSION_SECRET
  if (!demoSessionSecret) throw new Error('DEMO_SESSION_SECRET belum diatur pada fungsi Vercel.')
  return buildApp({
    databasePath: 'memory://',
    dataFolder: await mkdtemp(join(tmpdir(), 'ruang-operasi-')),
    demo: true,
    demoSessionSecret,
    secure: true,
    trustProxy: true,
    logger: true,
    onDemand: true,
    serveFrontend: false,
  })
}

export default async function handler(request: IncomingMessage, reply: ServerResponse) {
  const target = new URL(request.url ?? '/', 'http://vercel.internal')
  if (target.pathname === '/api/handler') {
    const forwardedPath = target.searchParams.get('__route')
    if (forwardedPath) {
      target.searchParams.delete('__route')
      request.url = '/api/' + forwardedPath + target.search
    }
  }
  preview ??= buildPreview().catch((error) => {
    preview = undefined
    throw error
  })
  const { app, refreshKpiIfDue, runJobs } = await preview
  const path = request.url?.split('?')[0]
  if (path === '/api/kpi' || path === '/api/orders/channels') await refreshKpiIfDue()
  if (request.method === 'GET' && (path === '/api/orders/exports' || path === '/api/products' || path === '/api/users')) {
    await runJobs?.()
  }
  await new Promise<void>((resolve, reject) => {
    reply.once('finish', resolve)
    reply.once('close', resolve)
    reply.once('error', reject)
    app.server.emit('request', request, reply)
  })
}
