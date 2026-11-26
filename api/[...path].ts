import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../server/app'

let preview: ReturnType<typeof buildApp> | undefined

export default async function handler(request: IncomingMessage, reply: ServerResponse) {
  preview ??= mkdtemp(join(tmpdir(), 'ruang-operasi-')).then((dataFolder) => buildApp({
    databasePath: 'memory://',
    dataFolder,
    demo: true,
    secure: true,
    trustProxy: true,
    logger: true,
    onDemand: true,
    serveFrontend: false,
    origin: undefined,
  })).catch((error) => {
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
