/**
 * ملف تركيب الطابعة لكل فرع.
 *
 * ملف التركيب واحد لكل الفروع (يُبنى على ويندوز: `npm run build-exe` في مجلد البرنامج => dist\printer-setup.exe).
 * وقت التحميل يُضاف في آخره سطر فيه عنوان الموقع ومفتاح الفرع، فيصير "ملف فرع الرياض" مثلاً.
 * ويندوز يتجاهل أي شي بعد نهاية البرنامج، وملف التركيب يقرأ هذا السطر من نفسه.
 */
const fs = require('fs');

const MARKER = 'ALWADY-INSTALL-CONFIG:';
const END = ':END';

/** السطر اللي ينضاف في آخر الملف */
function configTrailer(cfg) {
  const json = JSON.stringify({ v: 1, ...cfg });
  return Buffer.from(`\r\n${MARKER}${Buffer.from(json, 'utf8').toString('base64')}${END}\r\n`, 'ascii');
}

/** قراءة السطر من آخر الملف (للاختبارات، ونفس طريقة ملف التركيب) */
function readTrailer(buf) {
  const tail = buf.subarray(Math.max(0, buf.length - 8192)).toString('latin1');
  const i = tail.lastIndexOf(MARKER);
  if (i < 0) return null;
  const j = tail.indexOf(END, i);
  if (j < 0) return null;
  try { return JSON.parse(Buffer.from(tail.slice(i + MARKER.length, j), 'base64').toString('utf8')); } catch (_) { return null; }
}

function installerAvailable(filePath) {
  try { return fs.statSync(filePath).size > 1024; } catch (_) { return false; }
}

/** إرسال ملف الفرع للمتصفح: الملف الأصلي + سطر الفرع */
function sendInstaller(res, filePath, cfg, downloadName) {
  const trailer = configTrailer(cfg);
  const size = fs.statSync(filePath).size + trailer.length;
  res.set({
    'Content-Type': 'application/vnd.microsoft.portable-executable',
    'Content-Length': String(size),
    'Content-Disposition': `attachment; filename="printer-setup.exe"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    'Cache-Control': 'no-store'
  });
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.on('end', () => res.end(trailer));
  stream.pipe(res, { end: false });
}

// ---------- نسخة فيرسيل ----------
// الملف 47 ميقا وفيرسيل ما يرجّع أكثر من 4.5 ميقا: الملف الأصلي مرفوع على Vercel Blob (PRINTER_INSTALLER_URL)،
// والموقع يسوي نسخة لكل فرع (الأصلي + سطر الفرع) على Blob نفسه، ويحوّل المتصفح لرابط تحميلها.
// النسخة تنحفظ: نفس الفرع بنفس المفتاح ما ينعاد رفعه.

const crypto = require('crypto');
const { getSetting, setSetting } = require('../db');

const BLOB_CACHE_KEY = 'installer_blobs_v2';

function blobConfigured(config) {
  return !!(config.printerInstallerUrl && config.blobToken);
}

/** هل التحميل متاح (Blob على فيرسيل، أو الملف على الجهاز للتجربة المحلية) */
function installerReady(config) {
  return blobConfigured(config) || installerAvailable(config.printerInstaller);
}

/** رابط تحميل ملف الفرع على Blob (يُنشأ أول مرة فقط) */
async function blobInstallerUrl(db, config, cfg) {
  const tag = crypto.createHash('sha256').update(`${cfg.siteUrl}\n${cfg.installKey}\n${cfg.branch}`).digest('hex').slice(0, 20);
  const cache = (await getSetting(db, BLOB_CACHE_KEY, {})) || {};
  if (cache[tag]) return cache[tag];
  const res = await fetch(config.printerInstallerUrl);
  if (!res.ok) throw new Error(`تعذر تحميل ملف الطابعة الأصلي (${res.status})`);
  const base = Buffer.from(await res.arrayBuffer());
  const { put } = require('@vercel/blob');
  // اسم الملف عند التحميل = اسم الفرع، والجزء العشوائي (اللي يخلي الرابط ما ينخمّن) اسم مجلد
  const fileName = `تركيب الطابعة - فرع ${String(cfg.branch).replace(/[\\/:*?"<>|]/g, ' ').trim()}.exe`;
  const blob = await put(`installers/${tag}/${fileName}`, Buffer.concat([base, configTrailer(cfg)]), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/vnd.microsoft.portable-executable',
    token: config.blobToken,
    multipart: true
  });
  const url = blob.downloadUrl || blob.url;
  cache[tag] = url;
  await setSetting(db, BLOB_CACHE_KEY, cache);
  return url;
}

// ---------- برنامج الواتساب للجهاز الرئيسي ----------
// ملف تثبيت صغير (installers/main-setup.exe) + سطر فيه عنوان الموقع ومفتاح الربط ورابط البرنامج على تخزين الموقع.
// الملف نفسه يحمّل البرنامج وقت التثبيت، فينرسل من الموقع مباشرة (صغير).

const path = require('path');
const MAIN_DIR = path.join(__dirname, '..', '..', 'installers');

/** { stub: Buffer, payload: {url, sha256, size} } أو null لو ما انرفع البرنامج */
function mainInstaller() {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(MAIN_DIR, 'main-payload.json'), 'utf8'));
    const stub = fs.readFileSync(path.join(MAIN_DIR, 'main-setup.exe'));
    if (!payload.url || !payload.sha256 || stub.length < 1024) return null;
    return { stub, payload };
  } catch (_) { return null; }
}

function sendMainInstaller(res, { siteUrl, apiKey }) {
  const m = mainInstaller();
  if (!m) return false;
  const body = Buffer.concat([m.stub, configTrailer({ role: 'main', siteUrl, apiKey, payloadUrl: m.payload.url, payloadSha256: m.payload.sha256 })]);
  res.set({
    'Content-Type': 'application/vnd.microsoft.portable-executable',
    'Content-Length': String(body.length),
    'Content-Disposition': `attachment; filename="alwadi-whatsapp-setup.exe"; filename*=UTF-8''${encodeURIComponent('برنامج واتساب الوادي.exe')}`,
    'Cache-Control': 'no-store'
  });
  res.end(body);
  return true;
}

module.exports = { MARKER, configTrailer, readTrailer, installerAvailable, sendInstaller, blobConfigured, installerReady, blobInstallerUrl, mainInstaller, sendMainInstaller };
