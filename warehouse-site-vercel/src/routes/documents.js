/**
 * صفحات المستندات: القائمة، التفاصيل، تغيير الحالة، الملاحظات والنواقص، التصحيح، وملف الـ PDF.
 * كلها لمستخدم مسجّل فقط — ملفات الـ PDF ليس لها رابط عام.
 * مسؤول المستودع يشوف المستندات المفتوحة فقط؛ المسلّمة للموصل والتصحيح للإدارة.
 * (نسخة فيرسيل: الملفات من القاعدة، وكل الاستعلامات async)
 */
const express = require('express');
const { requireLogin, requireRole, flash } = require('../auth');
const { audit } = require('../db');
const docs = require('../services/documents');
const workflow = require('../services/workflow');
const attachments = require('../services/attachments');
const people = require('../services/people');
const notifications = require('../services/notifications');
const { formatWhen } = require('../services/time');

function documentsRouter({ config, db }) {
  const router = express.Router();
  router.use(requireLogin);

  const parseId = (value) => {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
  };

  /**
   * الفرع المعروض: مسؤول المستودع المربوط بفرع = فرعه دائماً (ما يقدر يغيّره)،
   * الإدارة = الفرع المختار من الفلتر (أو كل الفروع).
   */
  function viewBranch(req, known) {
    const own = docs.userBranch(req.user);
    if (own) return own;
    const wanted = String(req.query.branch || '').trim();
    return wanted && known.includes(wanted) ? wanted : null;
  }

  async function listData(req) {
    const search = String(req.query.q || '').trim().slice(0, 60);
    // قائمة وحدة لكل المراحل (بدون تبويبات): التايم لاين في كل سطر يبيّن وين وصل الفسح
    const status = search ? '' : 'all';
    const known = await docs.knownBranches(db);
    const branch = viewBranch(req, known);
    const isAdmin = req.user.role === 'admin';
    const [counts, documents, handedMatches, latestId] = await Promise.all([
      docs.countsByStatus(db, branch),
      search
        ? docs.search(db, search, { includeHanded: isAdmin, branch })
        : docs.listAll(db, branch, { includeHanded: isAdmin }),
      // المسلّمة ما تنفتح لمسؤول المستودع، بس نقول له إنها انسلّمت (بدل "ما لقيت شيء")
      search && !isAdmin
        ? docs.search(db, search, { includeHanded: true, branch }).then(list => list.filter(d => d.status === 'handed_to_courier').slice(0, 20))
        : [],
      docs.latestDocumentId(db, branch)
    ]);
    return {
      status,
      search,
      branch,
      branchFilter: docs.userBranch(req.user) ? [] : known,
      tabs: docs.tabsFor(req.user),
      counts,
      documents,
      handedMatches,
      latestId
    };
  }

  /** المستند إذا كان موجوداً ومسموحاً لهذا المستخدم، وإلا null (يُعامل كغير موجود) */
  async function visibleDoc(req) {
    const id = parseId(req.params.id);
    const doc = id ? await docs.getDocument(db, id) : null;
    return docs.canView(req.user, doc) ? doc : null;
  }

  /** تنفيذ إجراء على مستند ثم الرجوع لصفحته برسالة نجاح أو سبب الرفض */
  function action(handler) {
    return async (req, res, next) => {
      const doc = await visibleDoc(req);
      if (!doc) return next();
      try {
        const message = await handler(req, doc);
        if (message) flash(req, 'success', message);
      } catch (err) {
        if (!(err instanceof workflow.WorkflowError)) throw err;
        flash(req, err.code === 'status_changed' ? 'warn' : 'danger', err.message);
      }
      // بعد الإجراء قد لا يبقى المستند ظاهراً لهذا المستخدم (مثلاً سُلّم للموصل)
      const after = await docs.getDocument(db, doc.id);
      res.redirect(docs.canView(req.user, after) ? `/documents/${doc.id}` : '/documents');
    };
  }

  router.get('/', async (req, res) => {
    res.render('documents', { title: 'الفسوحات', wide: true, ...await listData(req) });
  });

  // تحديث القائمة تلقائياً من الصفحة (كل 15 ثانية): نفس الكروت + الأعداد + آخر رقم مستند (لتنبيه الصوت)
  router.get('/cards', async (req, res, next) => {
    const data = await listData(req);
    res.render('partials/doc-cards', data, (err, html) => {
      if (err) return next(err);
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, html, counts: data.counts, latestId: data.latestId });
    });
  });

  router.get('/:id', async (req, res, next) => {
    const doc = await visibleDoc(req);
    if (!doc) {
      // مسؤول المستودع: الفسح اللي انسلّم من فرعه ما يختفي بدون سبب — نقول له وش صار
      const id = parseId(req.params.id);
      const any = id ? await docs.getDocument(db, id) : null;
      if (any && any.status === 'handed_to_courier' && docs.inUserBranch(req.user, any)) {
        return res.render('error', { title: 'انسلّم للموصل', message: `${any.title} انسلّم للموصل ${formatWhen(any.handed_over_at)}${any.courier_name ? ` (الموصل: ${any.courier_name})` : ''}. بعد التسليم يكون عند الإدارة.` });
      }
      return next();
    }
    const [events, files, atts, shortages, workers, couriers, customerMessages] = await Promise.all([
      docs.getEvents(db, doc.id),
      docs.getFiles(db, doc.id),
      attachments.listForDocument(db, doc.id),
      workflow.listShortages(db, doc.id),
      // أسماء فرع المستند فقط (والأسماء العامة لكل الفروع)
      doc.status === 'received' ? people.listWorkers(db, { activeOnly: true, branch: doc.branch }) : [],
      doc.status === 'prepared' ? people.listCouriers(db, { activeOnly: true, branch: doc.branch }) : [],
      // رسائل العميل لهذا الفسح (للإدارة)
      req.user.role === 'admin' ? notifications.listForDocument(db, doc.id) : []
    ]);
    res.render('document', {
      title: doc.title,
      doc,
      events,
      files,
      attachments: atts,
      shortages,
      workers,
      couriers,
      customerMessages,
      messageEventLabels: notifications.EVENT_LABELS,
      messageStateLabels: notifications.STATE_LABELS,
      nextStep: workflow.NEXT_STEP[doc.status] || null,
      previousStatus: workflow.PREVIOUS_STATUS[doc.status] || null,
      statusLabels: docs.STATUS_LABELS
    });
  });

  // مرفق الفسح (سند التسليم): لمن يقدر يشوف الفسح بس
  router.get('/:id/attachments/:aid', async (req, res, next) => {
    const doc = await visibleDoc(req);
    const att = doc ? await attachments.getAttachment(db, req.params.aid) : null;
    if (!att || att.document_id !== doc.id) return next();
    if (!await attachments.sendFile(res, db, att, { download: req.query.download === '1' })) return next();
  });

  // الخطوة التالية: بدء التجهيز / تم التجهيز. الحالة التي رآها المستخدم تُرسل مع الطلب (حماية الضغطتين)
  router.post('/:id/advance', action(async (req, doc) => {
    // اسم جديد مكتوب يتقدم على الاسم المختار من القائمة
    const workerName = String(req.body.worker_name_new || '').trim() || String(req.body.worker_name || '').trim();
    const result = await workflow.advance(db, { docId: doc.id, expectedStatus: String(req.body.expected_status || ''), user: req.user, workerName });
    return result.worker ? `بدأ التجهيز — يجهّزه ${result.worker.name}.` : null;
  }));

  // الإدارة تصحح رقم العميل (فسح بياناته ناقصة أو رقم عميله غلط)
  router.post('/:id/customer', requireRole('admin'), async (req, res, next) => {
    const doc = await visibleDoc(req);
    if (!doc) return next();
    try {
      const r = await docs.setCustomer(db, { docId: doc.id, number: req.body.customer_number, name: req.body.customer_name, user: req.user });
      await audit(db, { userId: req.user.id, action: 'customer_corrected', details: `#${doc.id} → ${r.number}`, ip: req.ip });
      flash(req, 'success', `تم تصحيح العميل: ${r.name ? `${r.name} — ` : ''}${r.number}.`);
    } catch (err) {
      if (!(err instanceof docs.CustomerError)) throw err;
      flash(req, 'danger', err.message);
    }
    res.redirect(`/documents/${doc.id}`);
  });

  // ملاحظة أو نقص (لا يغيّران الحالة)
  router.post('/:id/notes', action(async (req, doc) => {
    if (req.body.kind === 'shortage') {
      await workflow.addShortage(db, { docId: doc.id, text: req.body.text, user: req.user });
      return 'تم تسجيل النقص. يبقى مفتوحاً لين ينقفل.';
    }
    await workflow.addNote(db, { docId: doc.id, text: req.body.text, user: req.user });
    return 'تمت إضافة الملاحظة.';
  }));

  router.post('/:id/shortages/:eventId/close', action(async (req, doc) => {
    await workflow.closeShortage(db, { docId: doc.id, shortageEventId: parseId(req.params.eventId), resolution: req.body.resolution, user: req.user });
    return 'تم إقفال النقص.';
  }));

  // تصحيح الحالة: الإدارة فقط
  router.post('/:id/correct', requireRole('admin'), action(async (req, doc) => {
    const expected = String(req.body.expected_status || '');
    const result = await workflow.correctBack(db, { docId: doc.id, expectedStatus: expected, reason: req.body.reason, user: req.user });
    await audit(db, { userId: req.user.id, action: 'document_corrected', details: `#${doc.id}: ${expected} -> ${result.to}`, ip: req.ip });
    return `تم التصحيح: رجعت الحالة إلى "${docs.STATUS_LABELS[result.to]}".`;
  }));

  /** ملف المستند: آخر نسخة، أو نسخة محددة (?v=2). null إذا لم يوجد أو غير مسموح */
  async function findFile(req, { withData = true } = {}) {
    const doc = await visibleDoc(req);
    if (!doc) return null;
    const files = await docs.getFiles(db, doc.id);
    const file = req.query.v ? files.find(f => f.version === Number(req.query.v)) : files[0];
    if (!file) return null;
    const data = withData ? await docs.readFile(db, file) : null;
    if (withData && !data) return null;
    return { id: doc.id, doc, file, data, latestVersion: files[0].version };
  }

  // مقارنة نسختين من نفس الفسح جنب بعض (الافتراضي: آخر نسخة مع اللي قبلها)
  router.get('/:id/compare', async (req, res, next) => {
    const doc = await visibleDoc(req);
    if (!doc) return next();
    const files = await docs.getFiles(db, doc.id);
    if (files.length < 2) return res.redirect('/documents/' + doc.id);
    const pick = (v, fallback) => files.find(f => f.version === Number(v)) || fallback;
    let newer = pick(req.query.b, files[0]);
    let older = pick(req.query.a, files.find(f => f.version < newer.version) || files[1]);
    if (older.version > newer.version) [older, newer] = [newer, older];
    res.render('compare', { title: 'مقارنة ' + doc.title, doc, versions: files, older, newer, latestVersion: files[0].version });
  });

  // عارض الـ PDF داخل الموقع (يعمل على الجوال، ولا تخطفه برامج التنزيل مثل IDM)
  router.get('/:id/view', async (req, res, next) => {
    const found = await findFile(req, { withData: false });
    if (!found) return next();
    res.render('viewer', { title: found.doc.title, doc: found.doc, version: found.file.version, isLatest: found.file.version === found.latestVersion });
  });

  // محتوى الملف للعارض (JSON)
  router.get('/:id/pdf-data', async (req, res, next) => {
    const found = await findFile(req);
    if (!found) return next();
    res.set('Cache-Control', 'private, no-store');
    res.json({ ok: true, version: found.file.version, size: found.file.size, base64: found.data.toString('base64') });
  });

  // الملف نفسه (للتنزيل أو للفتح المباشر)
  router.get('/:id/pdf', async (req, res, next) => {
    const found = await findFile(req);
    if (!found) return next();
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="document-${found.id}-v${found.file.version}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(found.data);
  });

  return router;
}

module.exports = { documentsRouter };
