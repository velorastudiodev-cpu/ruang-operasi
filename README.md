# Ruang Operasi

Dashboard internal untuk penjualan, pesanan, dan stok Toko Studio. Aplikasi menggunakan React, TypeScript, TanStack Query, Recharts, Fastify, Zod, dan PostgreSQL.

## Jalankan lokal

Gunakan Node.js 22.13 atau lebih baru.

```sh
npm ci
npm run dev
```

Buka [dashboard lokal](http://127.0.0.1:5173). Pilih **Admin**, **Manajer**, atau **Staf gudang** di bagian data demo. Kata sandi ketiga akun demo adalah `RuangOperasi2026!`. Mode lokal menyimpan database PGlite, ekspor, dan pratinjau email di `.data/`.

```sh
npm run lint
npm test
npm run build
```

Tes menjalankan API dan database lokal. Untuk menguji PostgreSQL 16, arahkan `TEST_DATABASE_URL` ke database pengujian kosong. Tes membuat data demo dan mengubah isinya. Alur CI juga menjalankan migrasi sebelum tes.

## Perilaku MVP

- KPI menggunakan tanggal pesanan dalam WIB dan rentang tanggal inklusif. Pendapatan bersih adalah total pesanan berstatus `paid`, `processing`, `shipped`, atau `completed` dikurangi refund. AOV membagi pendapatan bersih dengan jumlah pesanan berstatus sama dan membulatkan ke rupiah. Tingkat pembatalan membagi jumlah `cancelled` dengan seluruh pesanan. Penyebut nol menghasilkan nilai nol. Periode pembanding memakai jumlah hari penuh yang sama tepat sebelumnya.
- View KPI disegarkan tiap menit dan dashboard memeriksa perubahan tiap 30 detik. Pengukuran kesegaran dimulai dari ingest yang berhasil. Ringkasan menandai data tertunda ketika view lebih dari 5 menit sejak penyegaran terakhir.
- Saldo stok berasal dari saldo awal dan penyesuaian fisik. Penyesuaian memerlukan alasan. Stok positif di bawah ambang berstatus menipis. Nol berstatus habis. Setiap produk dapat mengantrekan satu email peringatan ke manajer aktif dalam 24 jam. Integrasi stok otomatis memerlukan aturan alokasi, pengiriman, dan retur dari sumber yang akan dipakai.
- Admin dan Manajer melihat data pelanggan dan dapat mengekspor. Staf gudang melihat inisial serta dapat mencari nomor pesanan, melihat stok, dan mencatat penyesuaian. Admin mengelola pengguna, ambang stok, dan audit. Penonaktifan mencabut sesi ketika perubahan disimpan.
- Semua ekspor memakai antrean PostgreSQL dan tampil di riwayat ekspor. Ekspor di atas 100.000 baris juga mengirim tautan. Unduhan tersedia bagi pemilik selama 48 jam.
- Ingest mengidentifikasi pesanan berdasarkan `channel` dan `order_no`. Pembaruan diterapkan jika `source_updated_at` lebih baru. Kanal menggunakan nama yang konsisten dari sumber. Impor CSV Admin memakai aturan yang sama.

## API dan data awal

Spesifikasi tersedia di [OpenAPI lokal](http://127.0.0.1:5173/api/openapi.json). Endpoint aplikasi memakai prefiks `/api`. `GET /healthz` memeriksa koneksi database. Operasi tulis berbasis sesi memakai `X-CSRF-Token` dari endpoint sesi. Nilai pendapatan agregat dikirim sebagai string bilangan bulat agar nilai rupiah tetap presisi.

```http
POST /api/ingest/orders
Content-Type: application/json
X-API-Key: local-demo-ingest-key
```

```json
{
  "orders": [
    {
      "order_no": "INV-12001",
      "channel": "Website",
      "status": "paid",
      "customer_name": "Contoh Pelanggan",
      "total_amount": 175000,
      "ordered_at": "2026-11-26T09:15:00+07:00",
      "source_updated_at": "2026-11-26T09:16:00+07:00"
    }
  ]
}
```

Untuk saldo awal produksi, masukkan hasil hitung gudang ke `products` dan catat saldo positif sebagai `stock_movements` dengan `ref_type='opening'` dalam transaksi yang sama. Gunakan SKU unik. Sesudahnya, catat koreksi fisik melalui halaman stok.

## Demo di Vercel

Konfigurasi Vercel menyajikan frontend Vite dan satu fungsi Fastify. Pilih peran pada bagian **Coba data demo** untuk masuk. Fungsi menggunakan database demo dalam memori. Data, sesi, dan hasil ekspor dapat hilang ketika instance dimulai ulang. Ekspor diproses saat riwayat dimuat, sedangkan KPI diperbarui sesuai permintaan. Gunakan data sintetis untuk demo ini.

## Produksi

Siapkan PostgreSQL 16 dan layanan SMTP. Isi variabel pada `.env.example`, gunakan URL HTTPS publik pada `APP_ORIGIN`, dan atur kredensial Admin awal sebelum startup pertama. Mode produksi mengaktifkan cookie Secure dan mewajibkan HTTPS. Jika memakai Compose, set `POSTGRES_PASSWORD` dan gunakan host `db` pada `DATABASE_URL`. Jalankan `docker compose up -d --build` di belakang reverse proxy yang mengakhiri TLS dan menetapkan `X-Forwarded-Proto`. Port aplikasi di Compose terikat ke loopback.

Jadwalkan `ops/backup.sh` setiap hari dengan `DATABASE_URL` dan `BACKUP_DIR` di lokasi terpisah. Skrip menyimpan dump PostgreSQL dan membersihkan backup setelah 14 hari. Untuk latihan pemulihan kuartalan, jalankan `pg_restore --exit-on-error --dbname="$RESTORE_DATABASE_URL" /path/ruang-YYYY-MM-DD.dump` ke database uji kosong dan cek jumlah pesanan, saldo stok, dan log audit.

Sebelum rilis, validasi terhadap sumber marketplace, siapkan pemantauan error dan ketersediaan, serta ukur target p95 pada lingkungan deploy dengan 1 juta pesanan dan 15 pengguna bersamaan. Pengukuran baseline insiden stok perlu dimulai 30 hari sebelum peluncuran.
