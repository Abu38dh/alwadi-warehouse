/**
 * التسليم للموصل: يتم من صفحة الفسح نفسها (اختيار الموصل أو كتابة اسمه + زر "تسليم للموصل").
 * هذا المسار يستقبل النموذج فقط — ما فيه صفحة تسليم منفصلة.
 * (يقبل أكثر من مستند في نفس الطلب، والمستند اللي تغيّرت حالته يُتخطى.)
 */
const express = require('express');
const multer = require('multer');
const { requireLogin, requireCsrf, flash } = require('../auth');
const attachments = require('../services/attachments');
const workflow = require('../services/workflow');
const docs = require('../services/documents');
const { countAr } = require('../services/time');

const asArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const countDocs = (n) => countAr(n, ['مستند واحد', 'مستندين', 'مستندات', 'مستنداً']);
const cleanIds = (values) => values.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 200);

function handoverRouter({ config, db }) {
  const router = express.Router();
  router.use(requireLogin);
  // سند التسليم (إجباري): صورة من الجوال أو PDF. رمز الحماية (CSRF) يُفحص بعد استلام الملفات
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: attachments.MAX_BYTES, files: attachments.MAX_FILES, fields: 30, parts: 40 } });
  const receiveFiles = (req, res, next) => {
    if (!/^multipart\/form-data/i.test(req.get('content-type') || '')) return next();
    upload.array('receipt', attachments.MAX_FILES)(req, res, (err) => {
      if (!err) return next();
      req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'حجم المرفق كبير (الحد 4 ميقا).'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `أقصى شي ${attachments.MAX_FILES} مرفقات.`
        : 'تعذر استلام المرفق، حاول مرة ثانية.';
      next();
    });
  };

  // الصفحة القديمة: التسليم صار من صفحة الفسح نفسها
  router.get('/', (req, res) => {
    const ids = cleanIds(String(req.query.ids || '').split(','));
    res.redirect(ids.length === 1 ? `/documents/${ids[0]}` : '/documents?status=prepared');
  });

  router.post('/', receiveFiles, requireCsrf, async (req, res) => {
    // فقط مستندات فرع هذا المستخدم (مسؤول الرياض ما يسلّم فسح جدة).
    // المستند المسلّم من قبل يبقى في الطلب حتى تطلع رسالة "حالته تغيّرت" بدل خطأ غامض.
    const ids = [];
    for (const id of cleanIds(asArray(req.body.doc_ids))) if (docs.inUserBranch(req.user, await docs.getDocument(db, id))) ids.push(id);
    // عند الخطأ: يرجع لصفحة الفسح (أو لقائمة الجاهزة لو أكثر من فسح)
    const back = ids.length === 1 ? `/documents/${ids[0]}` : '/documents?status=prepared';
    if (req.uploadError) { flash(req, 'danger', req.uploadError); return res.redirect(back); }
    let receipts;
    try {
      receipts = await attachments.storeFiles(db, config, req.files);
    } catch (err) {
      if (!(err instanceof attachments.AttachmentError)) throw err;
      flash(req, 'danger', err.message);
      return res.redirect(back);
    }
    try {
      const result = await workflow.handOver(db, { docIds: ids, courierId: req.body.courier_id, courierName: req.body.courier_name, user: req.user, receipts });
      if (result.done.length === 0) {
        flash(req, 'warn', 'ما انسلّم شيء: حالة الفسح تغيّرت (يمكن انسلّم من قبل).');
        return res.redirect(back);
      }
      let message = `تم تسليم ${countDocs(result.done.length)} للموصل ${result.courier.name}.`;
      if (result.skipped.length) message += ` ${countDocs(result.skipped.length)} ما انسلّم لأن حالته تغيّرت.`;
      flash(req, result.skipped.length ? 'warn' : 'success', message);
      res.redirect('/documents?status=prepared');
    } catch (err) {
      if (!(err instanceof workflow.WorkflowError)) throw err;
      flash(req, 'danger', err.message);
      res.redirect(ids.length ? back : '/documents?status=prepared');
    }
  });

  return router;
}

module.exports = { handoverRouter };
