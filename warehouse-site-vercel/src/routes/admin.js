/**
 * صفحات الإدارة: المستخدمون، الموصلون، الربط مع برنامج الإرسال (مفتاح الربط).
 */
const express = require('express');
const multer = require('multer');
const auth = require('../auth');
const { audit } = require('../db');
const integration = require('../services/integration');
const people = require('../services/people');
const notifications = require('../services/notifications');
const docs = require('../services/documents');
const branches = require('../services/branches');
const installer = require('../services/installer');
const reports = require('../services/reports');
const customerReport = require('../services/customer-report');
const { buildXlsx } = require('../services/xlsx-writer');
const { formatRiyadh } = require('../services/time');

function adminRouter({ config, db, engine = null }) {
  const router = express.Router();
  router.use(auth.requireRole('admin'));

  const parseId = (value) => {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : 0;
  };

  /** تنفيذ تعديل ثم الرجوع للصفحة برسالة نجاح أو سبب الرفض */
  function action(backTo, handler) {
    return async (req, res) => {
      try {
        auth.flash(req, 'success', await handler(req));
      } catch (err) {
        if (!(err instanceof people.PeopleError)) throw err;
        auth.flash(req, 'danger', err.message);
      }
      res.redirect(backTo);
    };
  }

  // ---------- المستخدمون ----------

  router.get('/users', async (req, res) => {
    res.render('admin-users', { title: 'حسابات الدخول', users: await people.listUsers(db), roleLabels: auth.ROLE_LABELS, branchNames: await docs.knownBranches(db) });
  });

  router.post('/users', action('/admin/users', async (req) => {
    if (String(req.body.password || '') !== String(req.body.password2 || '')) throw new people.PeopleError('كلمتا المرور غير متطابقتين.');
    const id = await people.createUser(db, config, { username: req.body.username, fullName: req.body.full_name, role: req.body.role, password: req.body.password, branch: req.body.branch });
    await audit(db, { userId: req.user.id, action: 'user_created', details: `#${id} ${String(req.body.username).trim()} (${req.body.role})`, ip: req.ip });
    return 'تم إنشاء الحساب.';
  }));

  router.post('/users/:id', action('/admin/users', async (req) => {
    const id = parseId(req.params.id);
    const active = req.body.active === '1';
    const result = await people.updateUser(db, { id, fullName: req.body.full_name, role: req.body.role, active, actingUserId: req.user.id, branch: req.body.branch });
    if (result.deactivated) await auth.destroyUserSessions(db, id);
    await audit(db, { userId: req.user.id, action: 'user_updated', details: `#${id} role=${req.body.role} active=${active ? 1 : 0} branch=${req.body.branch === undefined ? '-' : req.body.branch}`, ip: req.ip });
    return 'تم حفظ التعديل.';
  }));

  router.post('/users/:id/password', action('/admin/users', async (req) => {
    const id = parseId(req.params.id);
    if (String(req.body.password || '') !== String(req.body.password2 || '')) throw new people.PeopleError('كلمتا المرور غير متطابقتين.');
    await people.setPassword(db, config, { id, password: req.body.password });
    // صاحب الحساب يطلع من كل الأجهزة ويدخل بالكلمة الجديدة (ما عدا لو الإدارة غيّرت كلمتها هي)
    await auth.destroyUserSessions(db, id, id === req.user.id ? req.sessionID : '');
    await audit(db, { userId: req.user.id, action: 'user_password_reset', details: `#${id}`, ip: req.ip });
    return 'تم تغيير كلمة المرور.';
  }));

  // ---------- الموصلون ----------

  router.get('/couriers', async (req, res) => {
    res.render('admin-couriers', { title: 'الموظفون والموصلون', couriers: await people.listCouriers(db), workers: await people.listWorkers(db), branchNames: await docs.knownBranches(db) });
  });

  // ---------- الموظفون (اللي يجهّزون الطلبات) ----------

  router.post('/workers', action('/admin/couriers', async (req) => {
    const id = await people.createWorker(db, { name: req.body.name, branch: req.body.branch });
    await audit(db, { userId: req.user.id, action: 'worker_created', details: `#${id}`, ip: req.ip });
    return 'تمت إضافة الموظف.';
  }));

  router.post('/workers/:id', action('/admin/couriers', async (req) => {
    const id = parseId(req.params.id);
    const active = req.body.active === '1';
    await people.updateWorker(db, { id, name: req.body.name, active, branch: req.body.branch });
    await audit(db, { userId: req.user.id, action: 'worker_updated', details: `#${id} active=${active ? 1 : 0}`, ip: req.ip });
    return 'تم حفظ التعديل.';
  }));

  router.post('/couriers', action('/admin/couriers', async (req) => {
    const id = await people.createCourier(db, { name: req.body.name, phone: req.body.phone, branch: req.body.branch });
    await audit(db, { userId: req.user.id, action: 'courier_created', details: `#${id}`, ip: req.ip });
    return 'تمت إضافة الموصل.';
  }));

  router.post('/couriers/:id', action('/admin/couriers', async (req) => {
    const id = parseId(req.params.id);
    const active = req.body.active === '1';
    await people.updateCourier(db, { id, name: req.body.name, phone: req.body.phone, active, branch: req.body.branch });
    await audit(db, { userId: req.user.id, action: 'courier_updated', details: `#${id} active=${active ? 1 : 0}`, ip: req.ip });
    return 'تم حفظ التعديل.';
  }));

  // ---------- رسائل العميل في واتساب ----------

  async function messagesPage(res, { config, error = null, status = 200 }) {
    const [stats, program, recent] = await Promise.all([notifications.stats(db), notifications.programStatus(db), notifications.listRecent(db, 30)]);
    res.status(status).render('admin-messages', {
      title: 'رسائل العملاء',
      config,
      error,
      events: notifications.EVENTS,
      eventLabels: notifications.EVENT_LABELS,
      stateLabels: notifications.STATE_LABELS,
      example: (text) => notifications.render(text, notifications.EXAMPLE_DOC),
      stats,
      program,
      recent,
      docTitle: docs.docTitle,
      now: Date.now()
    });
  }

  // كل الرسائل في مكان واحد تحت "واتساب والإرسال"
  router.use('/messages', (req, res, next) => (engine ? res.redirect(303, '/admin/whatsapp/messages') : next()));

  router.get('/messages', async (req, res) => messagesPage(res, { config: await notifications.getConfig(db) }));

  router.post('/messages', async (req, res) => {
    const input = { max_age_minutes: Number(req.body.max_age_minutes), events: {} };
    for (const ev of notifications.EVENTS) {
      input.events[ev] = { enabled: req.body[`enabled_${ev}`] === '1', text: String(req.body[`text_${ev}`] || '') };
    }
    try {
      await notifications.saveConfig(db, input);
    } catch (err) {
      if (!(err instanceof notifications.TemplateError)) throw err;
      // نرجع نفس الصفحة بالنصوص اللي كتبها مع سبب الرفض (ما يضيع اللي كتبه)
      return messagesPage(res, { config: input, error: err.message, status: 400 });
    }
    await audit(db, { userId: req.user.id, action: 'wa_messages_updated', details: notifications.EVENTS.filter(ev => input.events[ev].enabled).join(','), ip: req.ip });
    auth.flash(req, 'success', 'تم حفظ رسائل العملاء.');
    res.redirect('/admin/messages');
  });

  // ---------- أجهزة المحاسبين (ملف تركيب الطابعة لكل فرع) ----------

  const siteUrlOf = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;

  async function branchesPage(req, res, { error = null, status = 200 } = {}) {
    res.set('Cache-Control', 'no-store');
    const [devices, mainBranch, installBranches] = await Promise.all([branches.listDevices(db), branches.mainBranchName(db), branches.installBranches(db)]);
    res.status(status).render('admin-branches', {
      title: 'أجهزة المحاسبين',
      devices,
      mainBranch,
      installBranches,
      installerReady: installer.installerReady(config),
      mainInstallerReady: !!installer.mainInstaller(),
      mainOnline: engine ? (await engine.current()).online : null,
      siteUrl: siteUrlOf(req),
      // الفرع اللي ضغط "تعديل" عنده (تنفتح خانة التعديل تحت سطره بس)
      editing: String((req.query && req.query.edit) || '').trim().slice(0, 60),
      error,
      now: Date.now()
    });
  }

  router.get('/branches', async (req, res) => branchesPage(req, res));

  // ملف تركيب الطابعة لفرع: نفس الملف + عنوان الموقع ومفتاح الفرع
  router.get('/branches/installer', async (req, res) => {
    const branch = String(req.query.branch || '').trim();
    if (!installer.installerReady(config)) {
      auth.flash(req, 'danger', 'ملف الطابعة غير موجود على السيرفر.');
      return res.redirect(303, '/admin/branches');
    }
    let installKey;
    try { installKey = await branches.installKeyFor(db, branch); } catch (err) {
      if (!(err instanceof branches.BranchError)) throw err;
      auth.flash(req, 'danger', err.message);
      return res.redirect(303, '/admin/branches');
    }
    await audit(db, { userId: req.user.id, action: 'printer_installer_downloaded', details: branch, ip: req.ip });
    const cfg = { siteUrl: siteUrlOf(req), installKey, branch };
    // فيرسيل: نسخة الفرع على Blob والمتصفح يتحوّل لها (الملف أكبر من حد فيرسيل)
    if (installer.blobConfigured(config)) return res.redirect(302, await installer.blobInstallerUrl(db, config, cfg));
    installer.sendInstaller(res, config.printerInstaller, cfg, `تركيب الطابعة - فرع ${branch}.exe`);
  });

  // برنامج الواتساب للجهاز الرئيسي: ملف تثبيت فيه مفتاح ربط جديد (يتفعّل أول ما يتصل الجهاز الجديد، والقديم يتوقف وقتها)
  router.get('/branches/main-installer', async (req, res) => {
    if (!installer.mainInstaller()) {
      auth.flash(req, 'danger', 'برنامج الواتساب ما انرفع على الموقع.');
      return res.redirect(303, '/admin/branches');
    }
    const apiKey = await integration.prepareNextKey(db, req.user.id);
    await audit(db, { userId: req.user.id, action: 'main_installer_downloaded', ip: req.ip });
    installer.sendMainInstaller(res, { siteUrl: siteUrlOf(req), apiKey });
  });

  router.post('/branches/add', action('/admin/branches', async (req) => {
    try {
      const name = await branches.addInstallBranch(db, req.body.name);
      await audit(db, { userId: req.user.id, action: 'branch_added', details: name, ip: req.ip });
      return `تمت إضافة فرع ${name}.`;
    } catch (err) {
      if (err instanceof branches.BranchError) throw new people.PeopleError(err.message);
      throw err;
    }
  }));

  router.post('/branches/rotate', action('/admin/branches', async (req) => {
    try {
      const name = await branches.rotateInstallKey(db, req.body.branch);
      await audit(db, { userId: req.user.id, action: 'branch_installer_rotated', details: name, ip: req.ip });
      return `ملف فرع ${name} القديم وقف. حمّل الملف الجديد للأجهزة الجديدة.`;
    } catch (err) {
      if (err instanceof branches.BranchError) throw new people.PeopleError(err.message);
      throw err;
    }
  }));

  router.post('/branches/main', action('/admin/branches', async (req) => {
    try {
      const name = await branches.setMainBranchName(db, req.body.name);
      await audit(db, { userId: req.user.id, action: 'main_branch_set', details: name, ip: req.ip });
      return 'تم حفظ اسم الفرع الرئيسي.';
    } catch (err) {
      if (err instanceof branches.BranchError) throw new people.PeopleError(err.message);
      throw err;
    }
  }));

  router.post('/branches/:id/branch', action('/admin/branches', async (req) => {
    const id = parseId(req.params.id);
    try {
      const name = await branches.setDeviceBranch(db, id, req.body.branch);
      await audit(db, { userId: req.user.id, action: 'branch_device_moved', details: `#${id} → ${name}`, ip: req.ip });
      return `الجهاز صار على فرع ${name}.`;
    } catch (err) {
      if (err instanceof branches.BranchError) throw new people.PeopleError(err.message);
      throw err;
    }
  }));

  router.post('/branches/:id/active', action('/admin/branches', async (req) => {
    const id = parseId(req.params.id);
    const active = req.body.active === '1';
    try { await branches.setActive(db, id, active); } catch (err) {
      if (err instanceof branches.BranchError) throw new people.PeopleError(err.message);
      throw err;
    }
    await audit(db, { userId: req.user.id, action: 'branch_device_active', details: `#${id} active=${active ? 1 : 0}`, ip: req.ip });
    return active ? 'تم تشغيل الجهاز.' : 'تم إيقاف الجهاز — ما يقدر يرسل شيء لين تشغّله.';
  }));

  // ---------- التقارير ----------

  /** الفترة والفرع من الرابط (الفرع لازم يكون معروف) */
  async function reportInput(req) {
    const wanted = String(req.query.branch || '').trim();
    const branchNames = await docs.knownBranches(db);
    const branch = wanted && branchNames.includes(wanted) ? wanted : null;
    let period;
    let error = null;
    try {
      period = reports.resolvePeriod(req.query);
    } catch (err) {
      if (!(err instanceof reports.ReportError)) throw err;
      error = err.message;
      period = reports.resolvePeriod({});
    }
    return { branch, branchNames, period, error };
  }

  router.get('/reports', async (req, res) => {
    const { branch, branchNames, period, error } = await reportInput(req);
    res.set('Cache-Control', 'no-store');
    res.render('reports', {
      title: 'التقارير',
      r: await reports.buildReport(db, period, branch),
      periods: reports.PERIODS,
      branchNames,
      error,
      statusLabels: docs.STATUS_LABELS,
      now: Date.now()
    });
  });

  // ملف Excel: كل فسح وصل في الفترة بصف واحد
  router.get('/reports/export.xlsx', async (req, res) => {
    const { branch, period, error } = await reportInput(req);
    if (error) { auth.flash(req, 'danger', error); return res.redirect('/admin/reports'); }
    const report = await reports.buildReport(db, period, branch);
    const sheet = reports.excelRows(report, docs.STATUS_LABELS, formatRiyadh);
    const range = period.fromDay === period.toDay ? period.fromDay : `${period.fromDay} - ${period.toDay}`;
    const buf = buildXlsx({
      sheetName: 'الفسوحات',
      title: `تقرير المستودع — ${range}${branch ? ` — فرع ${branch}` : ''}`,
      headers: sheet.headers,
      rows: sheet.rows,
      widths: sheet.widths,
      textColumns: [0, 2]
    });
    const name = `تقرير-المستودع-${period.fromDay}${period.toDay !== period.fromDay ? `_${period.toDay}` : ''}${branch ? `-${branch}` : ''}.xlsx`;
    await audit(db, { userId: req.user.id, action: 'report_exported', details: `${range}${branch ? ` ${branch}` : ''} (${sheet.rows.length})`, ip: req.ip });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store'
    });
    res.send(buf);
  });

  // ---------- تقارير الفواتير والعملاء (البيانات من برنامج الواتساب على جهاز الشركة) ----------

  const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
  const dayParam = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v, 10)) ? str(v, 10) : '');

  const CUSTOMER_FILTERS = {
    all: { label: 'الكل', match: () => true },
    ordered: { label: 'طلبوا فواتير', match: (r) => r.invoices > 0 },
    notOrdered: { label: 'ما طلبوا', match: (r) => r.known && r.invoices === 0 },
    statementSent: { label: 'انرسل لهم كشف', match: (r) => r.statementsSent > 0 },
    statementNotSent: { label: 'ما انرسل لهم كشف', match: (r) => r.known && r.statementsSent === 0 },
    problems: { label: 'فيها مشكلة', match: (r) => r.problems > 0 }
  };
  // مفتاح المندوب: رمزه، ولو ما له رمز => اسمه (عشان "الكل" والمندوب بدون رمز ما يصيرون نفس الشي)
  const repKey = (code, name) => (code ? String(code) : (name ? 'n:' + String(name) : ''));
  const rowRepKey = (r) => repKey(r.repCode, r.repName);

  async function customerReportFor(req) {
    const snap = await customerReport.loadSnapshot(db);
    if (!snap) return null;
    return customerReport.buildReport(snap, { from: dayParam(req.query.from), to: dayParam(req.query.to) });
  }

  function filterCustomerRows(rep, req) {
    const f = CUSTOMER_FILTERS[req.query.filter] ? req.query.filter : 'all';
    const q = str(req.query.q, 20).replace(/[^0-9]/g, '');
    const repSel = str(req.query.rep, 80);
    let rows = (rep.rows || []).filter(r => CUSTOMER_FILTERS[f].match(r) && (!repSel || rowRepKey(r) === repSel));
    if (q) {
      // رقم عميل كامل (0004 أو 1854) => هذا العميل بس. جزء من رقم (4) => كل رقم فيه هذا الجزء
      const noZeros = (v) => String(v).replace(/^0+(?=\d)/, '');
      const same = rows.filter(r => String(r.number) === q);
      if (q.startsWith('0')) rows = same.length ? same : rows.filter(r => noZeros(r.number) === noZeros(q));
      else rows = q.length >= 4 && same.length ? same : rows.filter(r => String(r.number).includes(q));
    }
    return { f, rows };
  }

  router.get('/customers', async (req, res) => {
    const [rep, info, importInfo, proposal] = await Promise.all([customerReportFor(req), customerReport.meta(db), customerReport.importState(db), customerReport.proposalWithDiff(db)]);
    const { f, rows } = rep ? filterCustomerRows(rep, req) : { f: 'all', rows: [] };
    const repSel = str(req.query.rep, 80);
    const base = rep ? (rep.rows || []).filter(r => !repSel || rowRepKey(r) === repSel) : [];
    const repOptions = rep ? (rep.reps || []).map(r => ({ key: repKey(r.code, r.name), name: r.name || r.code })).filter(o => o.key) : [];
    const filterCounts = Object.fromEntries(Object.keys(CUSTOMER_FILTERS).map(k => [k, base.filter(CUSTOMER_FILTERS[k].match).length]));
    res.set('Cache-Control', 'no-store');
    if (engine) await engine.current();
    res.render('customers', { title: 'تقارير الفواتير', tab: 'customers', engine: engine ? engine.status() : { running: true }, rep, info, importInfo, proposal, rows, filters: CUSTOMER_FILTERS, filterCounts, repOptions, filter: f, query: req.query, now: Date.now() });
  });

  // رفع قائمة العملاء (PDF أو CSV من نظام المحاسبة): الموقع يحفظه وبرنامج الواتساب يقرأه مع النبضة الجاية
  const customersUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 5 } });
  router.post('/customers/import', (req, res, next) => {
    customersUpload.single('file')(req, res, (err) => {
      if (err) { req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف كبير (الحد 4 ميقا).' : 'تعذر استلام الملف، حاول مرة ثانية.'; }
      next();
    });
  }, auth.requireCsrf, async (req, res) => {
    try {
      if (req.uploadError) throw new customerReport.ImportError(req.uploadError);
      if (!req.file) throw new customerReport.ImportError('اختر ملف قائمة العملاء (PDF أو CSV).');
      // multer يقرأ اسم الملف latin1: نرجعه UTF-8 (الأسماء العربية)
      const name = Buffer.from(req.file.originalname || 'customers', 'latin1').toString('utf8');
      await customerReport.queueImport(db, { buffer: req.file.buffer, name, userId: req.user.id });
      await audit(db, { userId: req.user.id, action: 'customers_import_uploaded', details: name.slice(0, 100), ip: req.ip });
    } catch (err) {
      if (!(err instanceof customerReport.ImportError)) throw err;
      auth.flash(req, 'danger', err.message);
    }
    res.redirect('/admin/customers');
  });

  // "موافق": القائمة اللي شافتها الإدارة تنحفظ. "إلغاء": ما يتغير شي
  router.post('/customers/import/approve', async (req, res) => {
    try {
      const p = await customerReport.approveProposal(db, req.user.id);
      await audit(db, { userId: req.user.id, action: 'customers_import_approved', details: p.name.slice(0, 100), ip: req.ip });
    } catch (err) {
      if (!(err instanceof customerReport.ImportError)) throw err;
      auth.flash(req, 'danger', err.message);
    }
    res.redirect('/admin/customers');
  });

  router.post('/customers/import/cancel', async (req, res) => {
    if (await customerReport.cancelProposal(db)) {
      await audit(db, { userId: req.user.id, action: 'customers_import_cancelled', ip: req.ip });
      auth.flash(req, 'success', 'انلغى. القائمة ما تغيّرت.');
    }
    res.redirect('/admin/customers');
  });

  router.get('/customers/export.xlsx', async (req, res) => {
    const rep = await customerReportFor(req);
    if (!rep) { auth.flash(req, 'danger', 'بيانات التقرير ما وصلت من برنامج الواتساب للحين.'); return res.redirect('/admin/customers'); }
    const { rows } = filterCustomerRows(rep, req);
    const buf = buildXlsx({
      sheetName: 'العملاء',
      title: `تقرير العملاء — ${rep.from} إلى ${rep.to}`,
      headers: ['رقم العميل', 'المندوب', 'في القائمة', 'فواتير', 'فواتير انرسلت', 'مرتجعات', 'كشوف انرسلت', 'ما انرسلت', 'نقدي', 'آخر مستند', 'له قروب'],
      rows: rows.map(r => [r.number, r.repName || '', r.known ? 'نعم' : 'لا', r.invoices, r.invoicesSent, r.returns, r.statementsSent, r.problems, r.cash, r.lastAt ? formatRiyadh(r.lastAt) : '', r.hasGroup == null ? '' : (r.hasGroup ? 'نعم' : 'لا')]),
      widths: [12, 18, 10, 9, 12, 9, 12, 10, 8, 17, 9],
      textColumns: [0]
    });
    await audit(db, { userId: req.user.id, action: 'customers_report_exported', details: `${rep.from} - ${rep.to} (${rows.length})`, ip: req.ip });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="customers.xlsx"; filename*=UTF-8''${encodeURIComponent(`تقرير-العملاء-${rep.from}_${rep.to}.xlsx`)}`,
      'Cache-Control': 'no-store'
    });
    res.send(buf);
  });

  router.get('/customers/:number', async (req, res, next) => {
    const number = str(req.params.number, 20).replace(/[^0-9]/g, '');
    if (!number) return next();
    const snap = await customerReport.loadSnapshot(db);
    res.render('customer', { title: `العميل ${number}`, number, data: snap ? customerReport.customerHistory(snap, number) : null });
  });

  // ---------- الربط مع البرنامج ----------

  const siteUrl = (req) => `${req.protocol}://${req.get('host')}`;

  router.get('/integration', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.render('integration', { title: 'الربط مع البرنامج', info: await integration.getInfo(db), newKey: null, siteUrl: siteUrl(req) });
  });

  // إنشاء مفتاح جديد: يظهر مرة واحدة فقط، والمفتاح السابق يتوقف فوراً
  router.post('/integration/rotate', async (req, res) => {
    const newKey = await integration.rotateKey(db, req.user.id);
    await audit(db, { userId: req.user.id, action: 'integration_key_rotated', ip: req.ip });
    res.set('Cache-Control', 'no-store');
    res.render('integration', { title: 'الربط مع البرنامج', info: await integration.getInfo(db), newKey, siteUrl: siteUrl(req) });
  });

  return router;
}

module.exports = { adminRouter };
