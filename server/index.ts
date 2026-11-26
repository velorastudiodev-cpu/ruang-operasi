import 'dotenv/config'
import { resolve } from 'node:path'
import { buildApp } from './app.js'
import { connectDatabase } from './db.js'

const env = process.env
const migrateOnly = process.argv.includes('--migrate')
const production = env.NODE_ENV === 'production'
const appPort = Number(env.APP_PORT ?? 3001)
const dataFolder = resolve(env.APP_DATA_DIR ?? '.data')
const appOrigin = env.APP_ORIGIN ? new URL(env.APP_ORIGIN).origin : undefined

if (migrateOnly) {
  const db = await connectDatabase(env.DATABASE_URL, resolve(dataFolder, 'postgres'))
  try { await db.migrate() } finally { await db.close() }
} else {
  if (production && (!env.DATABASE_URL || !appOrigin?.startsWith('https://') || !env.INGEST_API_KEY || !env.SMTP_URL || !env.SMTP_FROM)) {
    throw new Error('Produksi membutuhkan DATABASE_URL, APP_ORIGIN HTTPS, INGEST_API_KEY, SMTP_URL, dan SMTP_FROM.')
  }
  const { app } = await buildApp({
    databaseUrl: env.DATABASE_URL,
    databasePath: resolve(dataFolder, 'postgres'),
    dataFolder,
    demo: !production && (env.DEMO_MODE === 'true' || (!env.DATABASE_URL && env.DEMO_MODE !== 'false')),
    secure: production,
    logger: true,
    trustProxy: env.TRUST_PROXY === 'true',
    jobs: true,
    origin: appOrigin,
    ingestKey: env.INGEST_API_KEY ?? (production ? undefined : 'local-demo-ingest-key'),
    smtp: env.SMTP_URL,
    smtpFrom: env.SMTP_FROM,
    admin: env.INIT_ADMIN_EMAIL && env.INIT_ADMIN_PASSWORD ? { email: env.INIT_ADMIN_EMAIL, password: env.INIT_ADMIN_PASSWORD } : undefined,
  })
  process.once('SIGINT', () => { void app.close() })
  process.once('SIGTERM', () => { void app.close() })
  await app.listen({ host: env.APP_HOST ?? '127.0.0.1', port: appPort })
}
