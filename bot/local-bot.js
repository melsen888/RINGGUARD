"use strict";
/*
  RingGuard - bot Telegram mode lokal (tanpa Blaze)

  Cara kerja:
    - Mengambil pesan lewat long polling getUpdates (bukan webhook), jadi tidak butuh Cloud Functions.
    - Membaca/menulis Firebase Realtime Database lewat REST memakai token Firebase CLI yang sudah login.
    - Menjalankan mesin peringatan tiap 5 menit dan ringkasan harian 07:00 WIB.

  Jalankan:
    node bot/local-bot.js            bot saja
    node bot/local-bot.js --demo     bot + data sensor contoh tiap 5 menit
    node bot/local-bot.js --seed     isi 24 jam data contoh lalu keluar
    node bot/local-bot.js --help

  Rahasia dibaca dari functions/.secret.local (tidak pernah ditulis di kode).
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const SECRET_FILE = path.join(ROOT, "functions", ".secret.local");
const FIREBASE_CFG = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");

// Klien OAuth publik milik Firebase CLI (dipakai ulang agar bisa menulis RTDB).
const GOOGLE_CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

const ARGS = new Set(process.argv.slice(2).map((a) => a.toLowerCase()));
const DEMO = ARGS.has("--demo") || process.env.RINGGUARD_DEMO === "1";
const SEED = ARGS.has("--seed");

// ---------------------------------------------------------------- konfigurasi
const CFG = {
  DB_URL: (process.env.RINGGUARD_DB_URL || "https://ringguard-fff63-default-rtdb.asia-southeast1.firebasedatabase.app").replace(/\/+$/, ""),
  POLL_TIMEOUT_S: 50,
  ALERT_EVERY_MS: 5 * 60 * 1000,
  DEMO_EVERY_MS: Math.max(30, Number(process.env.RINGGUARD_DEMO_MS) || 5 * 60 * 1000),
  ALERT_MIN_LEVEL: 2,          // 0 Baik, 1 Sedang, 2 Tidak sehat, 3 Sangat tidak sehat, 4 Berbahaya
  CONFIRM_N: Math.max(1, Number(process.env.RINGGUARD_CONFIRM_N) || 3),
  EXPECTED_INTERVAL_MS: 5 * 60 * 1000,
  OFFLINE_MS: 20 * 60 * 1000,
  NOISE_LIMIT_DB: 55,
  NOISE_CLEAR_DB: 52,
  GAS_RATIO_HIGH: 1.5,
  GAS_RATIO_CLEAR: 1.25,
  BATT_LOW_V: 3.5,
  BATT_OK_V: 3.7,
  REPORT_COOLDOWN_MS: 5 * 60 * 1000,
  RESIDENT_ALERTS: { pm25: true, noise: false, gas: false },
  ORG_TEXT: "pengelola program pemantauan Ring 1 dan pihak terkait yang ditunjuk"
};

const LEVELS = [
  { name: "Baik", emoji: "🟢", max: 15.5 },
  { name: "Sedang", emoji: "🟡", max: 55.4 },
  { name: "Tidak sehat", emoji: "🟠", max: 150.4 },
  { name: "Sangat tidak sehat", emoji: "🔴", max: 250.4 },
  { name: "Berbahaya", emoji: "🟣", max: Infinity }
];
const ADVICE = [
  "Udara baik. Aktivitas di luar ruangan aman.",
  "Kualitas udara sedang. Kelompok yang sangat sensitif sebaiknya mengurangi aktivitas berat di luar ruangan.",
  "Kelompok sensitif (anak, lansia, ibu hamil, penderita asma atau penyakit jantung) sebaiknya mengurangi aktivitas di luar ruangan. Pakai masker N95/KN95 jika harus keluar.",
  "Sebaiknya semua orang menghindari aktivitas di luar ruangan dan memakai masker N95/KN95 bila terpaksa keluar. Kelompok sensitif tetap di dalam ruangan.",
  "Kondisi berbahaya. Tetap di dalam ruangan, tutup ventilasi dari luar, dan hubungi fasilitas kesehatan bila ada sesak napas."
];
const SYMPTOMS = {
  napas: "Sesak napas atau batuk",
  mata: "Mata atau tenggorokan perih",
  bau: "Bau menyengat",
  bising: "Bising mengganggu",
  debu: "Debu menumpuk di rumah",
  tidur: "Tidur terganggu",
  sehat: "Tidak ada keluhan"
};
const INTENSITY = { 1: "Ringan", 2: "Sedang", 3: "Berat" };

// ---------------------------------------------------------------- utilitas
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (v, d = 0) => (isNum(v) ? v.toFixed(d) : "–");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const TZ = "Asia/Jakarta";
const wib = (ts) => new Date(ts).toLocaleString("id-ID", { timeZone: TZ, hour12: false, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const wibIso = (ts) => new Date(ts + 7 * 3600e3).toISOString().replace("Z", "+07:00");
const pmLevel = (v) => LEVELS.findIndex((l) => v <= l.max);
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const warn = (...a) => console.warn(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- rahasia
function loadSecrets(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const SECRETS = loadSecrets(SECRET_FILE);
const TOKEN = SECRETS.TELEGRAM_TOKEN;
const ADMIN_CODE = SECRETS.ADMIN_CODE || "";
const HASH_SALT = SECRETS.HASH_SALT || "ringguard-local";

if (!TOKEN) {
  console.error(`TELEGRAM_TOKEN tidak ditemukan di ${SECRET_FILE}`);
  process.exit(1);
}
const hashId = (id) => crypto.createHmac("sha256", HASH_SALT).update(String(id)).digest("hex").slice(0, 20);

// ---------------------------------------------------------------- token Google
let tokenCache = { value: null, exp: 0 };
async function accessToken(force = false) {
  if (!force && tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  if (!fs.existsSync(FIREBASE_CFG)) {
    throw new Error("Belum login Firebase CLI. Jalankan: firebase login");
  }
  const cfg = JSON.parse(fs.readFileSync(FIREBASE_CFG, "utf8"));
  const refreshToken = cfg.tokens && cfg.tokens.refresh_token;
  if (!refreshToken) throw new Error("Refresh token Firebase CLI tidak ada. Jalankan: firebase login");

  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error(`Gagal memperbarui token (${r.status}): ${j.error_description || j.error || "tidak diketahui"}`);
  }
  // Kalau Google memutar refresh token, simpan agar sesi berikutnya tetap jalan.
  if (j.refresh_token && j.refresh_token !== refreshToken) {
    try {
      cfg.tokens.refresh_token = j.refresh_token;
      fs.writeFileSync(FIREBASE_CFG, JSON.stringify(cfg, null, 2));
      log("Refresh token Firebase CLI diperbarui.");
    } catch (e) { warn("Gagal menyimpan refresh token:", e.message); }
  }
  tokenCache = { value: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000 };
  return tokenCache.value;
}

// ---------------------------------------------------------------- Realtime Database REST
function dbUrl(p, params) {
  const base = `${CFG.DB_URL}/${String(p).replace(/^\/|\/+$/g, "")}.json`;
  const q = params && params.length ? "?" + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
  return base + q;
}
async function dbFetch(method, p, { params, body, silent = method !== "GET", force = false } = {}) {
  // print=silent hanya untuk tulis: pada GET parameter itu justru mengosongkan respons.
  const url = dbUrl(p, silent ? [...(params || []), ["print", "silent"]] : params);
  const headers = { Authorization: `Bearer ${await accessToken(force)}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 401) {
    headers.Authorization = `Bearer ${await accessToken(true)}`;
    r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`RTDB ${method} ${p} gagal (${r.status}): ${text.slice(0, 200)}`);
  if (!text || text === "null") return null;
  try { return JSON.parse(text); } catch { return null; }
}
const dbGet = (p, params) => dbFetch("GET", p, { params });
const dbSet = (p, v) => dbFetch("PUT", p, { body: v });
const dbPush = (p, v) => dbFetch("POST", p, { body: v, silent: false });
const dbPatch = (p, v) => dbFetch("PATCH", p, { body: v });
const dbDel = (p) => dbFetch("DELETE", p);

// ---------------------------------------------------------------- Telegram
async function tg(method, payload) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error_code: 0, description: e.message };
  }
}
async function dropChat(chatId) {
  await dbPatch("/", { [`subscribers/${chatId}`]: null, [`config/analysts/${chatId}`]: null });
}
async function send(chatId, text, extra = {}, attempt = 0) {
  const j = await tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  if (j.ok) return j;
  if (j.error_code === 403) await dropChat(chatId);
  else if (j.error_code === 429 && attempt < 2) {
    await sleep((((j.parameters || {}).retry_after) || 1) * 1000 + 200);
    return send(chatId, text, extra, attempt + 1);
  } else warn("sendMessage gagal", j.error_code, j.description);
  return j;
}
const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });

// ---------------------------------------------------------------- akses data
const getNodes = async () => (await dbGet("config/nodes")) || {};
const getSub = (chatId) => dbGet(`subscribers/${chatId}`);
const isAnalyst = async (chatId) => !!(await dbGet(`config/analysts/${chatId}`));

async function lastReadings(node, n) {
  const o = (await dbGet(`nodes/${node}/readings`, [["orderBy", '"$key"'], ["limitToLast", String(n)]])) || {};
  return Object.values(o).sort((a, b) => a.ts - b.ts);
}
async function readingsSince(node, since, until = Date.now()) {
  const o = (await dbGet(`nodes/${node}/readings`, [["orderBy", '"ts"'], ["startAt", String(since)], ["endAt", String(until)]])) || {};
  return Object.values(o).sort((a, b) => a.ts - b.ts);
}
const logAlert = (node, type, state, extra = {}) => dbPush("alerts", { ts: Date.now(), node, type, state, ...extra });

// ---------------------------------------------------------------- kirim massal
async function broadcast(ctx, nodeId, text) {
  const ids = Object.entries(ctx.subs).filter(([, v]) => v && v.consentTs && v.nodes && v.nodes[nodeId]).map(([id]) => id);
  for (const id of ids) { await send(id, text); await sleep(60); }
  return ids.length;
}
async function notifyAnalysts(ctx, text) {
  for (const id of ctx.analysts) { await send(id, text); await sleep(60); }
}

// ---------------------------------------------------------------- data sensor contoh
const demoState = new Map();
function demoReading(node, ts) {
  const s = demoState.get(node) || {
    pm25: 12 + Math.random() * 20,
    pm10: 22 + Math.random() * 24,
    temp: 25 + Math.random() * 4,
    hum: 72 + Math.random() * 18,
    noise: 41 + Math.random() * 13,
    gas: 1180 + Math.random() * 320,
    batt: 3.95 + Math.random() * 0.35
  };
  const walk = (v, step, lo, hi) => Math.min(hi, Math.max(lo, v + (Math.random() - 0.5) * step));
  s.pm25 = walk(s.pm25, 3.2, 3, 160);
  s.pm10 = walk(s.pm10, 4, s.pm25 * 1.15, 220);
  s.temp = walk(s.temp, 0.35, 21, 35);
  s.hum = walk(s.hum, 1.6, 45, 99);
  s.noise = walk(s.noise, 2.4, 30, 82);
  s.gas = walk(s.gas, 45, 700, 2400);
  s.batt = walk(s.batt, 0.02, 3.2, 4.25);
  demoState.set(node, s);
  return {
    ts,
    pm1: Math.round(s.pm25 * 0.62 * 10) / 10,
    pm25: Math.round(s.pm25 * 10) / 10,
    pm10: Math.round(s.pm10 * 10) / 10,
    temp: Math.round(s.temp * 10) / 10,
    hum: Math.round(s.hum),
    noise: Math.round(s.noise * 10) / 10,
    gas: Math.round(s.gas),
    batt: Math.round(s.batt * 100) / 100
  };
}

// ID push ala Firebase (agar urutan kunci tetap kronologis saat data contoh diisi sekaligus).
const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
function pushId(ts) {
  let t = ts;
  const time = new Array(8);
  for (let i = 7; i >= 0; i--) { time[i] = PUSH_CHARS[t % 64]; t = Math.floor(t / 64); }
  let id = time.join("");
  for (let i = 0; i < 12; i++) id += PUSH_CHARS[Math.floor(Math.random() * 64)];
  return id;
}

async function seedDemo(hours = 24) {
  const nodes = await getNodes();
  const ids = Object.keys(nodes);
  if (!ids.length) throw new Error("config/nodes kosong. Isi dulu daftar titik pantau.");
  const step = CFG.EXPECTED_INTERVAL_MS;
  const now = Date.now();
  const start = now - hours * 3600e3;
  let total = 0;
  for (const id of ids) {
    const readings = {};
    for (let ts = start; ts <= now; ts += step) readings[pushId(ts)] = demoReading(`${id}:seed`, ts);
    await dbPatch(`nodes/${id}/readings`, readings);
    total += Object.keys(readings).length;
    log(`seed ${id}: ${Object.keys(readings).length} pembacaan`);
  }
  log(`Selesai. ${total} pembacaan contoh untuk ${ids.length} titik.`);
}

// Satu kali kirim data contoh untuk tiap titik yang datanya sudah kedaluwarsa.
async function demoTick() {
  const nodes = await getNodes();
  const now = Date.now();
  for (const id of Object.keys(nodes)) {
    try {
      const last = (await lastReadings(id, 1))[0];
      if (last && now - last.ts < CFG.DEMO_EVERY_MS * 0.8) continue; // data asli masih segar, jangan timpa
      await dbPush(`nodes/${id}/readings`, demoReading(id, now));
      log(`data contoh terkirim: ${id}`);
    } catch (e) {
      warn("demoTick", id, e.message);
    }
  }
}

// ---------------------------------------------------------------- mesin peringatan
async function evaluateNode(nodeId, info, ctx) {
  const name = (info && info.name) || nodeId;
  const rs = await lastReadings(nodeId, 288);
  const last = rs[rs.length - 1];
  const st = (await dbGet(`nodeState/${nodeId}`)) || {};
  const upd = {};
  const now = Date.now();
  const toResidents = (type, text) => (CFG.RESIDENT_ALERTS[type] ? broadcast(ctx, nodeId, text) : null);

  const offline = !last || now - last.ts > CFG.OFFLINE_MS;
  if (offline && !st.offline) {
    upd.offline = true;
    await logAlert(nodeId, "offline", "raise");
    await notifyAnalysts(ctx, `⚠️ <b>${esc(name)}</b> tidak mengirim data${last ? ` sejak ${wib(last.ts)}` : ""}. Periksa daya, WiFi, atau sensor.`);
  } else if (!offline && st.offline) {
    upd.offline = false;
    await logAlert(nodeId, "offline", "clear");
    await notifyAnalysts(ctx, `✅ <b>${esc(name)}</b> kembali mengirim data.`);
  }
  if (offline) {
    if (Object.keys(upd).length) await dbPatch(`nodeState/${nodeId}`, upd);
    return;
  }

  const recent = rs.slice(-CFG.CONFIRM_N);
  const series = (k) => recent.map((r) => r[k]).filter(isNum);

  const pm = series("pm25");
  if (pm.length === CFG.CONFIRM_N) {
    const cur = st.pmLevel || 0;
    const up = pmLevel(Math.min(...pm)), down = pmLevel(Math.max(...pm));
    let next = cur;
    if (up > cur) next = up; else if (down < cur) next = down;
    if (next !== cur) {
      upd.pmLevel = next;
      const L = LEVELS[next];
      if (next > cur && next >= CFG.ALERT_MIN_LEVEL) {
        await logAlert(nodeId, "pm25", "raise", { level: next, value: last.pm25 });
        await toResidents("pm25",
          `${L.emoji} <b>Kualitas udara: ${L.name}</b>\nTitik: ${esc(name)}\nPM2.5: <b>${fmt(last.pm25)}</b> µg/m³ (PM10 ${fmt(last.pm10)})\nWaktu: ${wib(last.ts)} WIB\n\n${ADVICE[next]}\n\nLaporkan keluhan Anda dengan /lapor. Data sensor bersifat indikatif.`);
      } else if (cur >= CFG.ALERT_MIN_LEVEL && next < CFG.ALERT_MIN_LEVEL) {
        await logAlert(nodeId, "pm25", "clear", { level: next, value: last.pm25 });
        await toResidents("pm25", `✅ Kualitas udara di ${esc(name)} membaik: ${L.name} (PM2.5 ${fmt(last.pm25)} µg/m³).`);
      }
    }
  }

  const nz = series("noise");
  if (nz.length === CFG.CONFIRM_N) {
    if (!st.noiseHigh && Math.min(...nz) > CFG.NOISE_LIMIT_DB) {
      upd.noiseHigh = true;
      await logAlert(nodeId, "noise", "raise", { value: last.noise });
      await toResidents("noise", `🔊 <b>Kebisingan tinggi</b> di ${esc(name)}: sekitar ${fmt(last.noise)} dB (batas ${CFG.NOISE_LIMIT_DB} dB).\nLaporkan dampaknya dengan /lapor.`);
    } else if (st.noiseHigh && Math.max(...nz) < CFG.NOISE_CLEAR_DB) {
      upd.noiseHigh = false;
      await logAlert(nodeId, "noise", "clear", { value: last.noise });
    }
  }

  const gasAll = rs.map((r) => r.gas).filter(isNum);
  const gz = series("gas");
  if (gasAll.length >= 100 && gz.length === CFG.CONFIRM_N) {
    const base = median(gasAll);
    if (base > 0) {
      if (!st.gasHigh && Math.min(...gz) / base > CFG.GAS_RATIO_HIGH) {
        upd.gasHigh = true;
        await logAlert(nodeId, "gas", "raise", { value: last.gas, ratio: +(last.gas / base).toFixed(2) });
        await toResidents("gas", `🧪 <b>Indeks gas naik</b> di ${esc(name)} (${(last.gas / base).toFixed(1)}x dari biasanya). Jika tercium bau menyengat, laporkan dengan /lapor.`);
      } else if (st.gasHigh && Math.max(...gz) / base < CFG.GAS_RATIO_CLEAR) {
        upd.gasHigh = false;
        await logAlert(nodeId, "gas", "clear", { value: last.gas });
      }
    }
  }

  const bz = series("batt");
  if (bz.length === CFG.CONFIRM_N) {
    if (!st.battLow && Math.max(...bz) < CFG.BATT_LOW_V) {
      upd.battLow = true;
      await logAlert(nodeId, "battery", "raise", { value: last.batt });
      await notifyAnalysts(ctx, `🔋 Baterai <b>${esc(name)}</b> rendah: ${fmt(last.batt, 2)} V. Periksa panel surya dan charger.`);
    } else if (st.battLow && Math.min(...bz) > CFG.BATT_OK_V) {
      upd.battLow = false;
      await logAlert(nodeId, "battery", "clear", { value: last.batt });
    }
  }

  if (Object.keys(upd).length) await dbPatch(`nodeState/${nodeId}`, upd);
}

async function evaluateAll() {
  const nodes = await getNodes();
  const ctx = {
    subs: (await dbGet("subscribers")) || {},
    analysts: Object.keys((await dbGet("config/analysts")) || {})
  };
  for (const [id, info] of Object.entries(nodes)) {
    try { await evaluateNode(id, info || {}, ctx); }
    catch (e) { warn("evaluateNode", id, e.message); }
  }
}

// ---------------------------------------------------------------- ringkasan
async function buildSummary(hours = 24) {
  const since = Date.now() - hours * 3600e3;
  const nodes = await getNodes();
  const reports = Object.values((await dbGet("reports", [["orderBy", '"ts"'], ["startAt", String(since)]])) || {});
  const alerts = Object.values((await dbGet("alerts", [["orderBy", '"ts"'], ["startAt", String(since)]])) || {});
  const parts = [];
  for (const [id, info] of Object.entries(nodes)) {
    const name = (info && info.name) || id;
    const rs = await readingsSince(id, since);
    const expected = (hours * 3600e3) / CFG.EXPECTED_INTERVAL_MS;
    let t = `📍 <b>${esc(name)}</b>\nKelengkapan data: ${Math.min(100, Math.round((rs.length / expected) * 100))}% (${rs.length} pembacaan)`;
    const pm = rs.map((r) => r.pm25).filter(isNum);
    if (pm.length) {
      const share = LEVELS.map((L, i) => [L, pm.filter((v) => pmLevel(v) === i).length])
        .filter(([, n]) => n > 0).map(([L, n]) => `${L.name} ${Math.round((n / pm.length) * 100)}%`).join(", ");
      t += `\nPM2.5 rata-rata ${fmt(mean(pm), 1)}, tertinggi ${fmt(Math.max(...pm))} µg/m³\nSebaran kategori: ${share}`;
    } else t += "\nBelum ada data PM2.5.";
    const nz = rs.map((r) => r.noise).filter(isNum);
    if (nz.length) t += `\nKebisingan rata-rata ${fmt(mean(nz))} dB, di atas ${CFG.NOISE_LIMIT_DB} dB: ${Math.round((nz.filter((v) => v > CFG.NOISE_LIMIT_DB).length / nz.length) * 100)}%`;
    const rep = reports.filter((r) => r.node === id);
    if (rep.length) {
      const by = Object.entries(SYMPTOMS).map(([k, label]) => [label, rep.filter((r) => r.type === k).length]).filter(([, n]) => n > 0);
      t += `\nLaporan warga: ${rep.length} (${by.map(([l, n]) => `${l} ${n}`).join(", ")})`;
    } else t += "\nLaporan warga: 0";
    const al = alerts.filter((a) => a.node === id && a.state === "raise");
    if (al.length) t += `\nPeringatan terpicu: ${al.length} (${["pm25", "noise", "gas", "offline", "battery"].map((k) => [k, al.filter((a) => a.type === k).length]).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ")})`;
    parts.push(t);
  }
  if (!parts.length) parts.push("Belum ada titik pantau terdaftar.");
  return [`📊 <b>Ringkasan ${hours} jam terakhir</b>`, ...parts];
}
async function sendChunks(chatId, parts) {
  let buf = "";
  for (const p of parts) {
    if ((buf + "\n\n" + p).length > 3800) { await send(chatId, buf); buf = p; }
    else buf = buf ? buf + "\n\n" + p : p;
  }
  if (buf) await send(chatId, buf);
}

// ---------------------------------------------------------------- perintah bot
function levelLine(r) {
  const L = LEVELS[pmLevel(r.pm25 == null ? 0 : r.pm25)];
  return `${L.emoji} ${L.name}`;
}
const needConsent = (chatId) => send(chatId, "Anda perlu menyetujui penggunaan data dulu. Ketik /start.");

async function cmdStart(chatId) {
  const sub = await getSub(chatId);
  if (sub && sub.consentTs) return send(chatId, "Selamat datang kembali. Ketik /status untuk kondisi terkini, /titik untuk memilih lokasi, atau /bantuan.");
  return send(chatId,
    `<b>Pantau Udara Ring 1</b>\nBot ini mengirim peringatan kualitas udara dari sensor di sekitar Anda dan menerima laporan keluhan warga.\n\n` +
    `<b>Data yang disimpan</b>\n• ID chat Telegram Anda, hanya untuk mengirim peringatan\n• Laporan keluhan Anda, disimpan tanpa nama dan tanpa nomor telepon (hanya kode acak), dan dipakai ${CFG.ORG_TEXT} untuk menganalisis dampak lingkungan\n\n` +
    `Anda bisa berhenti kapan saja dengan /berhenti dan menghapus laporan Anda dengan /hapusdata. Data sensor berasal dari alat berbiaya rendah dan bersifat indikatif.`,
    kb([[{ text: "Setuju dan lanjut", callback_data: "consent:yes" }, { text: "Tidak", callback_data: "consent:no" }]]));
}
async function cmdNodes(chatId) {
  const sub = await getSub(chatId);
  if (!sub || !sub.consentTs) return needConsent(chatId);
  const nodes = await getNodes();
  const mine = sub.nodes || {};
  const rows = Object.entries(nodes).map(([id, n]) => [{
    text: `${mine[id] ? "✅" : "➕"} ${(n && n.name) || id}`,
    callback_data: `${mine[id] ? "unsub" : "sub"}:${id}`
  }]);
  if (!rows.length) return send(chatId, "Belum ada titik pantau yang terdaftar.");
  return send(chatId, "Pilih titik pantau yang ingin Anda ikuti (tekan lagi untuk berhenti):", kb(rows));
}
async function cmdStatus(chatId) {
  const sub = await getSub(chatId);
  if (!sub || !sub.consentTs) return needConsent(chatId);
  const nodes = await getNodes();
  const ids = Object.keys(sub.nodes || {}).filter((id) => nodes[id]);
  if (!ids.length) return send(chatId, "Anda belum memilih titik pantau. Ketik /titik.");
  for (const id of ids) {
    const r = (await lastReadings(id, 1))[0];
    const name = (nodes[id] && nodes[id].name) || id;
    if (!r) { await send(chatId, `📍 <b>${esc(name)}</b>\nBelum ada data.`); continue; }
    const ageMin = Math.round((Date.now() - r.ts) / 60000);
    await send(chatId,
      `📍 <b>${esc(name)}</b>\n${levelLine(r)}\nPM2.5 <b>${fmt(r.pm25)}</b> · PM10 ${fmt(r.pm10)} µg/m³\nSuhu ${fmt(r.temp, 1)} °C · Lembap ${fmt(r.hum)}%\nKebisingan sekitar ${fmt(r.noise)} dB (perkiraan)\n` +
      `Diperbarui ${wib(r.ts)} WIB${ageMin > 30 ? "\n⚠️ Data sudah lama, alat mungkin sedang bermasalah." : ""}`);
  }
}
async function askSymptom(chatId, node) {
  const rows = Object.entries(SYMPTOMS).map(([k, label]) => [{ text: label, callback_data: `sym:${node}:${k}` }]);
  return send(chatId, "Apa yang Anda rasakan saat ini?", kb(rows));
}
async function askIntensity(chatId, node, type) {
  const rows = [Object.entries(INTENSITY).map(([n, label]) => ({ text: label, callback_data: `int:${node}:${type}:${n}` }))];
  return send(chatId, `<b>${SYMPTOMS[type]}</b>. Seberapa parah?`, kb(rows));
}
async function cmdLapor(chatId) {
  const sub = await getSub(chatId);
  if (!sub || !sub.consentTs) return needConsent(chatId);
  const nodes = await getNodes();
  const ids = Object.keys(sub.nodes || {}).filter((id) => nodes[id]);
  if (!ids.length) return send(chatId, "Pilih titik pantau dulu dengan /titik.");
  if (ids.length === 1) return askSymptom(chatId, ids[0]);
  return send(chatId, "Keluhan ini di dekat titik yang mana?", kb(ids.map((id) => [{ text: (nodes[id] && nodes[id].name) || id, callback_data: `rep:${id}` }])));
}
async function saveReport(chatId, node, type, intensity) {
  const sub = await getSub(chatId);
  if (!sub || !sub.consentTs) return needConsent(chatId);
  if (!(await getNodes())[node] || !SYMPTOMS[type] || ![0, 1, 2, 3].includes(intensity)) return;
  const uid = hashId(chatId);
  const lastTs = (await dbGet(`rateLimits/reports/${uid}`)) || 0;
  if (Date.now() - lastTs < CFG.REPORT_COOLDOWN_MS) return send(chatId, "Laporan Anda baru saja diterima. Coba lagi beberapa menit lagi.");
  const r = (await lastReadings(node, 1))[0];
  await dbPush("reports", {
    uid, node, type, intensity, ts: Date.now(),
    snap: r ? { readingTs: r.ts, pm25: r.pm25, pm10: r.pm10, noise: r.noise, gas: r.gas, temp: r.temp, hum: r.hum } : null
  });
  await dbSet(`rateLimits/reports/${uid}`, Date.now());
  return send(chatId, `Terima kasih, laporan Anda tercatat.${r ? `\nKondisi sensor saat ini: ${levelLine(r)} (PM2.5 ${fmt(r.pm25)} µg/m³).` : ""}\nJika gejala berat atau berlanjut, segera hubungi fasilitas kesehatan.`);
}
async function cmdStop(chatId) {
  await dbDel(`subscribers/${chatId}`);
  return send(chatId, "Anda berhenti berlangganan dan ID chat Anda sudah dihapus dari daftar. Laporan lama tetap tersimpan tanpa identitas; hapus dengan /hapusdata. Ketik /start untuk bergabung lagi.");
}
async function cmdDeleteData(chatId) {
  const uid = hashId(chatId);
  const found = (await dbGet("reports", [["orderBy", '"uid"'], ["equalTo", JSON.stringify(uid)]])) || {};
  const updates = { [`rateLimits/reports/${uid}`]: null };
  let n = 0;
  for (const key of Object.keys(found)) { updates[`reports/${key}`] = null; n++; }
  await dbPatch("/", updates);
  return send(chatId, `${n} laporan Anda sudah dihapus.`);
}
async function cmdAnalyst(chatId, code, msgId) {
  if (msgId) await tg("deleteMessage", { chat_id: chatId, message_id: msgId });
  const key = `rateLimits/admin/${hashId(chatId)}`;
  const a = (await dbGet(key)) || { n: 0, ts: 0 };
  if (Date.now() - a.ts > 3600e3) a.n = 0;
  if (a.n >= 5) return send(chatId, "Terlalu banyak percobaan. Coba lagi nanti.");
  if (!code || !ADMIN_CODE || !safeEqual(code, ADMIN_CODE)) {
    await dbSet(key, { n: a.n + 1, ts: Date.now() });
    return send(chatId, "Kode salah.");
  }
  await dbSet(`config/analysts/${chatId}`, true);
  return send(chatId, "Anda terdaftar sebagai analis. Anda akan menerima ringkasan harian pukul 07:00 WIB dan status alat. Ketik /ringkasan untuk ringkasan sekarang.");
}
async function cmdSummary(chatId) {
  if (!(await isAnalyst(chatId))) return send(chatId, "Perintah ini khusus analis.");
  return sendChunks(chatId, await buildSummary(24));
}
const cmdHelp = (chatId) => send(chatId,
  "<b>Perintah</b>\n/status kondisi terkini\n/titik pilih lokasi yang diikuti\n/lapor laporkan keluhan\n/berhenti berhenti berlangganan\n/hapusdata hapus laporan Anda\n/bantuan menu ini");

async function onMessage(m) {
  if (!m.chat || m.chat.type !== "private" || !m.text) return;
  const chatId = m.chat.id;
  const [raw, ...args] = m.text.trim().split(/\s+/);
  const cmd = raw.toLowerCase().replace(/@.*$/, "");
  log("pesan", chatId, cmd);
  switch (cmd) {
    case "/start": return cmdStart(chatId);
    case "/titik": return cmdNodes(chatId);
    case "/status": return cmdStatus(chatId);
    case "/lapor": return cmdLapor(chatId);
    case "/berhenti": return cmdStop(chatId);
    case "/hapusdata": return cmdDeleteData(chatId);
    case "/analis": return cmdAnalyst(chatId, args[0], m.message_id);
    case "/ringkasan": return cmdSummary(chatId);
    case "/bantuan": case "/help": return cmdHelp(chatId);
    default: return send(chatId, "Perintah tidak dikenal. Ketik /bantuan.");
  }
}
async function onCallback(q) {
  const chatId = q.message && q.message.chat && q.message.chat.id;
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  if (!chatId || q.message.chat.type !== "private") return;
  const [act, a, b, c] = String(q.data || "").split(":");
  log("tombol", chatId, act, a || "");
  switch (act) {
    case "consent":
      if (a === "yes") {
        await dbPatch(`subscribers/${chatId}`, { consentTs: Date.now() });
        return cmdNodes(chatId);
      }
      return send(chatId, "Baik, tidak ada data Anda yang disimpan. Ketik /start jika berubah pikiran.");
    case "sub": case "unsub": {
      const sub = await getSub(chatId);
      if (!sub || !sub.consentTs) return needConsent(chatId);
      if (!(await getNodes())[a]) return;
      await dbSet(`subscribers/${chatId}/nodes/${a}`, act === "sub" ? true : null);
      return cmdNodes(chatId);
    }
    case "rep": return askSymptom(chatId, a);
    case "sym":
      if (!SYMPTOMS[b]) return;
      return b === "sehat" ? saveReport(chatId, a, b, 0) : askIntensity(chatId, a, b);
    case "int": return saveReport(chatId, a, b, Number(c));
    default: return;
  }
}

// ---------------------------------------------------------------- loop
let stopping = false;
async function pollLoop() {
  let offset = 0;
  while (!stopping) {
    let j;
    try {
      j = await tg("getUpdates", { offset, timeout: CFG.POLL_TIMEOUT_S, allowed_updates: ["message", "callback_query"] });
    } catch (e) {
      warn("getUpdates", e.message);
      await sleep(3000);
      continue;
    }
    if (!j.ok) {
      if (j.error_code === 409) {
        warn("Konflik 409: webhook masih aktif. Menghapus webhook...");
        await tg("deleteWebhook", { drop_pending_updates: false });
        await sleep(2000);
        continue;
      }
      if (j.error_code === 401) {
        warn("Token bot ditolak Telegram. Periksa TELEGRAM_TOKEN di functions/.secret.local.");
        process.exit(1);
      }
      warn("getUpdates gagal", j.error_code, j.description);
      await sleep(3000);
      continue;
    }
    for (const u of j.result || []) {
      offset = u.update_id + 1;
      try {
        if (u.message) await onMessage(u.message);
        else if (u.callback_query) await onCallback(u.callback_query);
      } catch (e) {
        warn("handler", e.message);
      }
    }
  }
}

function msUntilNextWib(hour) {
  const now = Date.now();
  const wibNow = new Date(now + 7 * 3600e3);
  const target = Date.UTC(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate(), hour, 0, 0) - 7 * 3600e3;
  return (target > now ? target : target + 86400e3) - now;
}
function scheduleDaily() {
  const wait = msUntilNextWib(7);
  log(`Ringkasan harian berikutnya dalam ${Math.round(wait / 60000)} menit.`);
  const t = setTimeout(async () => {
    try {
      const analysts = Object.keys((await dbGet("config/analysts")) || {});
      if (analysts.length) {
        const parts = await buildSummary(24);
        for (const id of analysts) { await sendChunks(id, parts); await sleep(60); }
      }
    } catch (e) { warn("ringkasan harian", e.message); }
    scheduleDaily();
  }, wait);
  if (t.unref) t.unref();
}

async function main() {
  if (ARGS.has("--help") || ARGS.has("-h")) {
    console.log(`RingGuard local bot

  node bot/local-bot.js          jalankan bot (long polling)
  node bot/local-bot.js --demo   bot + kirim data sensor contoh tiap 5 menit
  node bot/local-bot.js --seed   isi 24 jam data contoh lalu keluar

Variabel lingkungan:
  RINGGUARD_DB_URL        ganti URL database
  RINGGUARD_DEMO=1        sama dengan --demo
  RINGGUARD_DEMO_MS       jeda data contoh (default 300000)
  RINGGUARD_CONFIRM_N     jumlah pembacaan sebelum peringatan (default 3)
`);
    return;
  }

  console.log("==============================================");
  console.log(" RINGGUARD - bot Telegram mode lokal");
  console.log("==============================================");
  log("Database :", CFG.DB_URL);
  log("Mode     :", SEED ? "seed data contoh" : DEMO ? "demo (data contoh berkala)" : "normal");

  await accessToken();
  log("Token Firebase CLI: OK");

  if (SEED) {
    await seedDemo(24);
    process.exit(0);
  }

  // Webhook harus kosong agar getUpdates bisa dipakai.
  const wh = await tg("getWebhookInfo", {});
  if (wh.ok && wh.result && wh.result.url) {
    log("Menghapus webhook lama:", wh.result.url);
    await tg("deleteWebhook", { drop_pending_updates: false });
  }
  const me = await tg("getMe", {});
  if (!me.ok) {
    console.error("Token bot tidak valid:", me.description);
    process.exit(1);
  }
  log(`Bot: @${me.result.username}`);

  if (DEMO) {
    await demoTick();
    setInterval(() => demoTick().catch((e) => warn("demoTick", e.message)), CFG.DEMO_EVERY_MS);
  }

  setTimeout(() => evaluateAll().catch((e) => warn("evaluateAll", e.message)), 5000);
  setInterval(() => evaluateAll().catch((e) => warn("evaluateAll", e.message)), CFG.ALERT_EVERY_MS);
  scheduleDaily();

  log("Menunggu pesan Telegram... (Ctrl+C untuk berhenti)");
  await pollLoop();
}

process.on("SIGINT", () => {
  stopping = true;
  log("Berhenti.");
  setTimeout(() => process.exit(0), 300);
});
process.on("unhandledRejection", (e) => warn("unhandledRejection", e && e.message ? e.message : e));

main().catch((e) => {
  console.error("Gagal menjalankan bot:", e.message);
  process.exit(1);
});
