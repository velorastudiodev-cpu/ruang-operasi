import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { Pool } from 'pg'

export interface Sql {
  rows<T = Record<string, unknown>>(statement: string, params?: unknown[]): Promise<T[]>
}

export interface Database extends Sql {
  migrate(): Promise<void>
  transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T>
  close(): Promise<void>
  embedded: boolean
}

export async function connectDatabase(url?: string, localPath = '.data/postgres'): Promise<Database> {
  const migration = () => readFile(new URL('./schema.sql', import.meta.url), 'utf8')
  if (url) {
    const pool = new Pool({ connectionString: url, max: 12 })
    const rows: Sql['rows'] = async (statement, params) => (await pool.query(statement, params)).rows
    return {
      rows,
      embedded: false,
      migrate: async () => { await pool.query(await migration()) },
      transaction: async (work) => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const result = await work({ rows: async (statement, params) => (await client.query(statement, params)).rows })
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally {
          client.release()
        }
      },
      close: () => pool.end(),
    }
  }

  const path = localPath === 'memory://' ? localPath : resolve(localPath)
  if (path !== 'memory://') await mkdir(dirname(path), { recursive: true })
  const postgres = await PGlite.create(path)
  return {
    rows: async <T>(statement: string, params?: unknown[]) => (await postgres.query<T>(statement, params)).rows,
    embedded: true,
    migrate: async () => { await postgres.exec(await migration()) },
    transaction: (work) => postgres.transaction((tx) => work({
      rows: async <T>(statement: string, params?: unknown[]) => (await tx.query<T>(statement, params)).rows,
    })),
    close: () => postgres.close(),
  }
}
