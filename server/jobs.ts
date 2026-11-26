import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import nodemailer from 'nodemailer'
import { statusLabels } from '../shared/domain.js'
import type { Database } from './db.js'
import { orderBy, orderFields, orderFilters, whereOrders, type Filters, type OrderRow } from './orders.js'

type Mail = { to?: string; recipients?: string[]; subject: string; text: string }
type Job = { id: string; owner_id: number; payload: unknown; attempts: number }

function csvCell(value: unknown) {
  let text = String(value ?? '')
  if (/^(\s*[=+@-]|[\t\r\n])/.test(text)) text = "'" + text
  return '"' + text.replace(/"/g, '""') + '"'
}

async function writeExport(db: Database, filters: Filters, temporary: string) {
  const file = await open(temporary, 'w')
  try {
    await file.writeFile('\uFEFFnomor_pesanan,kanal,status,pelanggan,kontak,total_rupiah,waktu_pesanan\r\n')
    return await db.transaction(async (sql) => {
      if (!db.embedded) await sql.rows('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const { where, values } = whereOrders(filters)
      type ExportRow = OrderRow & { ordered_cursor: string }
      let last: ExportRow | undefined
      let count = 0
      for (;;) {
        const cursor = last ? `${where ? ' AND ' : ' WHERE '}( ${filters.sort}, id )
          ${filters.direction === 'asc' ? '>' : '<'} ($${values.length + 1},$${values.length + 2})` : ''
        const rows: ExportRow[] = await sql.rows<ExportRow>(`SELECT ${orderFields},ordered_at::text AS ordered_cursor FROM orders ${where}${cursor}
          ORDER BY ${orderBy(filters)} LIMIT 4000`, last
          ? [...values, filters.sort === 'ordered_at' ? last.ordered_cursor : last[filters.sort], last.id]
          : values)
        if (!rows.length) return count
        await file.writeFile(rows.map((r) => [
          r.order_no, r.channel, statusLabels[r.status], r.customer_name, r.customer_contact, r.total_amount, new Date(r.ordered_at).toISOString(),
        ].map(csvCell).join(',')).join('\r\n') + '\r\n')
        count += rows.length
        last = rows.at(-1)
        if (rows.length < 4000) return count
      }
    })
  } finally {
    await file.close()
  }
}

export function startJobs(db: Database, opts: { folder: string; origin: string; smtp?: string; from: string; onDemand?: boolean; warn: (error: unknown) => void }) {
  const transport = opts.smtp ? nodemailer.createTransport(opts.smtp) : undefined
  const running = new Set<Promise<void>>()
  const activeKinds = new Set<string>()
  const exportsPath = join(opts.folder, 'exports')
  const outboxPath = join(opts.folder, 'outbox')

  async function processOne(kind: 'export' | 'email') {
    const [job] = await db.rows<Job>(`
      UPDATE jobs SET status='running',attempts=attempts+1,available_at=now() + interval '30 minutes'
      WHERE id=(SELECT id FROM jobs WHERE kind=$1 AND status IN ('pending','running') AND available_at <= now()
        ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id,owner_id,payload,attempts
    `, [kind])
    if (!job) return

    const temporary = join(exportsPath, job.id + '.tmp')
    try {
      if (kind === 'email') {
        const mail = job.payload as Mail
        if (transport) {
          const recipients = mail.recipients ?? (mail.to ? [mail.to] : [])
          const active = await db.rows<{ email: string }>('SELECT email FROM users WHERE email=ANY($1::text[]) AND is_active', [recipients])
          if (active.length) {
            await transport.sendMail({
              from: opts.from, bcc: active.map(({ email }) => email), subject: mail.subject, text: mail.text,
              messageId: `<${job.id}@ruang-operasi.local>`,
            })
          }
        } else {
          await mkdir(outboxPath, { recursive: true })
          await writeFile(join(outboxPath, job.id + '.json'), JSON.stringify(mail, null, 2))
        }
        await db.rows("UPDATE jobs SET status='done',finished_at=now(),payload='{}'::jsonb WHERE id=$1", [job.id])
        return
      }

      const [owner] = await db.rows<{ email: string }>("SELECT email FROM users WHERE id=$1 AND is_active AND role IN ('admin','manager')", [job.owner_id])
      if (!owner) {
        await db.rows("UPDATE jobs SET status='failed',finished_at=now() WHERE id=$1", [job.id])
        return
      }
      await mkdir(exportsPath, { recursive: true })
      const count = await writeExport(db, orderFilters.parse(job.payload), temporary)
      const resultPath = join(exportsPath, job.id + '.csv')
      await rename(temporary, resultPath)
      await db.transaction(async (sql) => {
        await sql.rows(`UPDATE jobs SET status='done',result_path=$2,row_count=$3,finished_at=now(),
          expires_at=now() + interval '48 hours',payload='{}'::jsonb WHERE id=$1`, [job.id, resultPath, count])
        if (count > 100_000) {
          const link = `${opts.origin}/api/orders/exports/${job.id}/download`
          await sql.rows("INSERT INTO jobs(id,kind,payload) VALUES($1,'email',$2::jsonb)", [randomUUID(), JSON.stringify({
            to: owner.email, subject: 'Ekspor pesanan siap diunduh',
            text: `Ekspor ${count.toLocaleString('id-ID')} baris siap. Tautan berlaku 48 jam. Masuk ke akun Anda sebelum mengunduh.\n\n${link}`,
          })])
        }
      })
    } catch (error) {
      if (kind === 'export') await rm(temporary, { force: true }).catch(opts.warn)
      await db.rows(`UPDATE jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,
        available_at=now() + interval '15 seconds' * attempts,finished_at=CASE WHEN attempts>=3 THEN now() END WHERE id=$1`, [job.id])
      opts.warn(error)
    }
  }

  async function expireFiles() {
    const expired = await db.rows<{ id: string }>("SELECT id FROM jobs WHERE kind='export' AND expires_at <= now() AND result_path IS NOT NULL LIMIT 100")
    for (const job of expired) {
      await rm(join(exportsPath, job.id + '.csv'), { force: true })
      await db.rows('UPDATE jobs SET result_path=NULL WHERE id=$1', [job.id])
    }
    await db.rows("DELETE FROM sessions WHERE last_seen < now() - interval '8 hours'")
  }

  function launch(kind: string, run: () => Promise<void>) {
    if (activeKinds.has(kind)) return
    activeKinds.add(kind)
    const promise = run().catch(opts.warn).finally(() => {
      activeKinds.delete(kind)
      running.delete(promise)
    })
    running.add(promise)
  }
  async function run() {
    launch('email', () => processOne('email'))
    launch('export', () => processOne('export'))
    await Promise.all(running)
  }
  const worker = opts.onDemand ? undefined : setInterval(() => void run(), 1000)
  const cleanup = opts.onDemand ? undefined : setInterval(() => launch('cleanup', expireFiles), 600_000)
  return { run, async close() {
    clearInterval(worker)
    clearInterval(cleanup)
    await Promise.all(running)
    transport?.close()
  } }
}
