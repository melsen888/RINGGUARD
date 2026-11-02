"use strict";
/*
  Ring 1 - penjaga data dan bot Telegram
  Fungsi:
    ingest           ESP32 -> validasi -> database (kunci API, stempel waktu dari server)
    alertCheck       tiap 5 menit: cek ambang batas, kirim peringatan ke warga, status alat ke analis
    dailySummary     07:00 WIB: ringkasan 24 jam ke analis
    telegramWebhook  bot: /start /titik /status /lapor /berhenti /hapusdata /analis /ringkasan
    telegramSetup    daftarkan webhook bot ke Telegram (sekali, dengan kunci EXPORT_KEY)
    exportCsv        unduh data (mentah atau per jam), laporan warga, log peringatan
  Untuk pindah ke WhatsApp, ganti isi send() dan broadcast() saja.
*/
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp(process.env.DATABASE_URL ? { databaseURL: process.env.DATABASE_URL } : undefined);
const db = admin.database();

const REGION = "asia-southeast1";
const TZ = "Asia/Jakarta";

// Rahasia: isi lewat `firebase functions:secrets:set NAMA`. JANGAN taruh token di kode.
const TELEGRAM_TOKEN = defineSecret("TELEGRAM_TOKEN");
const WEBHOOK_SECRET = defineSecret("WEBHOOK_SECRET");
const INGEST_KEY = defineSecret("INGEST_KEY");
const ADMIN_CODE = defineSecret("ADMIN_CODE");
const EXPORT_KEY = defineSecret("EXPORT_KEY");
const HASH_SALT = defineSecret("HASH_SALT");

// ---------------------------------------------------------------- konfigurasi
const CFG = {
  ALERT_MIN_LEVEL: 2,            // 0 Baik, 1 Sedang, 2 Tidak sehat, 3 Sangat tidak sehat, 4 Berbahaya
  CONFIRM_N: 3,                  // jumlah pembacaan berturut-turut untuk memicu/menutup peringatan
  EXPECTED_INTERVAL_MS: 5 * 60 * 1000, // samakan dengan INTERVAL_MS di firmware
  OFFLINE_MS: 20 * 60 * 1000,
  NOISE_LIMIT_DB: 55,            // sesuaikan dengan baku mutu yang Anda pakai
  NOISE_CLEAR_DB: 52,
  GAS_RATIO_HIGH: 1.5,           // gas dibanding median 24 jam terakhir (indeks relatif)
  GAS_RATIO_CLEAR: 1.25,
  BATT_LOW_V: 3.5,
  BATT_OK_V: 3.7,
  REPORT_COOLDOWN_MS: 5 * 60 * 1000,
  // Peringatan ke warga. Kebisingan dan gas dimatikan sampai sensor dikalibrasi.
  RESIDENT_ALERTS: { pm25: true, noise: false, gas: false },
  // Teks persetujuan: ganti dengan nama pengelola yang sebenarnya.
  ORG_TEXT: "pengelola program pemantauan Ring 1 dan pihak terkait yang ditunjuk"
};

const LEVELS = [
  { name: "Baik", emoji: "🟢", max: 15.5 },
  { name: "Sedang", emoji: "🟡", max: 55.4 },
  { name: "Tidak sehat", emoji: "🟠", max: 150.4 },
  { name: "Sangat tidak sehat", emoji: "🔴", max: 250.4 },
  { name: "Berbahaya", emoji: "🟣", max: Infinity }
]; // rentang PM2.5 (µg/m³) mengikuti ISPU; verifikasi ke aturan resmi sebelum dipakai
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
const RANGES = { pm1: [0, 2000], pm25: [0, 2000], pm10: [0, 3000], temp: [-20, 80], hum: [0, 100], gas: [0, 4095], noise: [0, 140], batt: [2.5, 5.5] };

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
const wib = (ts) => new Date(ts).toLocaleString("id-ID", { timeZone: TZ, hour12: false, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const wibIso = (ts) => new Date(ts + 7 * 3600e3).toISOString().replace("Z", "+07:00");
const pmLevel = (v) => LEVELS.findIndex((l) => v <= l.max);
const hashId = (id) => crypto.createHmac("sha256", HASH_SALT.value()).update(String(id)).digest("hex").slice(0, 20);
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// ---------------------------------------------------------------- akses data
async function getNodes() { return (await db.ref("config/nodes").get()).val() || {}; }
async function getSub(chatId) { return (await db.ref(`subscribers/${chatId}`).get()).val(); }
async function lastReadings(node, n) {
  const o = (await db.ref(`nodes/${node}/readings`).orderByKey().limitToLast(n).get()).val() || {};
  return Object.values(o).sort((a, b) => a.ts - b.ts);
}
async function readingsSince(node, since, until = Date.now()) {
  const o = (await db.ref(`nodes/${node}/readings`).orderByChild("ts").startAt(since).endAt(until).get()).val() || {};
  return Object.values(o).sort((a, b) => a.ts - b.ts);
}
const logAlert = (node, type, state, extra = {}) => db.ref("alerts").push({ ts: Date.now(), node, type, state, ...extra });

// ---------------------------------------------------------------- Telegram
async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN.value()}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  return r.json().catch(() => ({ ok: false, error_code: 0, description: "respons bukan JSON" }));
}
async function dropChat(chatId) {
  await db.ref().update({ [`subscribers/${chatId}`]: null, [`config/analysts/${chatId}`]: null });
}
async function send(chatId, text, extra = {}, attempt = 0) {
  const j = await tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  if (j.ok) return j;
  if (j.error_code === 403) await dropChat(chatId); // bot diblokir atau akun nonaktif
  else if (j.error_code === 429 && attempt < 2) {
    await sleep((((j.parameters || {}).retry_after) || 1) * 1000 + 200);
    return send(chatId, text, extra, attempt + 1);
  } else logger.warn("sendMessage gagal", j.error_code, j.description);
  return j;
}
const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });

async function broadcast(ctx, nodeId, text) {
  const ids = Object.entries(ctx.subs).filter(([, v]) => v && v.consentTs && v.nodes && v.nodes[nodeId]).map(([id]) => id);
  for (const id of ids) { await send(id, text); await sleep(60); } // batas Telegram sekitar 30 pesan/detik
  return ids.length;
}
async function notifyAnalysts(ctx, text) {
  for (const id of ctx.analysts) { await send(id, text); await sleep(60); }
}

// ---------------------------------------------------------------- 1) ingest dari ESP32
exports.ingest = onRequest({ region: REGION, secrets: [INGEST_KEY], maxInstances: 5 }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "metode harus POST" });
  if (!safeEqual(req.get("x-api-key") || "", INGEST_KEY.value())) return res.status(401).json({ error: "kunci salah" });
  const node = String(req.query.node || "");
  if (!/^[a-z0-9-]{3,32}$/.test(node)) return res.status(400).json({ error: "id titik tidak valid" });
  if (!(await getNodes())[node]) return res.status(404).json({ error: "titik belum terdaftar di config/nodes" });
  const b = req.body || {};
  const rec = { ts: Date.now() }; // waktu dari server, bukan dari alat
  for (const [k, [lo, hi]] of Object.entries(RANGES)) rec[k] = isNum(b[k]) && b[k] >= lo && b[k] <= hi ? b[k] : null;
  await db.ref(`nodes/${node}/readings`).push(rec);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- 2) peringatan otomatis
async function evaluateNode(nodeId, info, ctx) {
  const name = info.name || nodeId;
  const rs = await lastReadings(nodeId, 288);
  const last = rs[rs.length - 1];
  const stRef = db.ref(`nodeState/${nodeId}`);
  const st = (await stRef.get()).val() || {};
  const upd = {};
  const now = Date.now();
  const toResidents = (type, text) => (CFG.RESIDENT_ALERTS[type] ? broadcast(ctx, nodeId, text) : null);

  // Alat mati / tidak mengirim
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
  if (offline) { if (Object.keys(upd).length) await stRef.update(upd); return; }

  const recent = rs.slice(-CFG.CONFIRM_N);
  const series = (k) => recent.map((r) => r[k]).filter(isNum);

  // PM2.5: pemicu = nilai TERENDAH dari N pembacaan terakhir, penutup = nilai TERTINGGI (hindari bolak-balik)
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

  // Kebisingan (perkiraan, perlu kalibrasi)
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

  // Gas: bandingkan dengan median 24 jam terakhir (indeks relatif, bukan ppm)
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

  // Baterai (khusus analis)
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

  if (Object.keys(upd).length) await stRef.update(upd);
}

exports.alertCheck = onSchedule(
  { schedule: "every 5 minutes", timeZone: TZ, region: REGION, timeoutSeconds: 300, secrets: [TELEGRAM_TOKEN] },
  async () => {
    const nodes = await getNodes();
    const ctx = {
      subs: (await db.ref("subscribers").get()).val() || {},
      analysts: Object.keys((await db.ref("config/analysts").get()).val() || {})
    };
    for (const [id, info] of Object.entries(nodes)) {
      try { await evaluateNode(id, info || {}, ctx); } catch (e) { logger.error("evaluateNode", id, e); }
    }
  }
);

// ---------------------------------------------------------------- 3) ringkasan
async function buildSummary(hours = 24) {
  const since = Date.now() - hours * 3600e3;
  const nodes = await getNodes();
  const reports = Object.values((await db.ref("reports").orderByChild("ts").startAt(since).get()).val() || {});
  const alerts = Object.values((await db.ref("alerts").orderByChild("ts").startAt(since).get()).val() || {});
  const parts = [];
  for (const [id, info] of Object.entries(nodes)) {
    const name = (info && info.name) || id;
    const rs = await readingsSince(id, since);
    const expected = (hours * 3600e3) / CFG.EXPECTED_INTERVAL_MS;
    let t = `📍 <b>${esc(name)}</b>\nKelengkapan data: ${Math.round((rs.length / expected) * 100)}% (${rs.length} pembacaan)`;
    const pm = rs.map((r) => r.pm25).filter(isNum);
    if (pm.length) {
      const share = LEVELS.map((L, i) => [L, pm.filter((v) => pmLevel(v) === i).length])
        .filter(([, n]) => n > 0).map(([L, n]) => `${L.name} ${Math.round((n / pm.length) * 100)}%`).join(", ");
      t += `\nPM2.5 rata-rata ${fmt(mean(pm), 1)}, tertinggi ${fmt(Math.max(...pm))} µg/m³\nSebaran kategori: ${share}`;
    }
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
  return [`📊 <b>Ringkasan ${hours} jam terakhir</b>`, ...parts];
}
async function sendChunks(chatId, parts) {
  let buf = "";
  for (const p of parts) {
    if ((buf + "\n\n" + p).length > 3800) { await send(chatId, buf); buf = p; } else buf = buf ? buf + "\n\n" + p : p;
  }
  if (buf) await send(chatId, buf);
}
exports.dailySummary = onSchedule(
  { schedule: "0 7 * * *", timeZone: TZ, region: REGION, timeoutSeconds: 300, secrets: [TELEGRAM_TOKEN] },
  async () => {
    const analysts = Object.keys((await db.ref("config/analysts").get()).val() || {});
    if (!analysts.length) return;
    const parts = await buildSummary(24);
    for (const id of analysts) { await sendChunks(id, parts); await sleep(60); }
  }
);

// ---------------------------------------------------------------- 4) bot Telegram
function levelLine(r) {
  const L = LEVELS[pmLevel(r.pm25 == null ? 0 : r.pm25)];
  return `${L.emoji} ${L.name}`;
}
async function needConsent(chatId) {
  return send(chatId, "Anda perlu menyetujui penggunaan data dulu. Ketik /start.");
}
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
    const name = nodes[id].name || id;
    if (!r) { await send(chatId, `📍 <b>${esc(name)}</b>\nBelum ada data.`); continue; }
    const ageMin = Math.round((Date.now() - r.ts) / 60000);
    await send(chatId,
      `📍 <b>${esc(name)}</b>\n${levelLine(r)}\nPM2.5 <b>${fmt(r.pm25)}</b> · PM10 ${fmt(r.pm10)} µg/m³\nSuhu ${fmt(r.temp, 1)} °C · Lembap ${fmt(r.hum)}%\nKebisingan sekitar ${fmt(r.noise)} dB (perkiraan)\n` +
      `Diperbarui ${wib(r.ts)} WIB${ageMin > 30 ? "\n⚠️ Data sudah lama, alat mungkin sedang bermasalah." : ""}`);
  }
}
async function cmdLapor(chatId) {
  const sub = await getSub(chatId);
  if (!sub || !sub.consentTs) return needConsent(chatId);
  const nodes = await getNodes();
  const ids = Object.keys(sub.nodes || {}).filter((id) => nodes[id]);
  if (!ids.length) return send(chatId, "Pilih titik pantau dulu dengan /titik.");
  if (ids.length === 1) return askSymptom(chatId, ids[0]);
  return send(chatId, "Keluhan ini di dekat titik yang mana?", kb(ids.map((id) => [{ text: nodes[id].name || id, callback_data: `rep:${id}` }])));
}
async function askSymptom(chatId, node) {
  const rows = Object.entries(SYMPTOMS).map(([k, label]) => [{ text: label, callback_data: `sym:${node}:${k}` }]);
  return send(chatId, "Apa yang Anda rasakan saat ini?", kb(rows));
}
async function askIntensity(chatId, node, type) {
  const rows = [Object.entries(INTENSITY).map(([n, label]) => ({ text: label, callback_data: `int:${node}:${type}:${n}` }))];
  return send(chatId, `<b>${SYMPTOMS[type]}</b>. Seberapa parah?`, kb(rows));
}
async function saveReport(chatId, node, type, intensity) {
  const sub = await getSub(chatId);
  if (!sub || !sub.consentTs) return needConsent(chatId);
  if (!(await getNodes())[node] || !SYMPTOMS[type] || ![0, 1, 2, 3].includes(intensity)) return;
  const uid = hashId(chatId);
  const rl = db.ref(`rateLimits/reports/${uid}`);
  const lastTs = (await rl.get()).val() || 0;
  if (Date.now() - lastTs < CFG.REPORT_COOLDOWN_MS) return send(chatId, "Laporan Anda baru saja diterima. Coba lagi beberapa menit lagi.");
  const r = (await lastReadings(node, 1))[0];
  await db.ref("reports").push({
    uid, node, type, intensity, ts: Date.now(),
    snap: r ? { readingTs: r.ts, pm25: r.pm25, pm10: r.pm10, noise: r.noise, gas: r.gas, temp: r.temp, hum: r.hum } : null
  });
  await rl.set(Date.now());
  return send(chatId, `Terima kasih, laporan Anda tercatat.${r ? `\nKondisi sensor saat ini: ${levelLine(r)} (PM2.5 ${fmt(r.pm25)} µg/m³).` : ""}\nJika gejala berat atau berlanjut, segera hubungi fasilitas kesehatan.`);
}
async function cmdStop(chatId) {
  await db.ref(`subscribers/${chatId}`).remove();
  return send(chatId, "Anda berhenti berlangganan dan ID chat Anda sudah dihapus dari daftar. Laporan lama tetap tersimpan tanpa identitas; hapus dengan /hapusdata. Ketik /start untuk bergabung lagi.");
}
async function cmdDeleteData(chatId) {
  const uid = hashId(chatId);
  const snap = await db.ref("reports").orderByChild("uid").equalTo(uid).get();
  const updates = { [`rateLimits/reports/${uid}`]: null };
  let n = 0;
  snap.forEach((c) => { updates[`reports/${c.key}`] = null; n++; });
  await db.ref().update(updates);
  return send(chatId, `${n} laporan Anda sudah dihapus.`);
}
async function cmdAnalyst(chatId, code, msgId) {
  if (msgId) await tg("deleteMessage", { chat_id: chatId, message_id: msgId }); // hapus pesan berisi kode
  const ref = db.ref(`rateLimits/admin/${hashId(chatId)}`);
  const a = (await ref.get()).val() || { n: 0, ts: 0 };
  if (Date.now() - a.ts > 3600e3) a.n = 0;
  if (a.n >= 5) return send(chatId, "Terlalu banyak percobaan. Coba lagi nanti.");
  if (!code || !safeEqual(code, ADMIN_CODE.value())) {
    await ref.set({ n: a.n + 1, ts: Date.now() });
    return send(chatId, "Kode salah.");
  }
  await db.ref(`config/analysts/${chatId}`).set(true);
  return send(chatId, "Anda terdaftar sebagai analis. Anda akan menerima ringkasan harian pukul 07:00 WIB dan status alat. Ketik /ringkasan untuk ringkasan sekarang.");
}
async function cmdSummary(chatId) {
  const ok = (await db.ref(`config/analysts/${chatId}`).get()).val();
  if (!ok) return send(chatId, "Perintah ini khusus analis.");
  return sendChunks(chatId, await buildSummary(24));
}
const cmdHelp = (chatId) => send(chatId,
  "<b>Perintah</b>\n/status kondisi terkini\n/titik pilih lokasi yang diikuti\n/lapor laporkan keluhan\n/berhenti berhenti berlangganan\n/hapusdata hapus laporan Anda\n/bantuan menu ini");

async function onMessage(m) {
  if (!m.chat || m.chat.type !== "private" || !m.text) return;
  const chatId = m.chat.id;
  const [raw, ...args] = m.text.trim().split(/\s+/);
  const cmd = raw.toLowerCase().replace(/@.*$/, "");
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
  switch (act) {
    case "consent":
      if (a === "yes") { await db.ref(`subscribers/${chatId}`).update({ consentTs: Date.now() }); return cmdNodes(chatId); }
      return send(chatId, "Baik, tidak ada data Anda yang disimpan. Ketik /start jika berubah pikiran.");
    case "sub": case "unsub": {
      const sub = await getSub(chatId);
      if (!sub || !sub.consentTs) return needConsent(chatId);
      if (!(await getNodes())[a]) return;
      await db.ref(`subscribers/${chatId}/nodes/${a}`).set(act === "sub" ? true : null);
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
exports.telegramWebhook = onRequest(
  { region: REGION, secrets: [TELEGRAM_TOKEN, WEBHOOK_SECRET, ADMIN_CODE, HASH_SALT], maxInstances: 10 },
  async (req, res) => {
    const given = req.get("x-telegram-bot-api-secret-token") || "";
    if (req.method !== "POST" || !safeEqual(given, WEBHOOK_SECRET.value())) return res.status(403).send("forbidden");
    const u = req.body || {};
    try {
      if (u.message) await onMessage(u.message);
      else if (u.callback_query) await onCallback(u.callback_query);
    } catch (e) { logger.error("webhook", e); }
    res.status(200).send("ok"); // selalu 200 agar Telegram tidak mengulang pesan yang bermasalah
  }
);

// ---------------------------------------------------------------- 4b) aktivasi bot Telegram
/*
  Panggil SEKALI setelah fungsi di-deploy, dengan header x-api-key: <EXPORT_KEY>.
    POST https://<region>-<project>.cloudfunctions.net/telegramSetup
  URL webhook diambil otomatis dari alamat fungsi ini; bisa ditimpa dengan ?url=https://...
  Cek status: GET/POST .../telegramSetup?check=1
  Setelah ini bot langsung merespons /start dan perintah lain di Telegram.
  Catatan: WEBHOOK_SECRET hanya boleh berisi A-Z a-z 0-9 _ - (syarat secret_token Telegram).
*/
exports.telegramSetup = onRequest(
  { region: REGION, secrets: [TELEGRAM_TOKEN, WEBHOOK_SECRET, EXPORT_KEY], maxInstances: 2 },
  async (req, res) => {
    if (!safeEqual(req.get("x-api-key") || "", EXPORT_KEY.value())) return res.status(401).json({ error: "kunci salah" });
    const api = `https://api.telegram.org/bot${TELEGRAM_TOKEN.value()}`;

    if (req.query.check) {
      const j = await (await fetch(`${api}/getWebhookInfo`)).json().catch(() => ({ ok: false, description: "respons bukan JSON" }));
      return res.status(j.ok ? 200 : 502).json(j);
    }
    if (req.method !== "POST") return res.status(405).json({ error: "metode harus POST (atau tambahkan ?check=1)" });

    // Alamat default mengikuti host fungsi ini; timpa lewat ?url= bila dipanggil dari URL run.app.
    const url = String(req.query.url || `${req.protocol}://${req.get("host")}/telegramWebhook`);
    if (!/^https:\/\/[^\s]+$/.test(url)) return res.status(400).json({ error: "url webhook harus https" });

    const j = await (await fetch(`${api}/setWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        secret_token: WEBHOOK_SECRET.value(),
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true
      })
    })).json().catch(() => ({ ok: false, description: "respons bukan JSON" }));
    if (!j.ok) {
      logger.error("setWebhook gagal", j.error_code, j.description);
      return res.status(502).json({ ok: false, error: j.description || "gagal mendaftarkan webhook" });
    }
    logger.info("Webhook Telegram aktif", url);
    return res.json({ ok: true, webhook: url, keterangan: "Bot Telegram sudah aktif." });
  }
);

// ---------------------------------------------------------------- 5) ekspor CSV untuk analis
const csvCell = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (cols, rows) => "\uFEFF" + [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
const parseTime = (s, def) => {
  if (!s) return def;
  const t = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(t) ? t : def;
};
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);

/*
  GET .../exportCsv?type=readings|reports|alerts&node=ring1-01&from=2026-11-01T00:00:00%2B07:00&to=...&agg=hour
  Header: x-api-key: <EXPORT_KEY>
*/
exports.exportCsv = onRequest({ region: REGION, secrets: [EXPORT_KEY], timeoutSeconds: 120, memory: "512MiB" }, async (req, res) => {
  if (!safeEqual(req.get("x-api-key") || "", EXPORT_KEY.value())) return res.status(401).send("kunci salah");
  const type = String(req.query.type || "readings");
  const to = parseTime(req.query.to, Date.now());
  const from = Math.max(parseTime(req.query.from, to - 7 * 86400e3), to - 366 * 86400e3);
  const only = req.query.node ? String(req.query.node) : null;
  let csv;

  if (type === "readings") {
    const ids = only ? [only] : Object.keys(await getNodes());
    const rows = [];
    for (const id of ids) {
      const rs = await readingsSince(id, from, to);
      if (req.query.agg === "hour") {
        const buckets = new Map();
        for (const r of rs) {
          const h = Math.floor(r.ts / 3600e3) * 3600e3;
          if (!buckets.has(h)) buckets.set(h, []);
          buckets.get(h).push(r);
        }
        for (const [h, arr] of buckets) {
          const col = (k) => arr.map((r) => r[k]).filter(isNum);
          rows.push({
            node: id, jam_wib: wibIso(h), n: arr.length,
            pm25_rata: r2(mean(col("pm25"))), pm25_maks: col("pm25").length ? Math.max(...col("pm25")) : null,
            pm10_rata: r2(mean(col("pm10"))), suhu_rata: r2(mean(col("temp"))), lembap_rata: r2(mean(col("hum"))),
            bising_rata: r2(mean(col("noise"))), bising_maks: col("noise").length ? Math.max(...col("noise")) : null,
            gas_rata: r2(mean(col("gas"))), baterai_rata: r2(mean(col("batt")))
          });
        }
      } else {
        for (const r of rs) rows.push({ node: id, waktu_wib: wibIso(r.ts), pm1: r.pm1, pm25: r.pm25, pm10: r.pm10, suhu: r.temp, lembap: r.hum, gas: r.gas, bising: r.noise, baterai: r.batt });
      }
    }
    const cols = req.query.agg === "hour"
      ? ["node", "jam_wib", "n", "pm25_rata", "pm25_maks", "pm10_rata", "suhu_rata", "lembap_rata", "bising_rata", "bising_maks", "gas_rata", "baterai_rata"]
      : ["node", "waktu_wib", "pm1", "pm25", "pm10", "suhu", "lembap", "gas", "bising", "baterai"];
    csv = toCsv(cols, rows);
  } else if (type === "reports") {
    const o = (await db.ref("reports").orderByChild("ts").startAt(from).endAt(to).get()).val() || {};
    const rows = Object.values(o).filter((r) => !only || r.node === only).sort((a, b) => a.ts - b.ts).map((r) => ({
      waktu_wib: wibIso(r.ts), node: r.node, keluhan: SYMPTOMS[r.type] || r.type, tingkat: r.intensity,
      pm25: r.snap && r.snap.pm25, pm10: r.snap && r.snap.pm10, bising: r.snap && r.snap.noise, gas: r.snap && r.snap.gas,
      suhu: r.snap && r.snap.temp, lembap: r.snap && r.snap.hum, waktu_sensor_wib: r.snap && r.snap.readingTs ? wibIso(r.snap.readingTs) : ""
    })); // kode pelapor sengaja tidak diekspor
    csv = toCsv(["waktu_wib", "node", "keluhan", "tingkat", "pm25", "pm10", "bising", "gas", "suhu", "lembap", "waktu_sensor_wib"], rows);
  } else if (type === "alerts") {
    const o = (await db.ref("alerts").orderByChild("ts").startAt(from).endAt(to).get()).val() || {};
    const rows = Object.values(o).filter((a) => !only || a.node === only).sort((a, b) => a.ts - b.ts)
      .map((a) => ({ waktu_wib: wibIso(a.ts), node: a.node, jenis: a.type, status: a.state, level: a.level, nilai: a.value }));
    csv = toCsv(["waktu_wib", "node", "jenis", "status", "level", "nilai"], rows);
  } else return res.status(400).send("type harus readings, reports, atau alerts");

  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="ring1_${type}.csv"`);
  res.send(csv);
});
