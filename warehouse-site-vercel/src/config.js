/**
 * إعدادات الموقع (نسخة فيرسيل): من متغيرات البيئة (لوحة فيرسيل ← Settings ← Environment Variables)،
 * أو ملف .env للتجربة المحلية.
 *
 *  DATABASE_URL         libsql://<اسم-القاعدة>.turso.io   (فاضي = ملف محلي داخل data/ للتجربة)
 *  DATABASE_AUTH_TOKEN  توكن Turso
 *  SESSION_SECRET       نص عشوائي طويل (48 حرف أو أكثر) — إلزامي على فيرسيل
 *  SETUP_TOKEN          رمز إنشاء أول حساب إدارة
 *  PUBLIC_URL           عنوان الموقع (مثل https://ops.example.com) — ينكتب داخل ملف تركيب الطابعة
 *  PRINTER_INSTALLER_URL رابط ملف printer-setup.exe الأصلي (مرفوع على Vercel Blob)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  try { process.loadEnvFile(file); } catch (err) { console.warn(`تحذير: تعذر قراءة ملف .env: ${err.message}`); }
}

/** سر الجلسات: من البيئة. للتجربة المحلية فقط: يُنشأ مرة ويُحفظ داخل مجلد البيانات */
function resolveSessionSecret(dataDir, fromEnv, onVercel) {
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (onVercel) throw new Error('SESSION_SECRET مطلوب في إعدادات فيرسيل (Environment Variables) — نص عشوائي 48 حرف أو أكثر');
  const file = path.join(dataDir, 'session-secret.txt');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch (_) {}
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

function loadConfig(overrides = {}) {
  const env = process.env;
  const onVercel = !!env.VERCEL;
  const production = env.NODE_ENV === 'production' || onVercel;
  const dataDir = overrides.dataDir || env.DATA_DIR || path.join(ROOT, 'data');
  const config = {
    root: ROOT,
    production,
    onVercel,
    port: Number(env.PORT) || 4000,
    host: env.HOST || '127.0.0.1',
    dataDir,
    // DATABASE_URL أو أسماء Turso اللي يضيفها فيرسيل لحاله (Storage ← Turso)
    databaseUrl: env.DATABASE_URL || env.TURSO_DATABASE_URL || '',
    databaseAuthToken: env.DATABASE_AUTH_TOKEN || env.TURSO_AUTH_TOKEN || '',
    // فيرسيل قدام الموقع (HTTPS): الكوكي آمن والعنوان الحقيقي للزائر من البروكسي
    trustProxy: production || env.TRUST_PROXY === '1',
    secureCookies: production || env.SECURE_COOKIES === '1',
    // رمز إنشاء أول حساب إدارة (إلزامي في الإنتاج)
    setupToken: env.SETUP_TOKEN || '',
    // فيرسيل يرفض أي طلب أكبر من 4.5 ميقا (والملف يرجع للعارض base64 = أكبر بالثلث)
    maxPdfBytes: 3 * 1024 * 1024,
    sessionIdleMs: 12 * 60 * 60 * 1000,
    lockAfterFails: 5,
    lockMs: 15 * 60 * 1000,
    bcryptRounds: 12,
    minPasswordLength: 8,
    // عنوان الموقع اللي ينكتب داخل ملف تركيب الطابعة. فاضي = عنوان الطلب نفسه
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    // ملف تركيب الطابعة الأصلي: رابط (فيرسيل) أو مسار على الجهاز (تجربة محلية)
    printerInstallerUrl: env.PRINTER_INSTALLER_URL || '',
    printerInstaller: env.PRINTER_INSTALLER || path.join(ROOT, '..', 'inovces', 'dist', 'printer-setup.exe'),
    blobToken: env.BLOB_READ_WRITE_TOKEN || '',
    ...overrides
  };
  config.sessionSecret = overrides.sessionSecret || resolveSessionSecret(config.dataDir, env.SESSION_SECRET, onVercel);
  return config;
}

module.exports = { loadConfig, loadEnvFile, ROOT };
