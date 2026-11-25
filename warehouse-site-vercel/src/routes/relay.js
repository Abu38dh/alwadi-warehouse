/**
 * واجهة أجهزة الفروع (برنامج الإرسال في الفروع البعيدة).
 *   POST /api/relay/enroll       {install_key, device_name, device_id?, token?} تسجيل تلقائي من ملف تركيب الطابعة (مفتاح الفرع)
 *   GET  /api/relay/hello                                   التأكد من الربط
 *   POST /api/relay/upload       multipart: pdf + meta     رفع مستند للصندوق
 *   GET  /api/relay/jobs/:id                                حالة المستند ونتيجته
 * المصادقة: x-device-id + Authorization: Bearer <مفتاح الجهاز>
 */
const express = require('express');
const multer = require('multer');
const auth = require('../auth');
const branches = require('../services/branches');
const { audit } = require('../db');

// فيرسيل يرفض أي طلب أكبر من 4.5 ميقا
const MAX_RELAY_BYTES = 4 * 1024 * 1024;
const ENROLL_LIMIT = 10; // محاولات بمفتاح غلط لكل عنوان قبل القفل المؤقت

function looksLikePdf(buf) {
  return Buffer.isBuffer(buf) && buf.length > 100 && buf.subarray(0, 1024).includes('%PDF-');
}

function relayRouter({ config, db }) {
  const router = express.Router();
  const json = express.json({ limit: '4kb' });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_RELAY_BYTES, files: 1, fields: 4, fieldSize: 8 * 1024, parts: 6 } });

  router.post('/enroll', json, async (req, res) => {
    const key = `relayenroll:${String(req.ip || '').slice(0, 64)}`;
    const locked = await auth.lockRemainingMs(db, key);
    if (locked > 0) return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    const body = req.body || {};
    const result = await branches.enrollDevice(db, { installKey: body.install_key, deviceName: body.device_name, deviceId: body.device_id, token: body.token });
    if (result.error === 'wrong_key') {
      await auth.recordFailure(db, config, key, ENROLL_LIMIT);
      return res.status(403).json({ ok: false, error: 'wrong_key' });
    }
    if (result.error === 'stopped') return res.status(403).json({ ok: false, error: 'stopped' });
    await auth.clearFailures(db, key);
    await audit(db, { action: 'branch_device_enrolled', details: `#${result.device_id} ${result.branch} / ${result.name}`, ip: req.ip });
    res.json({ ok: true, ...result });
  });

  // باقي الطلبات: جهاز مربوط وفعّال فقط
  router.use(async (req, res, next) => {
    try {
      const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
      const device = m ? await branches.verifyDevice(db, req.get('x-device-id'), m[1]) : null;
      if (!device) return res.status(401).json({ ok: false, error: 'unauthorized' });
      req.device = device;
      next();
    } catch (err) { next(err); }
  });

  router.get('/hello', (req, res) => {
    res.json({ ok: true, name: req.device.name, branch: req.device.branch });
  });

  router.post('/upload', upload.single('pdf'), async (req, res) => {
    if (!req.file || !looksLikePdf(req.file.buffer)) return res.status(422).json({ ok: false, error: 'not_pdf' });
    let meta = {};
    try { meta = JSON.parse((req.body && req.body.meta) || '{}'); } catch (_) {}
    // الملف وصل ناقص أو متغيّر: ما ينحفظ (الجهاز يعيد الرفع)
    const hash = require('crypto').createHash('sha256').update(req.file.buffer).digest('hex');
    if (meta.sha256 && String(meta.sha256).toLowerCase() !== hash) return res.status(400).json({ ok: false, error: 'sha_mismatch' });
    const r = await branches.enqueueUpload(db, config, req.device, { pdfBuffer: req.file.buffer, fileName: meta.file_name });
    res.status(r.duplicate ? 200 : 201).json({ ok: true, ...r });
  });

  router.get('/jobs/:id', async (req, res) => {
    const s = await branches.jobStatusForDevice(db, req.device, Number(req.params.id) || 0);
    if (!s) return res.status(404).json({ ok: false, error: 'unknown_job' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...s });
  });

  router.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ ok: false, error: 'bad_upload' });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'invalid_json' });
    console.error('خطأ في واجهة أجهزة الفروع:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  });

  return router;
}

module.exports = { relayRouter };
