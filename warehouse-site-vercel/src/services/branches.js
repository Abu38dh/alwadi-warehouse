/**
 * أجهزة الفروع وصندوق المستندات المؤقت.
 *
 *  الفرع البعيد ما يقدر يوصل للجهاز الرئيسي (جدة) مباشرة لأن جهاز الشركة بدون IP ثابت،
 *  فيرفع المستند للموقع، والجهاز الرئيسي يسحبه ويرسله من رقم الشركة ثم يرجّع النتيجة.
 *
 *  - بدون رموز ربط: الإدارة تحمّل "ملف تركيب الطابعة" لكل فرع، وفيه مفتاح الفرع. أول ما ينركّب
 *    الملف على جهاز، الجهاز يتسجّل لحاله على فرع الملف (باسم الكمبيوتر) وياخذ مفتاحه الخاص.
 *  - مفتاح الفرع ما ينحفظ: يُحسب من سر الموقع + اسم الفرع + رقم نسخته. "ملف جديد للفرع" يرفع الرقم،
 *    فالملف القديم ما يقدر يسجّل أجهزة جديدة (والأجهزة المسجّلة قبل تكمل عادي).
 *  - مفتاح الجهاز ما يُحفظ في الموقع (بصمته فقط). الإيقاف يقطع الجهاز فوراً، والجهاز الموقوف ما يرجع لو أعاد التركيب.
 *  - نفس الملف من نفس الجهاز ما يتكرر (بصمة الملف) => إعادة الرفع آمنة.
 *  - الملف ينحذف من الموقع أول ما يأكّد الجهاز الرئيسي إنه استلمه.
 *  - مستند "مأخوذ" وما تأكد استلامه خلال 10 دقائق يرجع متاح (لو انطفى الجهاز الرئيسي وقت السحب).
 */
const crypto = require('crypto');
const { getSetting, setSetting } = require('../db');
const storage = require('./storage');

const TAKEN_LEASE_MS = 10 * 60 * 1000;
const MAIN_BRANCH_KEY = 'main_branch_name';
const DEFAULT_MAIN_BRANCH = 'جدة';
const INSTALL_SECRET_KEY = 'install_secret';
const INSTALL_VERSIONS_KEY = 'install_key_versions';

class BranchError extends Error {}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function cleanName(value, max = 60) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** اسم الفرع بدون كلمة "فرع" (الشاشات تكتبها قبله: "فرع الرياض") */
function branchName(value) {
  return cleanName(value, 40).replace(/^(?:ال)?فرع\s+/, '').trim();
}

// ---------- فرع الجهاز الرئيسي ----------

async function mainBranchName(db) {
  return branchName(await getSetting(db, MAIN_BRANCH_KEY, DEFAULT_MAIN_BRANCH)) || DEFAULT_MAIN_BRANCH;
}

async function setMainBranchName(db, name) {
  const clean = branchName(name);
  if (!clean) throw new BranchError('اكتب اسم فرع الجهاز الرئيسي.');
  const old = await mainBranchName(db);
  if (clean === old) return clean;
  const existing = await allBranches(db);
  await db.transaction(async (tx) => {
    // اسم جديد (تصحيح اسم الفرع): كل شي على الاسم القديم ينتقل للجديد — الفسوحات والحسابات والموظفين والأجهزة.
    // فرع موجود أصلاً: بس يصير هو الرئيسي (بدون دمج الفرعين).
    if (!existing.includes(clean)) {
      for (const t of ['documents', 'users', 'couriers', 'workers', 'relay_devices']) {
        await tx.prepare(`UPDATE OR IGNORE ${t} SET branch = ? WHERE branch = ?`).run(clean, old);
      }
      const v = await installVersions(tx);
      if (v[old]) { v[clean] = v[old]; delete v[old]; await setSetting(tx, INSTALL_VERSIONS_KEY, v); }
    }
    await setSetting(tx, MAIN_BRANCH_KEY, clean);
  });
  return clean;
}

// ---------- مفاتيح الفروع (ملفات التركيب) ----------

async function installSecret(db) {
  let secret = await getSetting(db, INSTALL_SECRET_KEY, null);
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    // لو انحفظ سر ثاني بنفس اللحظة (طلبين مع بعض): ناخذ المحفوظ
    await db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(INSTALL_SECRET_KEY, JSON.stringify(secret));
    secret = await getSetting(db, INSTALL_SECRET_KEY, secret);
  }
  return secret;
}

async function installVersions(db) {
  const raw = await getSetting(db, INSTALL_VERSIONS_KEY, {});
  const v = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, n] of Object.entries(raw)) {
      const b = branchName(k);
      if (b) v[b] = Math.max(Number(v[b]) || 0, Number(n) || 1);
    }
  }
  return v;
}

/**
 * كل الفروع — قائمة وحدة لكل الموقع (الحسابات، الموصلين، الفسوحات، ملفات الطابعة):
 * الرئيسي أولاً، ثم اللي انضافت من "أجهزة المحاسبين" أو فيها أجهزة/فسوحات/حسابات/موظفين.
 */
async function allBranches(db) {
  const main = await mainBranchName(db);
  const names = new Set(Object.keys(await installVersions(db)));
  const rows = await db.prepare(`
    SELECT branch FROM relay_devices UNION SELECT branch FROM documents UNION SELECT branch FROM users
    UNION SELECT branch FROM couriers UNION SELECT branch FROM workers
  `).all();
  for (const r of rows) { const b = branchName(r.branch); if (b) names.add(b); }
  names.delete(main);
  return [main, ...[...names].sort((a, b) => a.localeCompare(b, 'ar'))];
}
const installBranches = allBranches;

async function addInstallBranch(db, name) {
  const b = branchName(name);
  if (!b) throw new BranchError('اكتب اسم الفرع.');
  const v = await installVersions(db);
  if (!v[b]) { v[b] = 1; await setSetting(db, INSTALL_VERSIONS_KEY, v); }
  return b;
}

const computeInstallKey = (secret, branch, version) =>
  `br_${crypto.createHmac('sha256', secret).update(`${branch}\n${version}`).digest('base64url')}`;

/** مفتاح الفرع اللي ينكتب داخل ملف التركيب */
async function installKeyFor(db, branch) {
  const b = branchName(branch);
  if (!b || !(await installBranches(db)).includes(b)) throw new BranchError('الفرع غير موجود.');
  return computeInstallKey(await installSecret(db), b, (await installVersions(db))[b] || 1);
}

/** "ملف جديد للفرع": الملف القديم يوقف عن تسجيل أجهزة جديدة */
async function rotateInstallKey(db, branch) {
  const b = branchName(branch);
  if (!b || !(await installBranches(db)).includes(b)) throw new BranchError('الفرع غير موجود.');
  const v = await installVersions(db);
  v[b] = (Number(v[b]) || 1) + 1;
  await setSetting(db, INSTALL_VERSIONS_KEY, v);
  return b;
}

async function branchForInstallKey(db, key) {
  const k = String(key || '');
  if (!k.startsWith('br_') || k.length > 100) return null;
  const secret = await installSecret(db);
  const v = await installVersions(db);
  for (const b of await installBranches(db)) {
    const expected = Buffer.from(computeInstallKey(secret, b, v[b] || 1));
    const given = Buffer.from(k);
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return b;
  }
  return null;
}

// ---------- الأجهزة (الإدارة) ----------

async function listDevices(db) {
  return (await db.prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM relay_jobs j WHERE j.device_id = d.id AND j.status IN ('waiting', 'taken')) AS waiting,
      (SELECT COUNT(*) FROM relay_jobs j WHERE j.device_id = d.id) AS total
    FROM relay_devices d ORDER BY d.active DESC, d.branch, d.name
  `).all()).map(d => ({ ...d, state: !d.active ? 'off' : d.token_hash ? 'paired' : 'unpaired' }));
}

/** نقل الجهاز لفرع ثاني (مثلاً انركّب عليه ملف فرع غلط) */
async function setDeviceBranch(db, deviceId, branch) {
  const b = branchName(branch);
  if (!b) throw new BranchError('اختر الفرع.');
  if (!(await allBranches(db)).includes(b)) throw new BranchError('الفرع غير موجود.');
  const r = await db.prepare('UPDATE relay_devices SET branch = ? WHERE id = ?').run(b, deviceId);
  if (!r.changes) throw new BranchError('الجهاز غير موجود.');
  return b;
}

async function setActive(db, deviceId, active) {
  const r = await db.prepare('UPDATE relay_devices SET active = ? WHERE id = ?').run(active ? 1 : 0, deviceId);
  if (!r.changes) throw new BranchError('الجهاز غير موجود.');
}

// ---------- الأجهزة (من جهاز الفرع) ----------

/**
 * التسجيل التلقائي من ملف التركيب: مفتاح الفرع + اسم الكمبيوتر => مفتاح الجهاز.
 * نفس الكمبيوتر لو أعاد التركيب (أو ركّب ملف فرع ثاني) ياخذ نفس سجله ويتحدث فرعه —
 * بشرط يثبت إنه هو (يرسل مفتاحه الحالي). بدون إثبات = سجل جديد، عشان ما أحد ياخذ مكان جهاز ثاني
 * بمجرد إنه سمّى كمبيوتره بنفس الاسم.
 * @returns {{device_id, token, name, branch} | {error: 'wrong_key'|'stopped'}}
 */
async function enrollDevice(db, { installKey, deviceName, deviceId, token: currentToken }) {
  const branch = await branchForInstallKey(db, installKey);
  if (!branch) return { error: 'wrong_key' };
  const name = cleanName(deviceName, 60) || 'جهاز';
  let existing = null;
  if (deviceId && currentToken) {
    const d = await db.prepare('SELECT * FROM relay_devices WHERE id = ? AND token_hash IS NOT NULL').get(Number(deviceId) || 0);
    if (d) {
      const a = Buffer.from(sha(currentToken), 'hex');
      const b = Buffer.from(d.token_hash, 'hex');
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) existing = d;
    }
  }
  if (existing && !existing.active) return { error: 'stopped' };
  // الجهاز الموقوف ما يرجع لو أعاد التركيب (آخر سجل بنفس الاسم موقوف)
  const sameName = existing ? null : await db.prepare('SELECT active FROM relay_devices WHERE name = ? COLLATE NOCASE ORDER BY id DESC').get(name);
  if (sameName && !sameName.active) return { error: 'stopped' };
  const token = `dev_${crypto.randomBytes(32).toString('base64url')}`;
  const now = new Date().toISOString();
  let id;
  if (existing) {
    await db.prepare('UPDATE relay_devices SET branch = ?, token_hash = ?, pair_code_hash = NULL, pair_expires_at = NULL, paired_at = ?, last_seen_at = ? WHERE id = ?')
      .run(branch, sha(token), now, now, existing.id);
    id = existing.id;
  } else {
    id = Number((await db.prepare('INSERT INTO relay_devices (name, branch, token_hash, active, created_at, paired_at, last_seen_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
      .run(name, branch, sha(token), now, now, now)).lastInsertRowid);
  }
  return { device_id: id, token, name: existing ? existing.name : name, branch };
}

async function verifyDevice(db, deviceId, token) {
  if (!deviceId || !token) return null;
  const d = await db.prepare('SELECT * FROM relay_devices WHERE id = ? AND active = 1 AND token_hash IS NOT NULL').get(Number(deviceId) || 0);
  if (!d) return null;
  const a = Buffer.from(sha(token), 'hex');
  const b = Buffer.from(d.token_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  await db.prepare('UPDATE relay_devices SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), d.id);
  return d;
}

// ---------- الصندوق ----------

const relayKey = (rel) => `relay/${rel}`;

/** رفع مستند من جهاز فرع. نفس الملف من نفس الجهاز يرجع نفس رقم المهمة */
async function enqueueUpload(db, config, device, { pdfBuffer, fileName }) {
  const hash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  const existing = await db.prepare('SELECT id FROM relay_jobs WHERE device_id = ? AND sha256 = ?').get(device.id, hash);
  if (existing) return { job_id: existing.id, duplicate: true, sha256: hash };
  const rel = `${device.id}-${hash}.pdf`; // لكل جهاز ملفه (نفس الملف من جهازين = مهمتين مستقلتين)
  await storage.putFile(db, relayKey(rel), pdfBuffer);
  const info = await db.prepare('INSERT INTO relay_jobs (device_id, sha256, file_name, size, path, status, created_at) VALUES (?, ?, ?, ?, ?, \'waiting\', ?)')
    .run(device.id, hash, cleanName(fileName, 150) || 'document.pdf', pdfBuffer.length, rel, new Date().toISOString());
  return { job_id: Number(info.lastInsertRowid), duplicate: false, sha256: hash };
}

/** حالة مهمة لجهاز الفرع (مهامه هو فقط) */
async function jobStatusForDevice(db, device, jobId) {
  const j = await db.prepare('SELECT * FROM relay_jobs WHERE id = ? AND device_id = ?').get(jobId, device.id);
  if (!j) return null;
  let outcome = null;
  try { outcome = j.outcome_json ? JSON.parse(j.outcome_json) : null; } catch (_) {}
  return { job_id: j.id, status: j.status, outcome };
}

/** المستندات اللي تنتظر الجهاز الرئيسي (ومعها اسم الفرع والجهاز) — تنعلّم "مأخوذة" */
async function takeNext(db, limit = 3, now = Date.now()) {
  const leaseCutoff = new Date(now - TAKEN_LEASE_MS).toISOString();
  return db.transaction(async (tx) => {
    const rows = await tx.prepare(`
      SELECT j.id, j.sha256, j.file_name, j.size, d.name AS device_name, d.branch
      FROM relay_jobs j JOIN relay_devices d ON d.id = j.device_id
      WHERE j.status = 'waiting' OR (j.status = 'taken' AND j.taken_at < ?)
      ORDER BY j.id ASC LIMIT ?
    `).all(leaseCutoff, limit);
    const at = new Date(now).toISOString();
    for (const r of rows) await tx.prepare("UPDATE relay_jobs SET status = 'taken', taken_at = ? WHERE id = ?").run(at, r.id);
    return rows.map(r => ({ job_id: r.id, sha256: r.sha256, file_name: r.file_name, size: r.size, device_name: r.device_name, branch: r.branch }));
  });
}

/** ملف المهمة (Buffer) للجهاز الرئيسي، أو null */
async function jobFile(db, config, jobId) {
  const j = await db.prepare("SELECT path FROM relay_jobs WHERE id = ? AND status IN ('waiting', 'taken')").get(jobId);
  if (!j || !j.path) return null;
  return storage.getFile(db, relayKey(j.path));
}

/** الجهاز الرئيسي استلم الملف: ينحذف من الموقع */
async function markReceived(db, config, jobId) {
  const j = await db.prepare('SELECT * FROM relay_jobs WHERE id = ?').get(jobId);
  if (!j) return false;
  if (j.status === 'waiting' || j.status === 'taken') {
    await db.prepare("UPDATE relay_jobs SET status = 'received', received_at = ?, path = NULL WHERE id = ?").run(new Date().toISOString(), jobId);
    if (j.path) { try { await storage.deleteFile(db, relayKey(j.path)); } catch (_) {} }
  }
  return true;
}

const OUTCOME_STATUSES = new Set(['sent', 'review', 'skipped', 'dry_run']);

/** النتيجة النهائية من الجهاز الرئيسي (يشوفها جهاز الفرع) */
async function setOutcome(db, config, jobId, outcome) {
  const j = await db.prepare('SELECT * FROM relay_jobs WHERE id = ?').get(jobId);
  if (!j) return { status: 404 };
  if (!OUTCOME_STATUSES.has(outcome.status)) return { status: 400 };
  if (j.status !== 'received' && j.status !== 'done') await markReceived(db, config, jobId);
  const clean = {
    status: outcome.status,
    customer_number: cleanName(outcome.customer_number, 30) || null,
    destination: cleanName(outcome.destination, 150) || null,
    message: cleanName(outcome.message, 300) || null
  };
  await db.prepare("UPDATE relay_jobs SET status = 'done', done_at = ?, outcome_json = ? WHERE id = ?").run(new Date().toISOString(), JSON.stringify(clean), jobId);
  return { status: 200 };
}

module.exports = {
  BranchError,
  DEFAULT_MAIN_BRANCH,
  branchName,
  allBranches,
  mainBranchName,
  setMainBranchName,
  listDevices,
  setActive,
  setDeviceBranch,
  installBranches,
  addInstallBranch,
  installKeyFor,
  rotateInstallKey,
  branchForInstallKey,
  enrollDevice,
  verifyDevice,
  enqueueUpload,
  jobStatusForDevice,
  takeNext,
  jobFile,
  markReceived,
  setOutcome
};
