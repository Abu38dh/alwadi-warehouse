/**
 * واتساب والإرسال (نسخة فيرسيل) — نفس صفحات الموقع المحلي.
 * برنامج الواتساب على جهاز الشركة يرسل حالته ويسحب أوامر الإدارة (services/remote-engine.js).
 *
 *   /admin/whatsapp            الاتصال (الباركود) + المستندات اللي انرسلت أو تحتاج مراجعة
 *   /admin/whatsapp/settings   الإعدادات والرسائل
 *   /admin/whatsapp/customers  تقارير العملاء (الفواتير وكشوف الحساب)
 */
const express = require('express');
const auth = require('../auth');
const { audit } = require('../db');
const ec = require('../services/engine-client');
const notifications = require('../services/notifications');
const docs = require('../services/documents');

const WA_STATES = {
  connected: { label: 'متصل', tone: 'ok', text: 'واتساب الشركة متصل والإرسال شغال.' },
  qr_ready: { label: 'بانتظار مسح الباركود', tone: 'warn', text: 'امسح الباركود من جوال الشركة: واتساب ← الأجهزة المرتبطة ← ربط جهاز.' },
  reconnecting: { label: 'يعيد الاتصال', tone: 'warn', text: 'انقطع الاتصال لحظياً ويرجع لحاله. المستندات تنتظر وما تضيع.' },
  failed: { label: 'تعذر الاتصال', tone: 'bad', text: 'ما قدر يتصل بواتساب بعد عدة محاولات. اضغط "باركود جديد".' },
  waiting: { label: 'يتجهز', tone: 'warn', text: 'نظام الإرسال يتجهز للاتصال بواتساب…' }
};

const SHOW = {
  review: { label: 'ما انرسلت (تحتاج مراجعة)', match: (l) => !['sent', 'skipped', 'processing'].includes(l.status) },
  sent: { label: 'انرسلت', match: (l) => l.status === 'sent' },
  skipped: { label: 'موقوفة ونقدي', match: (l) => l.status === 'skipped' },
  all: { label: 'الكل', match: () => true }
};

const DOC_TYPES = [
  { id: 'invoice', label: 'الفواتير' },
  { id: 'clearance', label: 'الفسوحات' },
  { id: 'return', label: 'المرتجعات' },
  { id: 'statement', label: 'كشوف الحساب' }
];

function whatsappRouter({ db, engine }) {
  const router = express.Router();
  router.use(auth.requireRole('admin'));
  router.use((req, res, next) => (engine ? next() : res.status(404).render('error', { title: 'غير موجود', message: 'الصفحة أو المستند غير موجود.' })));
  // آخر حالة وصلت من البرنامج (للقوالب: engine.status())
  router.use(async (req, res, next) => { try { await engine.current(); next(); } catch (err) { next(err); } });

  const str = (v, max = 500) => String(v == null ? '' : v).trim().slice(0, max);

  /** تنفيذ إجراء ثم الرجوع برسالة واضحة */
  function action(handler) {
    return async (req, res) => {
      const back = req.get('x-back') || (str(req.body.back, 200).startsWith('/admin/whatsapp') ? str(req.body.back, 200) : '/admin/whatsapp');
      try {
        const msg = await handler(req);
        if (msg) auth.flash(req, msg.type || 'success', msg.text || msg);
      } catch (err) {
        if (!(err instanceof ec.EngineDown)) throw err;
        auth.flash(req, 'danger', err.message);
      }
      res.redirect(back);
    };
  }

  async function loadOverview() {
    try {
      const [st, logs, cash] = await Promise.all([ec.get(engine, '/api/status'), ec.get(engine, '/api/logs'), ec.get(engine, '/api/cash-pending')]);
      return { ok: true, status: st.json || {}, logs: Array.isArray(logs.json) ? logs.json : [], cash: (cash.json && cash.json.items) || [] };
    } catch (err) {
      if (err instanceof ec.EngineDown) return { ok: false, status: {}, logs: [], cash: [] };
      throw err;
    }
  }

  // ---------- الاتصال والمستندات ----------

  router.get('/', async (req, res) => {
    const data = await loadOverview();
    const show = SHOW[req.query.show] ? req.query.show : 'review';
    const counts = Object.fromEntries(Object.entries(SHOW).map(([k, s]) => [k, data.logs.filter(s.match).length]));
    res.set('Cache-Control', 'no-store');
    res.render('whatsapp', {
      title: 'واتساب والإرسال',
      tab: 'overview',
      engine: engine.status(),
      reachable: data.ok,
      wa: data.status,
      waState: WA_STATES[data.status.status] || WA_STATES.waiting,
      logs: data.logs.filter(SHOW[show].match).slice(0, 100),
      counts,
      shows: SHOW,
      show,
      cash: data.cash,
      // نفس مفتاح live.json (من السجل كامل، مو المعروض بس)
      logsKey: data.ok ? `${data.logs.length}:${data.logs[0] ? data.logs[0].id : ''}` : '',
      now: Date.now()
    });
  });

  // تحديث تلقائي للصفحة: حالة الاتصال والباركود + آخر تغيير في السجل
  router.get('/live.json', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const [st, logs] = await Promise.all([ec.get(engine, '/api/status'), ec.get(engine, '/api/logs')]);
      const s = st.json || {};
      const list = Array.isArray(logs.json) ? logs.json : [];
      res.json({ ok: true, status: s.status, label: (WA_STATES[s.status] || WA_STATES.waiting).label, phone: s.phone || '', qrSvg: s.status === 'qr_ready' ? s.qrSvg || '' : '', logsKey: `${list.length}:${list[0] ? list[0].id : ''}` });
    } catch (err) {
      if (!(err instanceof ec.EngineDown)) throw err;
      res.json({ ok: false, status: 'down', label: 'البرنامج يعيد التشغيل', logsKey: '' });
    }
  });

  router.post('/reset', action(async (req) => {
    await ec.post(engine, '/api/reset-whatsapp');
    await audit(db, { userId: req.user.id, action: 'whatsapp_reset', ip: req.ip });
    return 'تم فصل الجلسة القديمة. امسح الباركود الجديد من جوال الشركة (يطلع خلال ثواني).';
  }));

  router.post('/restart', action(async (req) => {
    await engine.restart(req.user.id);
    await audit(db, { userId: req.user.id, action: 'engine_restarted', ip: req.ip });
    return 'انرسل طلب إعادة التشغيل للبرنامج. الواتساب يرجع يتصل خلال دقيقة.';
  }));

  router.post('/retry', action(async (req) => {
    const override = str(req.body.customer_number, 20).replace(/[^0-9]/g, '');
    const r = await ec.post(engine, '/api/retry-document', { fileName: str(req.body.file_name), filePath: str(req.body.file_path, 1000), overrideCustomerNumber: override || null }, { timeoutMs: 120000 });
    const j = r.json || {};
    await audit(db, { userId: req.user.id, action: 'whatsapp_retry', details: `${str(req.body.file_name, 120)}${override ? ` → ${override}` : ''} ${j.success ? 'ok' : 'fail'}`, ip: req.ip });
    if (j.success) return 'تم إرسال المستند بنجاح.';
    const nums = Array.isArray(j.uniqueNumbers) && j.uniqueNumbers.length > 1 ? ` — الأرقام اللي لقيتها في المستند: ${j.uniqueNumbers.join('، ')}. اكتب الرقم الصحيح تحت المستند واضغط "أرسل لهذا الرقم".` : '';
    return { type: 'danger', text: `ما انرسل: ${j.message || 'تعذر الإرسال'}${nums}` };
  }));

  router.post('/not-clearance', action(async (req) => {
    const r = await ec.post(engine, '/api/send-stopped', { filePath: str(req.body.file_path, 1000) }, { timeoutMs: 120000 });
    const j = r.json || {};
    await audit(db, { userId: req.user.id, action: 'whatsapp_not_clearance', details: str(req.body.file_name, 120), ip: req.ip });
    return j.success ? 'انرسل المستند لقروب العميل.' : { type: 'danger', text: `ما انرسل: ${j.reason || j.message || 'تعذر الإرسال'}` };
  }));

  router.post('/dismiss', action(async (req) => {
    await ec.post(engine, '/api/dismiss-log', { id: str(req.body.id, 80), fileName: str(req.body.file_name) });
    return 'انشال من القائمة.';
  }));

  router.post('/cash-done', action(async (req) => {
    const r = await ec.post(engine, '/api/cash-done', { filePath: str(req.body.file_path, 1000) });
    return r.json && r.json.success ? 'تمام — انحسبت مطبوعة.' : { type: 'danger', text: (r.json && r.json.message) || 'تعذر' };
  }));

  // عرض مستند من البرنامج داخل عارض الموقع
  router.get('/view', (req, res) => {
    const file = str(req.query.file);
    const p = str(req.query.path, 1000);
    const qs = `file=${encodeURIComponent(file)}&path=${encodeURIComponent(p)}`;
    res.render('viewer', { title: file, viewer: { title: file, back: '/admin/whatsapp', backLabel: 'رجوع لواتساب والإرسال', src: `/admin/whatsapp/pdf-data?${qs}`, download: `/admin/whatsapp/pdf?${qs}` }, nav: 'whatsapp' });
  });

  router.get('/pdf-data', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const r = await ec.get(engine, `/api/document-data?file=${encodeURIComponent(str(req.query.file))}&path=${encodeURIComponent(str(req.query.path, 1000))}`, { timeoutMs: 30000 });
      if (!r.json || !r.json.success) return res.status(404).json({ ok: false, error: 'not_found' });
      res.json({ ok: true, size: r.json.size, base64: r.json.base64 });
    } catch (err) {
      if (!(err instanceof ec.EngineDown)) throw err;
      res.status(503).json({ ok: false, error: 'engine_down' });
    }
  });

  // تنزيل الملف نفسه
  router.get('/pdf', async (req, res) => {
    const file = str(req.query.file);
    try {
      const r = await ec.get(engine, `/api/document-data?file=${encodeURIComponent(file)}&path=${encodeURIComponent(str(req.query.path, 1000))}`, { timeoutMs: 30000 });
      if (!r.json || !r.json.success) return res.status(404).render('error', { title: 'غير موجود', message: 'الملف ما عاد موجود (يمكن انحذف بعد الإرسال).' });
      const name = (r.json.fileName || file || 'document.pdf').replace(/[\/:*?"<>|]/g, '_');
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.send(Buffer.from(r.json.base64, 'base64'));
    } catch (err) {
      if (!(err instanceof ec.EngineDown)) throw err;
      res.status(503).render('error', { title: 'نظام الإرسال', message: err.message });
    }
  });

  // ---------- الإعدادات ----------

  router.get('/settings', async (req, res) => {
    let settings = null;
    let warehouse = null;
    try {
      [settings, warehouse] = (await Promise.all([ec.get(engine, '/api/settings'), ec.get(engine, '/api/warehouse')])).map(r => r.json);
    } catch (err) { if (!(err instanceof ec.EngineDown)) throw err; }
    res.set('Cache-Control', 'no-store');
    res.render('whatsapp-settings', { title: 'إعدادات واتساب', tab: 'settings', engine: engine.status(), settings, warehouse, docTypes: DOC_TYPES });
  });

  router.post('/settings', action(async (req) => {
    const b = req.body;
    const sendDocTypes = {};
    for (const t of DOC_TYPES) sendDocTypes[t.id] = b[`send_${t.id}`] === '1';
    const branchNumbers = {};
    for (const [k, v] of Object.entries(b)) {
      if (k.startsWith('wh_branch_')) branchNumbers[str(decodeURIComponent(k.slice('wh_branch_'.length)), 40)] = str(v, 20);
    }
    const delaySec = Number(b.delay_seconds);
    const payload = {
      delayMs: Number.isFinite(delaySec) && delaySec >= 1 && delaySec <= 120 ? Math.round(delaySec * 1000) : undefined,
      testPhone: str(b.test_phone, 20),
      sendDocTypes,
      warehouse: { number: str(b.wh_number, 20), branchNumbers }
    };
    const r = await ec.post(engine, '/api/settings', payload);
    const j = r.json || {};
    await audit(db, { userId: req.user.id, action: 'whatsapp_settings', details: `test=${payload.testPhone ? 1 : 0} types=${Object.entries(sendDocTypes).filter(([, v]) => v).map(([k]) => k).join(',')}`, ip: req.ip });
    return j.success ? 'تم حفظ الإعدادات.' : { type: 'danger', text: `ما انحفظت: ${j.message || 'تعذر الحفظ'}` };
  }));

  // ---------- الرسائل (مكان واحد: مع المستند + حالة الطلب) ----------

  async function messagesPage(req, res, { config = null, error = null, status = 200 } = {}) {
    if (!config) config = await notifications.getConfig(db);
    let captions = null;
    try {
      const s = (await ec.get(engine, '/api/settings')).json;
      if (s) captions = { values: s.captions || {}, defaults: s.defaultCaptions || {} };
    } catch (err) { if (!(err instanceof ec.EngineDown)) throw err; }
    res.set('Cache-Control', 'no-store');
    res.status(status).render('whatsapp-messages', {
      title: 'الرسائل',
      tab: 'messages',
      engine: engine.status(),
      captions,
      docTypes: DOC_TYPES,
      config,
      error,
      events: notifications.EVENTS,
      eventLabels: notifications.EVENT_LABELS,
      stateLabels: notifications.STATE_LABELS,
      example: (text) => notifications.render(text, notifications.EXAMPLE_DOC),
      stats: await notifications.stats(db),
      recent: await notifications.listRecent(db, 20),
      docTitle: docs.docTitle,
      now: Date.now()
    });
  }

  router.get('/messages', (req, res) => messagesPage(req, res));

  router.post('/messages/captions', action(async (req) => {
    const captions = {};
    for (const t of DOC_TYPES) captions[t.id] = str(req.body[`caption_${t.id}`], 1000);
    const r = await ec.post(engine, '/api/settings', { captions });
    await audit(db, { userId: req.user.id, action: 'whatsapp_captions', ip: req.ip });
    return r.json && r.json.success ? 'تم حفظ نصوص المستندات.' : { type: 'danger', text: `ما انحفظت: ${(r.json && r.json.message) || 'تعذر الحفظ'}` };
  }));

  router.post('/messages/status', async (req, res) => {
    const input = { max_age_minutes: Number(req.body.max_age_minutes), events: {} };
    for (const ev of notifications.EVENTS) {
      input.events[ev] = { enabled: req.body[`enabled_${ev}`] === '1', text: String(req.body[`text_${ev}`] || '') };
    }
    try {
      await notifications.saveConfig(db, input);
    } catch (err) {
      if (!(err instanceof notifications.TemplateError)) throw err;
      // نرجع نفس الصفحة بالنصوص اللي كتبها مع سبب الرفض (ما يضيع اللي كتبه)
      return messagesPage(req, res, { config: input, error: err.message, status: 400 });
    }
    await audit(db, { userId: req.user.id, action: 'wa_messages_updated', details: notifications.EVENTS.filter(ev => input.events[ev].enabled).join(','), ip: req.ip });
    auth.flash(req, 'success', 'تم حفظ رسائل حالة الطلب.');
    res.redirect('/admin/whatsapp/messages');
  });

  // تقارير الفواتير: صفحتها في /admin/customers
  router.get('/customers', (req, res) => res.redirect(301, '/admin/customers'));
  router.get('/customers/:number', (req, res) => res.redirect(301, '/admin/customers/' + encodeURIComponent(str(req.params.number, 20))));

  return router;
}

module.exports = { whatsappRouter, WA_STATES };
