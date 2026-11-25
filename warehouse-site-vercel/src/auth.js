/**
 * الدخول والصلاحيات:
 *  - كلمات المرور بـ bcrypt، وجلسات محفوظة في القاعدة تنتهي بعد 12 ساعة خمول.
 *  - قفل مؤقت بعد عدة محاولات دخول خاطئة.
 *  - حماية CSRF لكل طلب يغيّر شيئاً.
 *  - الصلاحيات تُفحص في السيرفر مع كل طلب (المستخدم يُقرأ من القاعدة كل مرة: الإيقاف وتغيير الدور يسريان فوراً).
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const session = require('express-session');

const ROLE_LABELS = { admin: 'الإدارة', warehouse: 'مسؤول المستودع' };

// ---------- كلمات المرور ----------

function hashPassword(config, password) {
  return bcrypt.hash(String(password), config.bcryptRounds);
}

let dummyHashPromise = null;
/** مقارنة وهمية عند اسم مستخدم غير موجود: حتى لا يكشف زمن الرد وجود الحساب من عدمه */
function dummyCompare(config, password) {
  if (!dummyHashPromise) dummyHashPromise = bcrypt.hash(crypto.randomBytes(16).toString('hex'), config.bcryptRounds);
  return dummyHashPromise.then(h => bcrypt.compare(String(password), h)).then(() => false);
}

function validateNewPassword(config, password) {
  const p = String(password || '');
  if (p.length < config.minPasswordLength) return `كلمة المرور لازم تكون ${config.minPasswordLength} خانات أو أكثر`;
  if (p.length > 200) return 'كلمة المرور طويلة جداً';
  return null;
}

function validateUsername(username) {
  const u = String(username || '').trim();
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(u)) return 'اسم المستخدم: من 3 إلى 30 خانة، حروف إنجليزية وأرقام فقط (ويُسمح بـ . _ -)';
  return null;
}

// ---------- مخزن الجلسات في SQLite ----------

// نسخة فيرسيل: ما فيه مؤقت يشتغل بالخلفية، فتنظيف الجلسات المنتهية يصير مع الطلبات (مرة كل 15 دقيقة على الأكثر)
const PURGE_EVERY_MS = 15 * 60 * 1000;

class SqliteSessionStore extends session.Store {
  constructor(db, { ttlMs }) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.lastPurge = 0;
  }

  expiryOf(sess) {
    const e = sess && sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    return Number.isFinite(e) ? e : Date.now() + this.ttlMs;
  }

  maybePurge() {
    const now = Date.now();
    if (now - this.lastPurge < PURGE_EVERY_MS) return;
    this.lastPurge = now;
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now).catch(() => {});
  }

  get(sid, cb) {
    this.maybePurge();
    this.db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid).then((row) => {
      if (!row || row.expires_at < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    }, cb);
  }

  set(sid, sess, cb = () => {}) {
    this.db.prepare('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at')
      .run(sid, JSON.stringify(sess), this.expiryOf(sess)).then(() => cb(null), cb);
  }

  touch(sid, sess, cb = () => {}) {
    this.db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(this.expiryOf(sess), sid).then(() => cb(null), cb);
  }

  destroy(sid, cb = () => {}) {
    this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid).then(() => cb(null), cb);
  }

  close() {}
}

function sessionMiddleware(config, db) {
  const store = new SqliteSessionStore(db, { ttlMs: config.sessionIdleMs });
  const middleware = session({
    name: 'wh.sid',
    secret: config.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true, // كل طلب يمدد الجلسة: تنتهي بعد 12 ساعة خمول
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: config.sessionIdleMs }
  });
  return { middleware, store };
}

/** إنهاء كل جلسات مستخدم (بعد تغيير كلمة مروره أو إيقافه)، مع إمكانية استثناء الجلسة الحالية */
async function destroyUserSessions(db, userId, exceptSid = '') {
  return (await db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ? AND sid != ?").run(userId, exceptSid || '')).changes;
}

/** رسالة تظهر مرة واحدة في الصفحة التالية (بعد إعادة التوجيه) */
function flash(req, type, text) {
  req.session.flash = { type, text };
}

// ---------- القفل بعد محاولات خاطئة ----------

const IP_LOCK_AFTER_FAILS = 20; // حد أعلى لكل عنوان (تجربة أسماء كثيرة من نفس المكان)

function userKey(username) { return `u:${String(username || '').trim().toLowerCase().slice(0, 64)}`; }
function ipKey(ip) { return `ip:${String(ip || '').slice(0, 64)}`; }

/** كم باقي على انتهاء القفل (بالملي ثانية)، أو 0 */
async function lockRemainingMs(db, key, now = Date.now()) {
  const row = await db.prepare('SELECT locked_until FROM login_throttle WHERE key = ?').get(key);
  return row && row.locked_until && row.locked_until > now ? row.locked_until - now : 0;
}

/** تسجيل محاولة خاطئة. يعيد true إذا صار الحساب مقفلاً الآن */
async function recordFailure(db, config, key, limit = config.lockAfterFails, now = Date.now()) {
  const row = await db.prepare('SELECT fails, locked_until, updated_at FROM login_throttle WHERE key = ?').get(key);
  // مقفل أصلاً: القفل يبقى زي ما هو (محاولات كثيرة بنفس اللحظة ما تفكّه)
  if (row && row.locked_until && row.locked_until > now) return true;
  // المحاولات القديمة (أقدم من مدة القفل) لا تُحسب
  let fails = row && now - row.updated_at < config.lockMs ? row.fails : 0;
  fails += 1;
  const locked = fails >= limit;
  await db.prepare('INSERT INTO login_throttle (key, fails, locked_until, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until, updated_at = excluded.updated_at')
    .run(key, locked ? 0 : fails, locked ? now + config.lockMs : null, now);
  return locked;
}

async function clearFailures(db, key) {
  await db.prepare('DELETE FROM login_throttle WHERE key = ?').run(key);
}

// ---------- CSRF ----------

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url');
  return req.session.csrf;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** كل طلب يغيّر شيئاً لازم يحمل رمز الصفحة (حقل _csrf أو ترويسة x-csrf-token) */
// نماذج رفع الملفات (multipart): الرمز داخل النموذج ما ينقرأ إلا بعد استلام الملف، فيُفحص في المسار نفسه بعد الرفع.
// القائمة محددة بالاسم حتى ما يفلت أي مسار ثاني من الفحص.
const CSRF_AFTER_UPLOAD = new Set(['/admin/customers/import', '/handover']);

function csrfRejected(res) {
  res.status(403).render('error', { title: 'انتهت صلاحية الصفحة', message: 'انتهت صلاحية الصفحة. ارجع وحدّث الصفحة ثم حاول مرة ثانية.' });
}

/** فحص الرمز (للمسارات اللي تستلم ملف: بعد multer) */
function requireCsrf(req, res, next) {
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (safeEqual(sent, req.session.csrf)) return next();
  csrfRejected(res);
}

function csrfProtection(req, res, next) {
  res.locals.csrfToken = csrfToken(req);
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (CSRF_AFTER_UPLOAD.has(req.path) && /^multipart\/form-data/i.test(req.get('content-type') || '')) return next();
  requireCsrf(req, res, next);
}

// ---------- المستخدم الحالي والصلاحيات ----------

function loadUser(db) {
  return async (req, res, next) => {
    try {
      req.user = null;
      if (req.session && req.session.userId) {
        const user = await db.prepare('SELECT id, username, full_name, role, active, branch FROM users WHERE id = ?').get(req.session.userId);
        if (user && user.active) req.user = user;
        else delete req.session.userId; // الحساب أُوقف أو حُذف: تنتهي جلسته فوراً
      }
      res.locals.user = req.user;
      res.locals.roleLabel = req.user ? ROLE_LABELS[req.user.role] : '';
      next();
    } catch (err) { next(err); }
  };
}

/** الصفحة الأولى بعد الدخول: الفسوحات للكل */
function homeFor(user) {
  if (!user) return '/login';
  return '/documents';
}

function wantsHtml(req) {
  return req.method === 'GET' && !req.xhr && req.get('x-requested-with') !== 'fetch' && req.accepts(['html', 'json']) === 'html';
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (wantsHtml(req)) return res.redirect('/login');
  res.status(401).json({ ok: false, error: 'login_required' });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return requireLogin(req, res, next);
    if (roles.includes(req.user.role)) return next();
    res.status(403).render('error', { title: 'غير مسموح', message: 'هذه الصفحة للإدارة فقط.' });
  };
}

module.exports = {
  ROLE_LABELS,
  hashPassword,
  dummyCompare,
  validateNewPassword,
  validateUsername,
  sessionMiddleware,
  destroyUserSessions,
  flash,
  userKey,
  ipKey,
  IP_LOCK_AFTER_FAILS,
  lockRemainingMs,
  recordFailure,
  clearFailures,
  csrfProtection,
  requireCsrf,
  safeEqual,
  loadUser,
  homeFor,
  requireLogin,
  requireRole,
  bcrypt
};
