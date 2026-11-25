/**
 * المستخدمون والموظفون والموصلون (تديرهم الإدارة). لا حذف: الإيقاف بدل الحذف حتى يبقى السجل سليماً.
 *
 * الفروع: كل فرع له مستودعه.
 *  - حساب مسؤول المستودع يتربط بفرع ويشوف فسوحات فرعه فقط (بدون فرع = كل الفروع).
 *  - الموظفون والموصلون لكل فرع (بدون فرع = يظهرون في كل الفروع)، ونفس الاسم مسموح في فرعين.
 */
const auth = require('../auth');
const { branchName } = require('./branches');

const ROLES = ['warehouse', 'admin'];

class PeopleError extends Error {}

function cleanName(value, max = 80) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** الفرع من النموذج: نص فاضي = بدون فرع (null)، و undefined = لا تغيير */
function cleanBranch(value) {
  if (value === undefined) return undefined;
  return branchName(value) || null;
}

const branchLabel = (b) => (b ? ` في فرع ${b}` : '');

// ---------- المستخدمون ----------

async function listUsers(db) {
  return db.prepare('SELECT id, username, full_name, role, active, branch, created_at FROM users ORDER BY active DESC, role ASC, branch ASC, full_name ASC').all();
}

async function activeAdminCount(db) {
  return (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get()).n;
}

async function createUser(db, config, { username, fullName, role, password, branch }) {
  const name = cleanName(fullName);
  const user = String(username || '').trim();
  if (!name) throw new PeopleError('اكتب الاسم.');
  const usernameError = auth.validateUsername(user);
  if (usernameError) throw new PeopleError(usernameError);
  if (!ROLES.includes(role)) throw new PeopleError('اختر الدور.');
  const passwordError = auth.validateNewPassword(config, password);
  if (passwordError) throw new PeopleError(passwordError);
  if (await db.prepare('SELECT 1 AS x FROM users WHERE username = ?').get(user)) throw new PeopleError(`اسم المستخدم "${user}" مستخدم من قبل.`);
  const hash = await auth.hashPassword(config, password);
  try {
    const info = await db.prepare('INSERT INTO users (username, password_hash, full_name, role, active, branch, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(user, hash, name, role, role === 'warehouse' ? (cleanBranch(branch) || null) : null, new Date().toISOString());
    return Number(info.lastInsertRowid);
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) throw new PeopleError(`اسم المستخدم "${user}" مستخدم من قبل.`);
    throw err;
  }
}

/** تعديل الاسم والدور والفرع والتفعيل. لازم يبقى حساب إدارة فعّال واحد على الأقل، وما أحد يوقف حسابه بنفسه */
async function updateUser(db, { id, fullName, role, active, actingUserId, branch }) {
  const name = cleanName(fullName);
  if (!name) throw new PeopleError('اكتب الاسم.');
  if (!ROLES.includes(role)) throw new PeopleError('اختر الدور.');
  return db.transaction(async (tx) => {
    const target = await tx.prepare('SELECT id, role, active, branch FROM users WHERE id = ?').get(id);
    if (!target) throw new PeopleError('المستخدم غير موجود.');
    if (id === actingUserId && !active) throw new PeopleError('ما تقدر توقف حسابك أنت.');
    const losesAdmin = target.role === 'admin' && target.active && (role !== 'admin' || !active);
    if (losesAdmin && await activeAdminCount(tx) <= 1) throw new PeopleError('لازم يبقى حساب إدارة واحد فعّال على الأقل.');
    const b = cleanBranch(branch);
    // الإدارة تشوف كل الفروع دائماً
    const newBranch = role === 'admin' ? null : (b === undefined ? target.branch : b);
    await tx.prepare('UPDATE users SET full_name = ?, role = ?, active = ?, branch = ? WHERE id = ?').run(name, role, active ? 1 : 0, newBranch, id);
    return { deactivated: !!target.active && !active, branchChanged: newBranch !== target.branch };
  });
}

async function setPassword(db, config, { id, password }) {
  const passwordError = auth.validateNewPassword(config, password);
  if (passwordError) throw new PeopleError(passwordError);
  if (!(await db.prepare('SELECT 1 AS x FROM users WHERE id = ?').get(id))) throw new PeopleError('المستخدم غير موجود.');
  const hash = await auth.hashPassword(config, password);
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
}

// ---------- الموظفون والموصلون (أسماء فقط، لكل فرع) ----------

/** القائمة: فرع محدد = أسماء هذا الفرع + الأسماء العامة؛ بدون فرع = الكل (صفحة الإدارة) */
async function listNames(db, table, cols, { activeOnly = false, branch = undefined } = {}) {
  const where = [];
  const params = [];
  if (activeOnly) where.push('active = 1');
  if (branch !== undefined) { where.push('(branch IS NULL OR branch = ?)'); params.push(branch); }
  return db.prepare(`SELECT ${cols} FROM ${table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY active DESC, IFNULL(branch, '') ASC, name ASC`).all(...params);
}

async function nameTaken(db, table, name, branch, exceptId = 0) {
  return !!(await db.prepare(`SELECT 1 AS x FROM ${table} WHERE name = ? COLLATE NOCASE AND IFNULL(branch, '') = IFNULL(?, '') AND id != ?`).get(name, branch, exceptId));
}

function cleanPhone(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  if (!/^[0-9+\-\s()]{5,20}$/.test(s)) throw new PeopleError('رقم الجوال غير صحيح.');
  return s;
}

const listCouriers = (db, opts) => listNames(db, 'couriers', 'id, name, phone, active, branch, created_at', opts);
const listWorkers = (db, opts) => listNames(db, 'workers', 'id, name, active, branch, created_at', opts);

async function createCourier(db, { name, phone, branch }) {
  const clean = cleanName(name);
  if (!clean) throw new PeopleError('اكتب اسم الموصل.');
  const cleanedPhone = cleanPhone(phone);
  const b = cleanBranch(branch) || null;
  if (await nameTaken(db, 'couriers', clean, b)) throw new PeopleError(`الموصل "${clean}" موجود في القائمة${branchLabel(b)} من قبل.`);
  const info = await db.prepare('INSERT INTO couriers (name, phone, active, branch, created_at) VALUES (?, ?, 1, ?, ?)').run(clean, cleanedPhone, b, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

async function updateCourier(db, { id, name, phone, active, branch }) {
  const clean = cleanName(name);
  if (!clean) throw new PeopleError('اكتب اسم الموصل.');
  const cleanedPhone = cleanPhone(phone);
  const row = await db.prepare('SELECT id, branch FROM couriers WHERE id = ?').get(id);
  if (!row) throw new PeopleError('الموصل غير موجود.');
  const b = cleanBranch(branch) === undefined ? row.branch : cleanBranch(branch);
  if (await nameTaken(db, 'couriers', clean, b, id)) throw new PeopleError(`الموصل "${clean}" موجود في القائمة${branchLabel(b)} من قبل.`);
  await db.prepare('UPDATE couriers SET name = ?, phone = ?, active = ?, branch = ? WHERE id = ?').run(clean, cleanedPhone, active ? 1 : 0, b, id);
}

async function createWorker(db, { name, branch }) {
  const clean = cleanName(name, 60);
  if (!clean) throw new PeopleError('اكتب اسم الموظف.');
  const b = cleanBranch(branch) || null;
  if (await nameTaken(db, 'workers', clean, b)) throw new PeopleError(`الموظف "${clean}" موجود في القائمة${branchLabel(b)} من قبل.`);
  const info = await db.prepare('INSERT INTO workers (name, active, branch, created_at) VALUES (?, 1, ?, ?)').run(clean, b, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

async function updateWorker(db, { id, name, active, branch }) {
  const clean = cleanName(name, 60);
  if (!clean) throw new PeopleError('اكتب اسم الموظف.');
  const row = await db.prepare('SELECT id, branch FROM workers WHERE id = ?').get(id);
  if (!row) throw new PeopleError('الموظف غير موجود.');
  const b = cleanBranch(branch) === undefined ? row.branch : cleanBranch(branch);
  if (await nameTaken(db, 'workers', clean, b, id)) throw new PeopleError(`الموظف "${clean}" موجود في القائمة${branchLabel(b)} من قبل.`);
  await db.prepare('UPDATE workers SET name = ?, active = ?, branch = ? WHERE id = ?').run(clean, active ? 1 : 0, b, id);
}

/**
 * الاسم المكتوب وقت الشغل: يرجع الموجود في نفس الفرع (أو الاسم العام) أو ينشئه لهذا الفرع.
 * الاسم الموقوف يرجع فعّال لأن أحد استخدمه من جديد.
 * @returns {{id: number, name: string} | null} null إذا الاسم فاضي
 */
async function findOrCreateByName(db, table, name, max, branch = null) {
  const clean = cleanName(name, max);
  if (!clean) return null;
  const existing = await db.prepare(`
    SELECT id, name, active, branch FROM ${table}
    WHERE name = ? COLLATE NOCASE AND (IFNULL(branch, '') = IFNULL(?, '') OR branch IS NULL)
    ORDER BY branch IS NULL ASC LIMIT 1
  `).get(clean, branch || null);
  if (existing) {
    if (!existing.active) await db.prepare(`UPDATE ${table} SET active = 1 WHERE id = ?`).run(existing.id);
    return { id: existing.id, name: existing.name, branch: existing.branch };
  }
  const info = await db.prepare(`INSERT INTO ${table} (name, active, branch, created_at) VALUES (?, 1, ?, ?)`).run(clean, branch || null, new Date().toISOString());
  return { id: Number(info.lastInsertRowid), name: clean, branch: branch || null };
}

const findOrCreateWorker = (db, name, branch) => findOrCreateByName(db, 'workers', name, 60, branch);
const findOrCreateCourier = (db, name, branch) => findOrCreateByName(db, 'couriers', name, 80, branch);

module.exports = {
  ROLES,
  PeopleError,
  cleanName,
  listUsers,
  activeAdminCount,
  createUser,
  updateUser,
  setPassword,
  listCouriers,
  createCourier,
  updateCourier,
  findOrCreateCourier,
  listWorkers,
  createWorker,
  updateWorker,
  findOrCreateWorker
};
