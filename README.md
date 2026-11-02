# Pantau Udara Ring 1

Backend Firebase Functions + bot Telegram + dashboard statis.

## Struktur

```
PROJECT/
├─ dashboard.html          # dashboard (buka langsung di browser)
├─ package.json            # skrip npm untuk bot lokal
├─ database.rules.json     # aturan Realtime Database
├─ firebase.json           # konfigurasi deploy
├─ bot/
│  ├─ local-bot.js         # bot Telegram mode lokal (long polling, tanpa Blaze)
│  └─ jalankan-bot.cmd     # klik dua kali untuk menjalankan bot
├─ functions/
│  ├─ index.js             # ingest, alert, ringkasan, bot Telegram, export CSV
│  ├─ package.json
│  └─ .secret.local        # secret lokal (JANGAN dibagikan / di-commit)
└─ scripts/
   ├─ set-secrets.ps1      # unggah secret ke Firebase Secret Manager
   └─ activate-telegram.ps1 # daftarkan webhook Telegram
```

## 1. Prasyarat

- Node.js 22 LTS
- Firebase CLI
- Akun Google dengan project Firebase (paket **Blaze** diperlukan untuk Secret Manager & scheduler)

Install dari PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
npm install -g firebase-tools
firebase --version
```

Tutup lalu buka ulang terminal setelah install Node agar `node` dan `npm` dikenali.

## 2. Membuka terminal di folder proyek

Di VS Code: **Terminal → New Terminal** (atau `Ctrl + `` ` ``).

Atau dari PowerShell:

```powershell
cd "C:\Users\ASUS\OneDrive\Documents\LOMBAK\PROJECT"
```

## 3. Login dan pilih project

```powershell
firebase login
firebase use --add
```

Pilih project Firebase Anda, lalu beri alias `default`.

## 4. Install dependency functions

```powershell
cd functions
npm install
cd ..
```

## 5. Unggah secret

Token Telegram dan secret lain sudah ada di `functions/.secret.local`. Jalankan:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\set-secrets.ps1 -ProjectId <PROJECT_ID>
```

Jika muncul error Secret Manager/billing, aktifkan paket Blaze di Firebase Console.
Kalau tidak punya kartu kredit, lewati langkah 5–7 dan pakai **bot lokal** di bagian 11.

## 6. Deploy (onlinekan)

```powershell
firebase deploy --only functions
```

Tunggu sampai selesai. Kalau berhasil, nama fungsi akan muncul di output.

## 7. Aktifkan webhook Telegram

```powershell
powershell -ExecutionPolicy Bypass -File scripts\activate-telegram.ps1 -ProjectId <PROJECT_ID>
```

Lalu buka Telegram, kirim `/start` ke **@RINGGUARD_BOT**.

Cek status webhook:

```powershell
Invoke-RestMethod -Method Get `
  -Uri "https://asia-southeast1-<PROJECT_ID>.cloudfunctions.net/telegramSetup?check=1" `
  -Headers @{ "x-api-key" = "<EXPORT_KEY>" }
```

`EXPORT_KEY` ada di `functions/.secret.local`, atau lihat dengan:

```powershell
firebase functions:secrets:access EXPORT_KEY
```

## 8. Perintah berguna

```powershell
firebase functions:log          # lihat log
firebase deploy --only functions # deploy ulang setelah ubah kode
firebase emulators:start        # jalankan lokal (opsional)
```

Untuk mengubah secret: edit `functions/.secret.local`, jalankan lagi `set-secrets.ps1`, lalu deploy ulang.

## 9. Kirim data dari ESP32

```
POST https://asia-southeast1-<PROJECT_ID>.cloudfunctions.net/ingest?node=ring1-01
Header: x-api-key: <INGEST_KEY>
Body JSON: { "pm25": 12.3, "pm10": 20.1, "temp": 30.2, "hum": 65, "gas": 900, "noise": 48, "batt": 3.9 }
```

Daftarkan titik di Realtime Database pada `config/nodes` sebelum mengirim data.

## 10. Dashboard

Isi `CONFIG.DB_URL` di `dashboard.html` dengan URL Realtime Database project Anda, lalu buka file tersebut di browser. Selama masih berisi `NAMA-PROJECT`, dashboard menampilkan data contoh.

Untuk hosting online, jalankan `firebase init hosting` (public directory: `public`), pindahkan dashboard ke `public/index.html`, lalu `firebase deploy --only hosting`.

## 11. Bot Telegram tanpa Blaze (mode lokal)

Kalau project masih di paket **Spark** (tanpa kartu kredit), Cloud Functions tidak bisa dipakai. Alternatifnya menjalankan bot dari komputer sendiri memakai *long polling*.

**Syarat:** sudah `firebase login` di komputer ini, dan `functions/.secret.local` berisi `TELEGRAM_TOKEN`, `ADMIN_CODE`, `HASH_SALT`.

Jalankan dari folder proyek:

```powershell
node bot\local-bot.js --demo
```

atau klik dua kali `bot\jalankan-bot.cmd`.

| Perintah | Fungsi |
|---|---|
| `node bot\local-bot.js` | bot saja (memakai data asli dari database) |
| `node bot\local-bot.js --demo` | bot + data sensor contoh tiap 5 menit |
| `node bot\local-bot.js --seed` | isi 24 jam data contoh, lalu keluar |

Lewat npm:

```powershell
npm run bot
npm run bot:demo
npm run bot:seed
```

**Catatan penting**

- Bot hanya hidup selama terminal/komputer menyala.
- Webhook akan dihapus otomatis saat bot mulai, karena Telegram tidak boleh memakai webhook dan long polling bersamaan.
- Pembacaan dan peringatan tetap ditulis ke Realtime Database (`nodes/.../readings`, `alerts`, `reports`), jadi bisa dipakai dashboard dan export nanti.
- Mode `--demo` menulis data **buatan**. Saat ESP32 sudah terpasang, jalankan tanpa `--demo` agar data asli tidak tertimpa.
- Untuk mengubah perilaku: `RINGGUARD_DB_URL`, `RINGGUARD_DEMO_MS`, `RINGGUARD_CONFIRM_N` (lihat `node bot\local-bot.js --help`).

## Keamanan

- Jangan pernah menaruh token di `index.js` atau meng-commit `functions/.secret.local`.
- Token yang pernah dikirim lewat chat sebaiknya di-regenerate lewat BotFather, lalu perbarui `TELEGRAM_TOKEN` dan deploy ulang.
- `ADMIN_CODE` untuk mendaftarkan analis ada di `functions/.secret.local`.
