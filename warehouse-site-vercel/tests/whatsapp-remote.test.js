/**
 * واتساب والإرسال (نسخة فيرسيل): البرنامج على جهاز الشركة يرسل حالته ويسحب أوامر الإدارة.  التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startSite, setupAdmin, loginAs, newKey } = require('./helpers');

const state = () => ({
  status: { status: 'connected', phone: '966500000000', stats: { review: 1 }, warehouse: { main: { number: '100123' } } },
  logs: [
    { id: 'l1', time: '10:00', fileName: 'Print_1.pdf', filePath: 'C:/data/Review/فواتير/Print_1.pdf', docTypeLabel: 'فاتورة', docTypeClass: 'invoice', customerNumber: '1001', phone: '-', status: 'review', reason: 'لا يوجد قروب للعميل [1001]' },
    { id: 'l2', time: '09:58', fileName: 'Print_2.pdf', filePath: 'C:/data/Sent/فواتير/Print_2.pdf', docTypeLabel: 'فاتورة', docTypeClass: 'invoice', customerNumber: '1002', phone: 'قروب: مؤسسة الأمل 1002', status: 'sent' }
  ],
  cash: [{ fileName: 'Print_cash.pdf', filePath: 'C:/data/نقدي/Print_cash.pdf', docTypeLabel: 'فاتورة', customerNumber: '9999', at: new Date().toISOString() }],
  settings: { delayMs: 5000, testPhone: '', captions: { invoice: 'فاتورتكم يا غالي' }, defaultCaptions: { invoice: 'مرفق فاتورتكم', clearance: 'مرفق الفسح', return: 'مرفق المرتجع', statement: 'مرفق كشف الحساب' }, sendDocTypes: { invoice: true, clearance: true, return: false, statement: true } },
  warehouse: { main: { number: '100123', groupName: 'مستودع جده 100123' }, mainBranch: 'جدة', branchNumbers: [] }
});

test('واتساب والإرسال: الصفحات من حالة البرنامج، والأزرار توصل البرنامج وترجع نتيجتها', async () => {
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    const key = await newKey(admin);
    const sync = async (body) => (await (await fetch(`${site.base}/api/integration/engine/sync`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    })).json());

    // قبل ما يتصل البرنامج
    let page = await admin.html('/admin/whatsapp');
    assert.match(page, /برنامج الواتساب على جهاز الشركة ما يرد/);

    // البرنامج يرسل حالته
    assert.deepEqual(await sync({ state: state(), results: [] }), { ok: true, commands: [], hints: { notifications: false, relay: false } });
    page = await admin.html('/admin/whatsapp');
    assert.doesNotMatch(page, /ما يرد/);
    assert.match(page, /id="wa-label">متصل</);
    assert.match(page, /Print_1.pdf/, 'السجل: اللي تحتاج مراجعة');
    assert.match(page, /لا يوجد قروب للعميل \[1001\]/);
    assert.match(page, /Print_cash.pdf/, 'النقدي');
    assert.match(page, /href="\/admin\/customers"/, 'تبويب تقارير الفواتير');

    // الرسائل: نصوص المستندات (فواتير، كشوفات، مرتجعات، فسوحات) + رسائل حالة الطلب
    page = await admin.html('/admin/whatsapp/messages');
    assert.match(page, /فاتورتكم يا غالي/);
    assert.match(page, /placeholder="مرفق كشف الحساب"/);
    assert.match(page, /رسائل حالة الطلب/);
    // الإعدادات: أنواع المستندات وقروب المستودع
    page = await admin.html('/admin/whatsapp/settings');
    assert.match(page, /name="send_return" value="1"(?! checked)/);
    assert.match(page, /value="100123"/);

    // زر "تمت الطباعة": ينتظر البرنامج ينفذ (البرنامج يسحب الأمر ويرجّع النتيجة)
    const pending = admin.postAndFollow('/admin/whatsapp/cash-done', { file_path: 'C:/data/نقدي/Print_cash.pdf', back: '/admin/whatsapp' }, '/admin/whatsapp');
    let cmds = [];
    for (let i = 0; i < 40 && !cmds.length; i++) { cmds = (await sync({ results: [] })).commands; if (!cmds.length) await new Promise(r => setTimeout(r, 150)); }
    assert.equal(cmds.length, 1);
    assert.deepEqual({ method: cmds[0].method, path: cmds[0].path, body: cmds[0].body }, { method: 'POST', path: '/api/cash-done', body: { filePath: 'C:/data/نقدي/Print_cash.pdf' } });
    const after = state(); after.cash = [];
    await sync({ state: after, results: [{ id: cmds[0].id, status: 200, json: { success: true } }] });
    const r = await pending;
    assert.match(r.html, /انحسبت مطبوعة/);
    assert.doesNotMatch(r.html, /Print_cash.pdf/, 'الحالة الجديدة');
    assert.equal((await sync({ results: [] })).commands.length, 0, 'الأمر ما يتكرر');

    // حفظ نصوص المستندات
    const p2 = admin.postAndFollow('/admin/whatsapp/messages/captions', { back: '/admin/whatsapp/messages', caption_statement: 'كشف حسابكم' }, '/admin/whatsapp/messages');
    cmds = [];
    for (let i = 0; i < 40 && !cmds.length; i++) { cmds = (await sync({ results: [] })).commands; if (!cmds.length) await new Promise(res => setTimeout(res, 150)); }
    assert.equal(cmds[0].path, '/api/settings');
    assert.equal(cmds[0].body.captions.statement, 'كشف حسابكم');
    await sync({ results: [{ id: cmds[0].id, status: 200, json: { success: true } }] });
    assert.match((await p2).html, /تم حفظ نصوص المستندات/);

    // للإدارة بس
    const store = await loginAs(site, { username: 'store' });
    assert.equal((await store.get('/admin/whatsapp')).status, 403);
  } finally { await site.close(); }
});

test('برنامج الواتساب للجهاز الرئيسي: ملف تثبيت فيه مفتاح جديد يتفعّل أول ما يتصل الجهاز الجديد، والقديم يشتغل لين وقتها', async () => {
  const installer = require('../src/services/installer');
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    const oldKey = await newKey(admin);
    const beat = (key) => fetch(`${site.base}/api/integration/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ whatsapp: 'connected', outbox_pending: 0 }) });

    const page = await admin.html('/admin/branches');
    assert.match(page, /href="\/admin\/branches\/main-installer"/);
    assert.match(page, /الجهاز الرئيسي/);

    const res = await admin.get('/admin/branches/main-installer');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length < 1024 * 1024, 'ملف صغير: البرنامج ينحمّل وقت التثبيت');
    assert.equal(buf.subarray(0, 2).toString('latin1'), 'MZ', 'ملف تشغيل ويندوز');
    const cfg = installer.readTrailer(buf);
    assert.equal(cfg.role, 'main');
    assert.equal(cfg.siteUrl, site.base);
    assert.match(cfg.apiKey, /^wh_/);
    assert.match(cfg.payloadUrl, /^https:\/\//);
    assert.match(cfg.payloadSha256, /^[0-9a-f]{64}$/);

    // انحمّل الملف وما انثبّت: الجهاز الحالي يكمل عادي
    assert.equal((await beat(oldKey)).status, 200);
    // الجهاز الجديد اتصل: مفتاحه يصير الحالي، والقديم يتوقف (ما يشتغل برنامجين مع بعض)
    assert.equal((await beat(cfg.apiKey)).status, 200);
    assert.equal((await beat(oldKey)).status, 401);
    assert.equal((await beat(cfg.apiKey)).status, 200);

    const store = await loginAs(site, { username: 'store2' });
    assert.equal((await store.get('/admin/branches/main-installer')).status, 403);
  } finally { await site.close(); }
});
