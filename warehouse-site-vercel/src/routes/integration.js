/**
 * واجهة الربط مع برنامج الإرسال (البرنامج هو الذي يتصل دائماً).
 * كل الطلبات بمفتاح: Authorization: Bearer <API_KEY>
 */
const express = require('express');
const multer = require('multer');
const integration = require('../services/integration');
const { ingestDocument, IngestError, knownBranches } = require('../services/documents');
const notifications = require('../services/notifications');
const attachments = require('../services/attachments');
const branches = require('../services/branches');
const customerReport = require('../services/customer-report');
const remoteEngine = require('../services/remote-engine');

function integrationRouter({ config, db }) {
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxPdfBytes, files: 1, fields: 5, fieldSize: 64 * 1024, parts: 8 }
  });

  // المفتاح يُفحص قبل قراءة أي ملف
  router.use(async (req, res, next) => {
    try {
      const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
      if (!m || !await integration.verifyKey(db, m[1])) {
        return res.status(401).json({ ok: false, error: 'unauthorized', message: 'مفتاح الربط غير صحيح' });
      }
      await integration.touchLastSeen(db, req.ip);
      next();
    } catch (err) { next(err); }
  });

  // استقبال مستند: multipart فيه pdf + meta (JSON). 201 جديد / 200 موجود مسبقاً (نفس الملف)
  router.post('/documents', upload.single('pdf'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'missing_pdf', message: 'ملف الـ PDF مفقود' });
    let meta;
    try { meta = JSON.parse((req.body && req.body.meta) || '{}'); } catch (_) {
      return res.status(400).json({ ok: false, error: 'invalid_meta', message: 'بيانات المستند ليست JSON صحيحاً' });
    }
    try {
      const result = await ingestDocument(db, config, { pdfBuffer: req.file.buffer, meta });
      res.status(result.status).json(result.body);
    } catch (err) {
      if (err instanceof IngestError) return res.status(err.status).json({ ok: false, error: err.code, message: err.message });
      throw err;
    }
  });

  // ---------- رسائل العميل: البرنامج يسحبها ويرسلها ويرد بالنتيجة ----------
  const json = express.json({ limit: '10kb' });
  const cleanReason = (value) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300) || null;

  router.get('/notifications', async (req, res) => {
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 5));
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...await notifications.listPendingForProgram(db, limit) });
  });

  // ملف مرفق برسالة (سند التسليم): بس المرفقات التابعة لنفس الرسالة
  router.get('/notifications/:id/attachments/:aid', async (req, res) => {
    const att = await notifications.attachmentForNotification(db, req.params.id, req.params.aid);
    if (!att || !await attachments.sendFile(res, db, att)) return res.status(404).json({ ok: false, error: 'not_found' });
  });

  router.post('/notifications/:id/ack', json, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ ok: false, error: 'not_found' });
    const body = req.body || {};
    const result = await notifications.ack(db, id, String(body.result || ''), cleanReason(body.reason));
    res.status(result.status).json(result.body);
  });

  // نبضة كل دقيقة: حالة واتساب في البرنامج + كم فسح ينتظر الرفع عنده
  router.post('/heartbeat', json, async (req, res) => {
    const body = req.body || {};
    if (!['connected', 'down'].includes(body.whatsapp)) return res.status(400).json({ ok: false, error: 'invalid_whatsapp' });
    await notifications.saveHeartbeat(db, { whatsapp: body.whatsapp, outboxPending: Number(body.outbox_pending), version: body.version });
    // أسماء الفروع: البرنامج يعرض لكل فرع خانة يختار فيها قروب مستودعه
    // + ملف قائمة عملاء مرفوع من الموقع ينتظر البرنامج يقرأه
    const imp = (await customerReport.importState(db)).pending;
    res.json({
      ok: true,
      main_branch: await branches.mainBranchName(db),
      branches: await knownBranches(db),
      ...(imp ? { customers_import: { id: imp.id, name: imp.name, mode: imp.mode } } : {})
    });
  });

  // ملف قائمة العملاء للبرنامج، ثم نتيجة قراءته
  router.get('/customers-import/:id/file', async (req, res) => {
    const buf = await customerReport.importFile(db, String(req.params.id));
    if (!buf) return res.status(404).json({ ok: false, error: 'not_found' });
    res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });

  router.post('/customers-import/:id/result', express.json({ limit: '4mb' }), async (req, res) => {
    const ok = await customerReport.recordImportResult(db, String(req.params.id), req.body);
    res.status(ok ? 200 : 404).json({ ok });
  });

  // صفحات "واتساب والإرسال": البرنامج يرسل حالته ونتائج الأوامر، ويرجع له الأوامر الجديدة
  router.post('/engine/sync', express.json({ limit: '4mb' }), async (req, res) => {
    const body = req.body || {};
    const commands = await remoteEngine.sync(db, { state: body.state && typeof body.state === 'object' ? body.state : null, results: body.results });
    res.json({ ok: true, commands, hints: await remoteEngine.hints(db) });
  });

  // تقرير العملاء من البرنامج (قائمة العملاء + سجل المستندات) — يوصل لما تتغير البيانات
  router.post('/customer-report', express.json({ limit: '4mb' }), async (req, res) => {
    try {
      const r = await customerReport.saveSnapshot(db, req.body);
      res.json({ ok: true, ...r });
    } catch (err) {
      if (err instanceof customerReport.ReportDataError) return res.status(400).json({ ok: false, error: 'invalid_report', message: err.message });
      throw err;
    }
  });

  // ---------- صندوق الفروع: الجهاز الرئيسي يسحب مستندات الفروع البعيدة ----------
  router.get('/relay/next', async (req, res) => {
    const limit = Math.min(10, Math.max(1, Number(req.query.limit) || 3));
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, jobs: await branches.takeNext(db, limit) });
  });

  router.get('/relay/:id/file', async (req, res) => {
    const file = await branches.jobFile(db, config, Number(req.params.id) || 0);
    if (!file) return res.status(404).json({ ok: false, error: 'not_found' });
    res.set({ 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' });
    res.end(file);
  });

  router.post('/relay/:id/received', async (req, res) => {
    if (!await branches.markReceived(db, config, Number(req.params.id) || 0)) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true });
  });

  router.post('/relay/:id/outcome', json, async (req, res) => {
    const r = await branches.setOutcome(db, config, Number(req.params.id) || 0, req.body || {});
    res.status(r.status).json({ ok: r.status === 200 });
  });

  router.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'invalid_json' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'too_large' });
    if (err instanceof multer.MulterError) {
      const tooLarge = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({ ok: false, error: tooLarge ? 'too_large' : 'bad_upload', message: tooLarge ? 'حجم الملف أكبر من المسموح' : 'طلب الرفع غير صحيح' });
    }
    console.error('خطأ في واجهة الربط:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  });

  return router;
}

module.exports = { integrationRouter };
