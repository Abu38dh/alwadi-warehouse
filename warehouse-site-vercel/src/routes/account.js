/**
 * حسابي: تغيير كلمة المرور.
 */
const express = require('express');
const auth = require('../auth');
const { audit } = require('../db');
const people = require('../services/people');

function accountRouter({ config, db }) {
  const router = express.Router();
  router.use(auth.requireLogin);

  router.get('/', (req, res) => {
    res.render('account', { title: 'حسابي' });
  });

  router.post('/password', async (req, res) => {
    const fail = (message) => { auth.flash(req, 'danger', message); res.redirect('/account'); };
    const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!await auth.bcrypt.compare(String(req.body.current_password || ''), row.password_hash)) {
      await audit(db, { userId: req.user.id, action: 'password_change_failed', ip: req.ip });
      return fail('كلمة المرور الحالية غير صحيحة.');
    }
    const password = String(req.body.password || '');
    if (password !== String(req.body.password2 || '')) return fail('كلمتا المرور الجديدتان غير متطابقتين.');
    try {
      await people.setPassword(db, config, { id: req.user.id, password });
    } catch (err) {
      if (!(err instanceof people.PeopleError)) throw err;
      return fail(err.message);
    }
    // أي جهاز ثاني داخل بنفس الحساب يطلع؛ هذا الجهاز يبقى
    await auth.destroyUserSessions(db, req.user.id, req.sessionID);
    await audit(db, { userId: req.user.id, action: 'password_changed', ip: req.ip });
    auth.flash(req, 'success', 'تم تغيير كلمة المرور.');
    res.redirect('/account');
  });

  return router;
}

module.exports = { accountRouter };
