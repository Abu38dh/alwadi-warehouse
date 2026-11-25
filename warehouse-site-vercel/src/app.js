/**
 * تجميع الموقع: الحماية، الجلسات، المسارات.
 * createApp يُستخدم من server.js ومن الاختبارات (بقاعدة ومجلد بيانات مؤقتين).
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const auth = require('./auth');
const { integrationRouter } = require('./routes/integration');
const { authRouter } = require('./routes/auth');
const { documentsRouter } = require('./routes/documents');
const { adminRouter } = require('./routes/admin');
const { handoverRouter } = require('./routes/handover');
const { accountRouter } = require('./routes/account');
const { relayRouter } = require('./routes/relay');
const { whatsappRouter } = require('./routes/whatsapp');
const { RemoteEngine } = require('./services/remote-engine');
const { stageText, countsByStatus, userBranch } = require('./services/documents');
const icons = require('./services/icons');
const notifications = require('./services/notifications');
const time = require('./services/time');

const ROOT = path.join(__dirname, '..');

/** بصمة قصيرة لملفات public/css و public/js */
function assetVersion() {
  const fs = require('fs');
  const h = require('crypto').createHash('sha1');
  for (const dir of ['css', 'js']) {
    const d = path.join(ROOT, 'public', dir);
    let files = [];
    try { files = fs.readdirSync(d).sort(); } catch (_) {}
    for (const f of files) { try { h.update(f); h.update(fs.readFileSync(path.join(d, f))); } catch (_) {} }
  }
  return h.digest('hex').slice(0, 10);
}

/**
 * نسخة فيرسيل: واتساب ما يشتغل داخل الموقع — برنامج الإرسال على جهاز الشركة يتصل بالموقع بمفتاح الربط.
 * @param {object} o
 */
function createApp({ config, db }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));

  // دوال العرض المتاحة لكل الصفحات
  app.locals.formatRiyadh = time.formatRiyadh;
  app.locals.formatWhen = time.formatWhen;
  app.locals.formatStep = time.formatStep;
  app.locals.formatLongDay = time.formatLongDay;
  app.locals.durationSince = time.durationSince;
  app.locals.minutesText = time.minutesText;
  app.locals.timeAgoAr = time.timeAgoAr;
  app.locals.stageText = stageText;
  app.locals.greeting = time.greeting;
  app.locals.formatTime = time.formatTime;
  app.locals.icon = icons.icon;
  app.locals.eventIcon = icons.eventIcon;
  app.locals.STATUS_ICONS = icons.STATUS_ICONS;
  app.locals.navCounts = null;
  app.locals.user = null;
  app.locals.roleLabel = '';
  app.locals.csrfToken = '';
  app.locals.flash = null;
  // صفحات "واتساب والإرسال": برنامج الواتساب على جهاز الشركة (عن بعد)
  const engine = new RemoteEngine(db);
  app.locals.engineEnabled = true;
  app.locals.waAlert = false;
  // رقم نسخة ملفات الشكل والسكربت: يتغير مع أي تعديل فيها، فالمتصفح ياخذ الجديد بدل اللي محفوظ عنده
  app.locals.assetVersion = assetVersion();

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // 'wasm-unsafe-eval': عارض الـ PDF يستخدم WebAssembly لبعض أنواع الصور (لا يسمح بتنفيذ نص JavaScript)
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        // زر "طباعة الفسح": الملف يتحمّل في إطار مخفي من نسخة داخل الصفحة (blob)
        frameSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.production ? { upgradeInsecureRequests: [] } : {})
      }
    },
    strictTransportSecurity: config.production ? { maxAge: 15552000, includeSubDomains: false } : false,
    referrerPolicy: { policy: 'same-origin' }
  }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  const staticOptions = { maxAge: config.production ? '1d' : 0, index: false };
  // مكتبة عرض الـ PDF (pdf.js) من node_modules: الملفات اللازمة للعارض فقط
  const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  for (const sub of ['legacy/build', 'cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    app.use(`/static/vendor/pdfjs/${sub}`, express.static(path.join(pdfjsDir, sub), staticOptions));
  }
  app.use('/static', express.static(path.join(ROOT, 'public'), staticOptions));

  // واجهة برنامج الإرسال: بمفتاح الربط، بدون جلسات ولا كوكيز
  app.use('/api/integration', integrationRouter({ config, db }));
  // أجهزة الفروع البعيدة: بمفتاح الجهاز، بدون جلسات
  app.use('/api/relay', relayRouter({ config, db }));

  const sessions = auth.sessionMiddleware(config, db);
  app.locals.sessionStore = sessions.store;
  app.use(sessions.middleware);
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(auth.loadUser(db));
  app.use(auth.csrfProtection);

  // أعداد القائمة (الجديدة / الجاهزة) لصفحات المستخدم المسجّل
  app.use(async (req, res, next) => {
    try {
      res.locals.navCounts = req.user && req.method === 'GET' ? await countsByStatus(db, userBranch(req.user)) : null;
      // نقطة حمراء على واتساب في القائمة: بس لما واتساب فعلاً يحتاج تدخل
      res.locals.waAlert = false;
      if (req.user && req.user.role === 'admin' && req.method === 'GET') {
        // برنامج الإرسال على جهاز الشركة: من آخر نبضة وصلت منه
        const st = (await notifications.programStatus(db)).state;
        res.locals.waAlert = st === 'wa_down' || st === 'offline';
      }
      next();
    } catch (err) { next(err); }
  });

  // رسالة تظهر مرة واحدة بعد إعادة التوجيه (طلبات التحديث التلقائي من السكربت لا تستهلكها)
  app.use((req, res, next) => {
    res.locals.flash = null;
    if (req.session.flash && req.get('x-requested-with') !== 'fetch') {
      res.locals.flash = req.session.flash;
      delete req.session.flash;
    }
    next();
  });

  app.get('/', (req, res) => res.redirect(auth.homeFor(req.user)));
  app.use(authRouter({ config, db }));
  // لوحة الإدارة انشالت: الروابط القديمة تفتح الفسوحات
  app.get('/dashboard', (req, res) => res.redirect(auth.homeFor(req.user)));
  app.use('/documents', documentsRouter({ config, db }));
  app.use('/handover', handoverRouter({ config, db }));
  app.use('/account', accountRouter({ config, db }));
  app.use('/admin/whatsapp', whatsappRouter({ db, engine }));
  app.use('/admin', adminRouter({ config, db, engine }));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'غير موجود', message: 'الصفحة أو المستند غير موجود.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('خطأ غير متوقع:', err);
    if (res.headersSent) return res.end();
    res.status(500).render('error', { title: 'خطأ', message: 'حصل خطأ غير متوقع. حاول مرة ثانية.' });
  });

  return app;
}

module.exports = { createApp };
