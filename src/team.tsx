import { useState, type FormEvent } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, History, MailPlus, UserRound } from 'lucide-react'
import { roles, roleLabels, type Page, type Role, type SessionUser } from '../shared/domain'
import { api, searchUrl, type Session } from './api'
import { dateTime, Empty, ErrorState, FormError, Loading, Modal, number, Pagination, Spinner } from './ui'

interface Member extends SessionUser {
  is_active: boolean
  invited: boolean
  last_login_at: string | null
}

export function Team({ session, notify }: { session: Session; notify: (text: string) => void }) {
  const [invite, setInvite] = useState(false)
  const [preview, setPreview] = useState('')
  const [selected, setSelected] = useState<Member>()
  const members = useQuery({ queryKey: ['users'], queryFn: () => api<{ items: Member[] }>('/users') })
  return <>
    <section className="page-heading"><div><h1>Pengguna</h1><p>Kelola anggota tim dan hak akses operasional.</p></div><button className="button primary" onClick={() => setInvite(true)}><MailPlus size={18} />Undang pengguna</button></section>
    <section className="panel listing-panel"><div className="panel-header"><div><h2>Anggota Toko Studio</h2><p>{members.data ? `${number(members.data.items.length)} pengguna terdaftar` : 'Nama, peran, dan status akun'}</p></div></div>
      {members.isPending && <Loading />}
      {members.isError && <ErrorState error={members.error} retry={() => void members.refetch()} />}
      {!!members.data?.items.length && <div className="table-wrap" tabIndex={0} role="region" aria-label="Tabel anggota"><table className="data-table"><thead><tr><th>Nama</th><th>Peran</th><th>Status</th><th>Terakhir masuk</th><th>Tindakan</th></tr></thead>
        <tbody>{members.data.items.map((member) => <tr key={member.id}>
          <td><div className="product-cell"><span className="product-icon product-person"><UserRound size={18} /></span><div><strong>{member.name}{member.id === session.user.id ? ' (Anda)' : ''}</strong><small>{member.email}</small></div></div></td>
          <td>{roleLabels[member.role]}</td><td><span className={`pill ${!member.is_active ? 'stock-habis' : member.invited ? 'stock-menipis' : 'stock-aman'}`}><i />{!member.is_active ? 'Nonaktif' : member.invited ? 'Diundang' : 'Aktif'}</span></td>
          <td className="nowrap">{member.last_login_at ? dateTime(member.last_login_at) : '—'}</td><td><button className="button small" onClick={() => setSelected(member)}>Edit akses</button></td>
        </tr>)}</tbody></table></div>}
    </section>
    {invite && <MemberForm session={session} close={() => setInvite(false)} notify={notify} preview={setPreview} />}
    {selected && <MemberForm session={session} member={selected} close={() => setSelected(undefined)} notify={notify} preview={setPreview} />}
    {preview && <Modal title="Pratinjau undangan" description="Tautan tersedia di mode lokal. Buka di jendela privat untuk mempertahankan sesi Admin." onClose={() => setPreview('')}>
      <div className="modal-actions"><button className="button" onClick={() => setPreview('')}>Tutup</button><a className="button primary" href={preview} target="_blank" rel="noreferrer">Buka tautan <ArrowUpRight size={16} /></a></div>
    </Modal>}
  </>
}

function MemberForm({ session, member, close, notify, preview }: { session: Session; member?: Member; close: () => void; notify: (text: string) => void; preview: (link: string) => void }) {
  const [role, setRole] = useState<Role>(member?.role ?? 'warehouse')
  const [active, setActive] = useState(member?.is_active ?? true)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const query = useQueryClient()
  const save = useMutation({
    mutationFn: () => api<{ preview_url?: string }>(member ? `/users/${member.id}` : '/users', {
      method: member ? 'PATCH' : 'POST', csrf: session.csrf_token,
      body: member ? { role, is_active: active } : { name, email, role },
    }),
    onSuccess: (result) => {
      void query.invalidateQueries({ queryKey: ['users'] })
      if (member?.id === session.user.id) void query.invalidateQueries({ queryKey: ['session'] })
      notify(member ? 'Hak akses diperbarui.' : 'Undangan ditambahkan ke antrean email.')
      close()
      if (result.preview_url) preview(result.preview_url)
    },
  })
  return <Modal title={member ? 'Edit hak akses' : 'Undang pengguna'} description={member ? member.email : 'Undangan dikirim melalui email dan berlaku 48 jam.'} onClose={close}>
    <form className="modal-form" onSubmit={(event: FormEvent) => { event.preventDefault(); save.mutate() }}>
      {!member && <>
        <label className="field">Nama<input required minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field">Email<input type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      </>}
      <label className="field">Peran<select value={role} onChange={(e) => setRole(e.target.value as Role)}>{roles.map((value) => <option key={value} value={value}>{roleLabels[value]}</option>)}</select></label>
      {member && <label className="check-field"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Akun aktif</label>}
      <FormError error={save.error} />
      <div className="modal-actions"><button className="button" type="button" onClick={close}>Batal</button><button className="button primary" disabled={save.isPending}>{save.isPending && <Spinner size={16} />}{member ? 'Simpan' : 'Kirim undangan'}</button></div>
    </form>
  </Modal>
}

interface AuditEntry { id: number; actor: string | null; action: string; entity: string; entity_id: string | null; created_at: string; before: unknown; after: unknown }
const actionLabels: Record<string, string> = {
  'stock.adjust': 'Penyesuaian stok', 'stock.threshold': 'Ubah ambang', 'orders.export': 'Ekspor pesanan', 'orders.ingest': 'Ingest pesanan',
  'orders.import': 'Impor pesanan', 'user.invite': 'Undangan pengguna', 'user.update': 'Ubah hak akses', 'user.activate': 'Aktivasi pengguna',
}

export function Audit() {
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(25)
  const [selected, setSelected] = useState<AuditEntry>()
  const logs = useQuery({
    queryKey: ['audit', page, size], placeholderData: keepPreviousData,
    queryFn: () => api<Page<AuditEntry>>(searchUrl('/audit-logs', { page, page_size: size })),
  })
  return <>
    <section className="page-heading"><div><h1>Log audit</h1><p>Riwayat perubahan data dan aktivitas ekspor.</p></div></section>
    <section className="panel listing-panel"><div className="panel-header"><div><h2>Aktivitas tercatat</h2><p>{logs.data ? `${number(logs.data.total)} aktivitas` : 'Urutan dari yang terbaru'}</p></div><span className="kpi-icon violet"><History size={20} /></span></div>
      {logs.isPending && <Loading />}
      {logs.isError && <ErrorState error={logs.error} retry={() => void logs.refetch()} />}
      {logs.data && <>
        {logs.data.items.length ? <div className="table-wrap" tabIndex={0} role="region" aria-label="Tabel log audit"><table className="data-table"><thead><tr><th>Waktu</th><th>Pelaku</th><th>Aksi</th><th>Entitas</th><th>Detail</th></tr></thead>
          <tbody>{logs.data.items.map((entry) => <tr key={entry.id}><td className="nowrap">{dateTime(entry.created_at)}</td><td>{entry.actor ?? 'Sistem'}</td><td><strong>{actionLabels[entry.action] ?? entry.action}</strong></td>
            <td>{({ users: 'Pengguna', orders: 'Pesanan', products: 'Produk' } as Record<string, string>)[entry.entity] ?? entry.entity}</td><td><button className="button small" onClick={() => setSelected(entry)}>Lihat perubahan</button></td></tr>)}</tbody></table></div>
          : <Empty text="Belum ada aktivitas" description="Perubahan dan ekspor yang dicatat akan muncul di sini." />}
        <Pagination page={page} size={size} total={logs.data.total} onPage={setPage} onSize={(next) => { setSize(next); setPage(1) }} />
      </>}
    </section>
    {selected && <Modal title={actionLabels[selected.action] ?? selected.action} description={`${dateTime(selected.created_at)} · ${selected.actor ?? 'Sistem'}`} onClose={() => setSelected(undefined)}>
      {selected.entity_id && <p className="muted">ID entitas {selected.entity_id}</p>}
      <div className="audit-diff"><div><strong>Sebelum</strong><pre>{selected.before == null ? '—' : JSON.stringify(selected.before, null, 2)}</pre></div>
        <div><strong>Sesudah</strong><pre>{selected.after == null ? '—' : JSON.stringify(selected.after, null, 2)}</pre></div></div>
    </Modal>}
  </>
}
