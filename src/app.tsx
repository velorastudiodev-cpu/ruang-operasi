import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryFilters } from '@tanstack/react-query'
import {
  ArrowRight, Bell, Boxes, ChevronDown, ChevronRight, CircleHelp, Eye, EyeOff, History, LayoutGrid,
  LockKeyhole, LogOut, Menu, Package, PanelTop, ShoppingBag, Users, X,
} from 'lucide-react'
import { dayInJakarta, roleLabels, type Product, type Role } from '../shared/domain'
import { api, RequestError, type Session } from './api'
import { Orders } from './orders'
import { Inventory } from './inventory'
import { Audit, Team } from './team'
import { ErrorState, FormError, Loading, longDay, Modal, Spinner, Toast } from './ui'

const Dashboard = lazy(() => import('./dashboard').then((module) => ({ default: module.Dashboard })))
const sessionKey = ['session'] as const
const accountQueries: QueryFilters = { predicate: ({ queryKey }) => queryKey[0] !== 'session' && queryKey[0] !== 'login-options' }

const getUrl = () => window.location.pathname + window.location.search
function safeReturn(value: string | null) {
  const url = new URL(value?.startsWith('/') ? value : '/', window.location.origin)
  return url.origin === window.location.origin && url.pathname !== '/masuk' ? url.pathname + url.search : '/'
}
const navItems = [
  { href: '/', label: 'Ringkasan', icon: LayoutGrid, roles: ['admin', 'manager'] },
  { href: '/pesanan', label: 'Pesanan', icon: ShoppingBag, roles: ['admin', 'manager', 'warehouse'] },
  { href: '/stok', label: 'Stok produk', icon: Package, roles: ['admin', 'manager', 'warehouse'] },
  { href: '/pengguna', label: 'Pengguna', icon: Users, roles: ['admin'] },
  { href: '/audit', label: 'Log audit', icon: History, roles: ['admin'] },
] as const

function useNavigation() {
  const [url, setUrl] = useState(getUrl)
  useEffect(() => {
    const receive = () => setUrl(getUrl())
    window.addEventListener('popstate', receive)
    return () => window.removeEventListener('popstate', receive)
  }, [])
  const go = (path: string, replace = false) => {
    if (getUrl() === path) return
    if (replace) window.history.replaceState(null, '', path)
    else window.history.pushState(null, '', path)
    setUrl(path)
    if (!replace) window.scrollTo(0, 0)
  }
  return [url, go] as const
}

function follow(event: MouseEvent<HTMLAnchorElement>, target: string, navigate: (path: string) => void) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.button !== 0) return
  event.preventDefault()
  navigate(target)
}

function Mark() { return <span className="brand-mark"><Boxes size={23} strokeWidth={1.95} aria-hidden="true" /></span> }
function Brand() { return <span className="brand"><Mark /><span>ruang<span className="brand-period">.</span><small>OPERASI</small></span></span> }

function Login({ invite, session, onAuth, onCancelInvite }: { invite: string | null; session?: Session | null; onAuth: (session: Session) => Promise<void>; onCancelInvite: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const options = useQuery({ queryKey: ['login-options'], queryFn: () => api<{ demo: boolean }>('/auth/options') })
  const login = useMutation({
    mutationFn: (details: { email: string; password: string }) => invite
      ? api<Session>('/auth/accept-invite', { method: 'POST', body: { token: invite, password: details.password }, csrf: session?.csrf_token })
      : api<Session>('/auth/login', { method: 'POST', body: details, csrf: session?.csrf_token }),
    onSuccess: onAuth,
  })
  function submit(event: FormEvent) { event.preventDefault(); login.mutate({ email, password }) }
  function demo(role: string) { login.mutate({ email: `${role}@ruangoperasi.test`, password: 'RuangOperasi2026!' }) }
  return <main className="login-layout">
    <section className="login-brand-panel">
      <Brand />
      <div className="login-intro">
        <div className="login-illustration" aria-hidden="true">
          <div><PanelTop size={28} /><span /><span /></div>
          <div className="login-bars">{[38, 60, 46, 82, 68, 105, 94].map((height, i) => <i key={i} style={{ height }} />)}</div>
        </div>
        <h2>Operasional toko dalam satu ruang.</h2>
        <p>Penjualan, pesanan, dan stok Toko Studio.</p>
      </div>
      <span className="login-workspace"><span /> Toko Studio</span>
    </section>
    <section className="login-main">
      <div className="login-form">
        <span className="login-lock"><LockKeyhole size={23} strokeWidth={1.8} aria-hidden="true" /></span>
        <h1>{invite ? 'Aktifkan akun' : 'Masuk ke Ruang Operasi'}</h1>
        <p>{invite ? 'Buat kata sandi dengan minimal 12 karakter.' : 'Gunakan akun kerja Anda untuk melanjutkan.'}</p>
        <form onSubmit={submit}>
          {!invite && <label className="field">Email<input type="email" name="email" placeholder="nama@perusahaan.com" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>}
          <label className="field">Kata sandi
            <span className="password-input"><input type={showPassword ? 'text' : 'password'} name="password" placeholder={invite ? 'Minimal 12 karakter' : 'Masukkan kata sandi'} autoComplete={invite ? 'new-password' : 'current-password'} required minLength={invite ? 12 : undefined} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" className="icon-button" aria-label={showPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button>
            </span>
          </label>
          <FormError error={login.error} />
          <button className="button primary login-submit" disabled={login.isPending}>{invite ? 'Aktifkan akun' : 'Masuk'}{login.isPending ? <Spinner size={17} /> : <ArrowRight size={18} />}</button>
        </form>
        {invite && <button className="text-button login-back" onClick={onCancelInvite}>Kembali ke halaman masuk</button>}
        {!invite && options.data?.demo && <div className="demo">
          <span>Coba data demo</span>
          <div><button className="button" disabled={login.isPending} onClick={() => demo('admin')}>Admin</button><button className="button" disabled={login.isPending} onClick={() => demo('manajer')}>Manajer</button><button className="button" disabled={login.isPending} onClick={() => demo('gudang')}>Staf gudang</button></div>
        </div>}
      </div>
    </section>
  </main>
}

export interface Alerts { out: number; low: number; safe: number; items: Product[] }

export function App() {
  const [url, go] = useNavigation()
  const [showNav, setShowNav] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [toast, setToast] = useState('')
  const menu = useRef<HTMLButtonElement>(null)
  const nav = useRef<HTMLElement>(null)
  const query = useQueryClient()
  const sessionQuery = useQuery({
    queryKey: sessionKey,
    queryFn: ({ signal }) => api<Session>('/auth/session', { background: true, signal }).catch((err: unknown) => {
      if (err instanceof RequestError && err.unauthenticated) return null
      throw err
    }),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })
  const session = sessionQuery.data
  const user = session?.user
  const [path, rawSearch = ''] = url.split('?')
  const params = new URLSearchParams(rawSearch)
  const invitation = params.get('undangan')
  const firstPage = user?.role === 'warehouse' ? '/pesanan' : '/'
  useEffect(() => {
    const verifySession = () => {
      void query.invalidateQueries({ queryKey: sessionKey }, { cancelRefetch: false })
    }
    window.addEventListener('session-check-required', verifySession)
    return () => window.removeEventListener('session-check-required', verifySession)
  }, [query])
  useEffect(() => {
    if (session === null) query.removeQueries(accountQueries)
  }, [query, session])
  useEffect(() => {
    if (session === null && path !== '/masuk' && !invitation) {
      go(`/masuk?kembali=${encodeURIComponent(url)}`, true)
    } else if (session && path === '/masuk' && !invitation) {
      go(params.has('kembali') ? safeReturn(params.get('kembali')) : firstPage, true)
    }
  }, [session, path, invitation, url, firstPage])
  useEffect(() => {
    if (!toast) return
    const timeout = setTimeout(() => setToast(''), 4500)
    return () => clearTimeout(timeout)
  }, [toast])
  useEffect(() => {
    if (!showNav) return
    nav.current?.querySelector<HTMLAnchorElement>('[aria-current="page"]')?.focus()
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowNav(false)
        menu.current?.focus()
      }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [showNav])

  const logout = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST', csrf: session?.csrf_token }),
    onSuccess: async () => {
      await query.cancelQueries({ queryKey: sessionKey })
      query.setQueryData(sessionKey, null)
      setToast('')
      setShowNav(false)
      go('/masuk', true)
    },
    onError: () => { void sessionQuery.refetch() },
  })
  const alerts = useQuery({
    queryKey: ['alerts', user?.id],
    queryFn: () => api<Alerts>('/products/alerts', { background: true }),
    enabled: !!user, refetchInterval: 45_000,
  })
  if (sessionQuery.isPending && !invitation) return <main className="app-loading"><Brand /><Spinner size={24} /><span className="sr-only">Memeriksa sesi</span></main>
  if (sessionQuery.isError && !session && !invitation) return <main className="app-loading"><ErrorState error={sessionQuery.error} retry={() => void sessionQuery.refetch()} /></main>
  if (!session || invitation) return <Login key={invitation ?? 'login'} invite={invitation} session={session} onCancelInvite={() => go('/masuk', true)} onAuth={async (next) => {
    await query.cancelQueries({ queryKey: sessionKey })
    query.removeQueries(accountQueries)
    query.setQueryData(sessionKey, next)
    const nextPage = next.user.role === 'warehouse' ? '/pesanan' : '/'
    const target = safeReturn(params.get('kembali'))
    go(!invitation && params.has('kembali') && target !== '/' ? target : nextPage, true)
  }} />

  const allowed = navItems.filter((item) => (item.roles as readonly Role[]).includes(session.user.role))
  const section = allowed.find((item) => item.href === path) ?? allowed.find((item) => item.href === firstPage)!
  const open = (target: string) => { setShowNav(false); go(target) }
  const attention = (alerts.data?.out ?? 0) + (alerts.data?.low ?? 0)
  const initials = session.user.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()

  return <div className="shell">
    <a className="skip-link" href="#konten">Lewati ke konten</a>
    {showNav && <button className="mobile-backdrop" aria-label="Tutup navigasi" onClick={() => setShowNav(false)} />}
    <aside className={`sidebar ${showNav ? 'open' : ''}`} ref={nav}>
      <a className="brand-link" href={firstPage} onClick={(event) => follow(event, firstPage, open)} aria-label="Ruang Operasi, beranda"><Brand /></a>
      <button className="icon-button mobile-close" type="button" onClick={() => { setShowNav(false); menu.current?.focus() }} aria-label="Tutup navigasi"><X size={20} /></button>
      <div className="workspace"><span className="workspace-icon"><ShoppingBag size={17} strokeWidth={1.9} /></span><div><strong>Toko Studio</strong><span>Workspace internal</span></div></div>
      <nav aria-label="Navigasi utama">
        <div className="nav-label">OPERASIONAL</div>
        {allowed.slice(0, session.user.role === 'warehouse' ? 2 : 3).map((item) => <NavItem key={item.href} item={item} current={section.href} onGo={open} />)}
        {session.user.role === 'admin' && <>
          <div className="nav-label second">PENGATURAN</div>
          {allowed.slice(3).map((item) => <NavItem key={item.href} item={item} current={section.href} onGo={open} />)}
        </>}
      </nav>
      <div className="sidebar-footer">
        <button onClick={() => { setShowNav(false); setShowHelp(true) }}><CircleHelp size={19} strokeWidth={1.8} /> Bantuan</button>
        <div><span className="sidebar-status" /> {session.user.role === 'warehouse' ? 'Operasional gudang' : 'Operasional penjualan'}</div>
      </div>
    </aside>
    <div className="shell-main">
      <header className="topbar">
        <div className="breadcrumb"><button ref={menu} className="icon-button mobile-menu" onClick={() => setShowNav(!showNav)} aria-expanded={showNav} aria-label="Buka navigasi"><Menu size={22} /></button><span>Toko Studio</span><ChevronRight size={14} /><strong>{section.label}</strong></div>
        <div className="topbar-actions">
          <button className="icon-button notification" title="Peringatan stok" onClick={() => open('/stok?peringatan=1')} aria-label={`Peringatan stok, ${attention} produk`}><Bell size={21} strokeWidth={1.8} />{attention > 0 && <i />}</button>
          <details className="account-menu">
            <summary><span className="avatar">{initials}</span><span className="account-copy"><strong>{session.user.name}</strong><small>{roleLabels[session.user.role]}</small></span><ChevronDown size={14} /></summary>
            <div className="account-panel"><strong>{session.user.name}</strong><small>{session.user.email}</small><button onClick={() => logout.mutate()} disabled={logout.isPending}><LogOut size={16} />Keluar</button></div>
          </details>
        </div>
      </header>
      <main key={section.href} id="konten" className="content" tabIndex={-1}>
        {section.href === '/' && <Suspense fallback={<Loading />}><Dashboard alerts={alerts} open={open} /></Suspense>}
        {section.href === '/pesanan' && <Orders key={url} session={session} params={params} notify={setToast} />}
        {section.href === '/stok' && <Inventory key={url} session={session} params={params} notify={setToast} />}
        {section.href === '/pengguna' && <Team session={session} notify={setToast} />}
        {section.href === '/audit' && <Audit />}
        <footer className="content-footer"><span>Ruang Operasi</span><span>{longDay(dayInJakarta())} · WIB</span></footer>
      </main>
    </div>
    {showHelp && <Modal title="Bantuan" onClose={() => setShowHelp(false)} description="Akses yang tersedia bergantung pada peran akun Anda.">
      <ul className="help-list">{allowed.map(({ href, label }) => <li key={href}><button className="text-button" onClick={() => { setShowHelp(false); open(href) }}>{label}<ArrowRight size={15} /></button></li>)}</ul>
      <p className="muted">Hubungi Admin Toko Studio untuk bantuan akun dan akses.</p>
    </Modal>}
    {toast && <Toast message={toast} close={() => setToast('')} />}
  </div>
}

function NavItem({ item, current, onGo }: { item: (typeof navItems)[number]; current: string; onGo: (path: string) => void }) {
  return <a className={`nav-item ${current === item.href ? 'current' : ''}`} href={item.href} aria-current={current === item.href ? 'page' : undefined}
    onClick={(event) => follow(event, item.href, onGo)}><item.icon size={19} strokeWidth={1.85} aria-hidden="true" />{item.label}</a>
}
