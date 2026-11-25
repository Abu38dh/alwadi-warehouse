/**
 * الدخول والخروج وإنشاء أول حساب إدارة.
 * لا يوجد تسجيل ذاتي: بعد أول حساب، الإدارة هي التي تنشئ الحسابات.
 */
const express = require('express');
const auth = require('../auth');
const { audit } = require('../db');

function authRouter({ config, db }) {
  const router = express.Router();
  const userCount = async (q = db) => (await q.prepare('SELECT COUNT(*) AS n FROM users').get()).n;

  /** بدء جلسة جديدة للمستخدم (معرّف جلسة جديد عند كل دخول) */
  function startSession(req, userId) {
    return new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) return reject(err);
        req.session.userId = userId;
        req.session.save(e => (e ? reject(e) : resolve()));
      });
    });
  }

  // ---------- أول حساب إدارة (متاح فقط ما دام الموقع بدون أي مستخدم) ----------

  const setupNeedsToken = () => config.production || !!config.setupToken;

  router.get('/setup', async (req, res) => {
    if (await userCount() > 0) return res.redirect('/login');
    res.render('setup', { title: 'إنشاء حساب الإدارة', error: null, values: {}, needsToken: setupNeedsToken() });
  });

  router.post('/setup', async (req, res) => {
    if (await userCount() > 0) return res.redirect('/login');
    const values = {
      full_name: String(req.body.full_name || '').trim().slice(0, 80),
      username: String(req.body.username || '').trim()
    };
    const password = String(req.body.password || '');
    const fail = (error, status = 400) => res.status(status).render('setup', { title: 'إنشاء حساب الإدارة', error, values, needsToken: setupNeedsToken() });

    if (setupNeedsToken()) {
      if (!config.setupToken) return fail('لازم تحط SETUP_TOKEN في ملف .env على السيرفر قبل إنشاء أول حساب.', 403);
      if (!auth.safeEqual(req.body.setup_token, config.setupToken)) return fail('رمز الإنشاء غير صحيح.', 403);
    }
    if (!values.full_name) return fail('اكتب الاسم.');
    const usernameError = auth.validateUsername(values.username);
    if (usernameError) return fail(usernameError);
    const passwordError = auth.validateNewPassword(config, password);
    if (passwordError) return fail(passwordError);
    if (password !== String(req.body.password2 || '')) return fail('كلمتا المرور غير متطابقتين.');

    const hash = await auth.hashPassword(config, password);
    // التأكد من جديد داخل عملية واحدة: حساب واحد فقط ينشأ بهذه الطريقة حتى لو وصل طلبان معاً
    const userId = await db.transaction(async (tx) => {
      if (await userCount(tx) > 0) return null;
      const info = await tx.prepare("INSERT INTO users (username, password_hash, full_name, role, active, created_at) VALUES (?, ?, ?, 'admin', 1, ?)")
        .run(values.username, hash, values.full_name, new Date().toISOString());
      return Number(info.lastInsertRowid);
    });
    if (!userId) return res.redirect('/login');

    await audit(db, { userId, action: 'setup_first_admin', details: values.username, ip: req.ip });
    await startSession(req, userId);
    res.redirect('/admin/integration');
  });

  // ---------- الدخول ----------

  router.get('/login', async (req, res) => {
    if (await userCount() === 0) return res.redirect('/setup');
    if (req.user) return res.redirect(auth.homeFor(req.user));
    res.render('login', { title: 'تسجيل الدخول', error: null, username: '' });
  });

  router.post('/login', async (req, res) => {
    const username = String(req.body.username || '').trim().slice(0, 64);
    const password = String(req.body.password || '').slice(0, 200);
    const uKey = auth.userKey(username);
    const iKey = auth.ipKey(req.ip);
    const fail = (error, status) => res.status(status).render('login', { title: 'تسجيل الدخول', error, username });
    const lockedMessage = (ms) => `محاولات كثيرة خاطئة. الدخول مقفل مؤقتاً، حاول بعد ${Math.max(1, Math.ceil(ms / 60000))} دقيقة.`;

    const locked = Math.max(await auth.lockRemainingMs(db, uKey), await auth.lockRemainingMs(db, iKey));
    if (locked > 0) return fail(lockedMessage(locked), 429);

    const user = username ? await db.prepare('SELECT * FROM users WHERE username = ?').get(username) : null;
    const ok = user && user.active
      ? await auth.bcrypt.compare(password, user.password_hash)
      : await auth.dummyCompare(config, password);

    if (!ok) {
      const nowLocked = await auth.recordFailure(db, config, uKey);
      const ipLocked = await auth.recordFailure(db, config, iKey, auth.IP_LOCK_AFTER_FAILS);
      await audit(db, { userId: user ? user.id : null, action: 'login_failed', details: username, ip: req.ip });
      if (nowLocked || ipLocked) return fail(lockedMessage(config.lockMs), 429);
      return fail('اسم المستخدم أو كلمة المرور غير صحيحة.', 401);
    }

    // انقفل أثناء التحقق (محاولات خاطئة بنفس اللحظة): حتى الكلمة الصحيحة تنتظر
    const lockedNow = Math.max(await auth.lockRemainingMs(db, uKey), await auth.lockRemainingMs(db, iKey));
    if (lockedNow > 0) return fail(lockedMessage(lockedNow), 429);

    await auth.clearFailures(db, uKey);
    await startSession(req, user.id);
    await audit(db, { userId: user.id, action: 'login', ip: req.ip });
    res.redirect(auth.homeFor(user));
  });

  router.post('/logout', (req, res, next) => {
    const userId = req.user ? req.user.id : null;
    req.session.destroy(async (err) => {
      if (err) return next(err);
      try { if (userId) await audit(db, { userId, action: 'logout', ip: req.ip }); } catch (_) {}
      res.clearCookie('wh.sid');
      res.redirect('/login');
    });
  });

  return router;
}

module.exports = { authRouter };
