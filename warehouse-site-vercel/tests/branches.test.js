/**
 * أجهزة المحاسبين (ملف الطابعة لكل فرع، بدون رموز ربط) + صندوق المستندات المؤقت.  التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fakePdf, sha256, startSite, setupAdmin, loginAs, newKey, upload, clearanceMeta } = require('./helpers');
const installer = require('../src/services/installer');
const branches = require('../src/services/branches');

async function world() {
  // ملف تركيب وهمي (مكان ملف الطابعة الحقيقي اللي يُبنى على ويندوز)
  const fakeExe = path.join(require('os').tmpdir(), `fake-printer-setup-${process.pid}-${Date.now()}.exe`);
  fs.writeFileSync(fakeExe, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096, 1)]));
  const site = await startSite({ printerInstaller: fakeExe });
  const admin = await setupAdmin(site);
  const key = await newKey(admin);
  const addBranch = (name) => admin.post('/admin/branches/add', { name }, '/admin/branches');
  /** تحميل ملف الفرع من صفحة الإدارة وقراءة مفتاح الفرع من آخره (مثل ملف التركيب) */
  const download = async (branch) => {
    const res = await admin.get(`/admin/branches/installer?branch=${encodeURIComponent(branch)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, res, buf, cfg: installer.readTrailer(buf) };
  };
  const enroll = async (installKey, deviceName = 'PC', prev = null) => {
    const proof = prev ? { device_id: prev.device_id, token: prev.token } : {};
    const res = await fetch(`${site.base}/api/relay/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ install_key: installKey, device_name: deviceName, ...proof }) });
    return { status: res.status, json: await res.json() };
  };
  /** جهاز مركّب عليه ملف الفرع */
  const device = async (branch, name) => {
    await addBranch(branch);
    return (await enroll(await branches.installKeyFor(site.db, branch), name)).json;
  };
  const dev = (creds) => ({
    upload: async (pdf, fileName = 'Print_1.pdf') => {
      const form = new FormData();
      form.append('meta', JSON.stringify({ file_name: fileName, sha256: sha256(pdf) }));
      form.append('pdf', new Blob([pdf], { type: 'application/pdf' }), fileName);
      const res = await fetch(`${site.base}/api/relay/upload`, { method: 'POST', headers: { authorization: `Bearer ${creds.token}`, 'x-device-id': String(creds.device_id) }, body: form });
      return { status: res.status, json: await res.json() };
    },
    get: async (p) => {
      const res = await fetch(`${site.base}/api/relay${p}`, { headers: { authorization: `Bearer ${creds.token}`, 'x-device-id': String(creds.device_id) } });
      return { status: res.status, json: await res.json() };
    }
  });
  const main = async (method, p, body) => {
    const res = await fetch(`${site.base}/api/integration${p}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, json: type.includes('json') ? await res.json() : null, buf: type.includes('pdf') ? Buffer.from(await res.arrayBuffer()) : null };
  };
  const close = async () => { await site.close(); try { fs.unlinkSync(fakeExe); } catch (_) {} };
  return { site: { ...site, close }, admin, key, addBranch, download, enroll, device, dev, main, fakeExe };
}

test('ملف الطابعة لكل فرع: التحميل للإدارة بس، والملف فيه عنوان الموقع ومفتاح الفرع', async () => {
  const w = await world();
  try {
    let page = await w.admin.html('/admin/branches');
    assert.match(page, /فرع جدة/, 'الفرع الرئيسي موجود من البداية');
    assert.doesNotMatch(page, /pair-code|رمز ربط/, 'ما فيه رموز ربط');
    await w.addBranch('الرياض');
    page = await w.admin.html('/admin/branches');
    assert.match(page, /installer\?branch=%D8%A7%D9%84%D8%B1%D9%8A%D8%A7%D8%B6/);

    const d = await w.download('الرياض');
    assert.equal(d.status, 200);
    assert.match(d.res.headers.get('content-disposition'), /filename\*=UTF-8''/);
    assert.match(decodeURIComponent(d.res.headers.get('content-disposition')), /تركيب الطابعة - فرع الرياض\.exe/);
    assert.deepEqual(d.buf.subarray(0, 4098), fs.readFileSync(w.fakeExe), 'نفس الملف الأصلي + سطر الفرع في آخره');
    assert.equal(d.cfg.branch, 'الرياض');
    assert.equal(d.cfg.siteUrl, w.site.base);
    assert.match(d.cfg.installKey, /^br_/);
    assert.equal((await w.download('فرع مو موجود')).buf.length < 1000, true, 'فرع غير معروف => ما فيه ملف');

    const store = await loginAs(w.site, { username: 'store' });
    assert.equal((await store.get('/admin/branches')).status, 403);
    assert.equal((await store.get('/admin/branches/installer?branch=' + encodeURIComponent('الرياض'))).status, 403);
  } finally { await w.site.close(); }
});

test('التركيب: الجهاز يتسجّل لحاله على فرع الملف، وإعادة التركيب ما تكرره، والمفتاح الغلط يقفل', async () => {
  const w = await world();
  try {
    await w.addBranch('الدمام');
    const { cfg } = await w.download('الدمام');
    assert.equal((await w.enroll('br_wrong', 'PC-1')).status, 403);
    const ok = await w.enroll(cfg.installKey, 'PC-DAMMAM-1');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.branch, 'الدمام');
    assert.equal(ok.json.name, 'PC-DAMMAM-1');
    assert.match(ok.json.token, /^dev_/);
    assert.equal(w.site.db.prepare('SELECT token_hash FROM relay_devices').get().token_hash.includes(ok.json.token), false, 'المفتاح ما يتخزن');
    let page = await w.admin.html('/admin/branches');
    assert.match(page, /PC-DAMMAM-1/);
    assert.doesNotMatch(page, /موقوف/, 'الجهاز شغال');
    assert.match(page, /تحميل ملف الطابعة/);
    // خانة التعديل مقفلة، وتنفتح تحت سطر الفرع بس لما يضغط تعديل
    assert.doesNotMatch(page, /إيقاف الجهاز/);
    page = await w.admin.html('/admin/branches?edit=' + encodeURIComponent('الدمام'));
    assert.match(page, /إيقاف الجهاز/);
    assert.match(page, /إيقاف ملف الطابعة القديم/);
    assert.match(page, /href="\/admin\/branches">إغلاق</);

    // إعادة التركيب على نفس الجهاز (يرسل مفتاحه الحالي): نفس السجل، والمفتاح القديم يتوقف
    const again = await w.enroll(cfg.installKey, 'PC-DAMMAM-1', ok.json);
    assert.equal(again.json.device_id, ok.json.device_id);
    assert.equal(w.site.db.prepare('SELECT COUNT(*) n FROM relay_devices').get().n, 1);
    assert.equal((await w.dev(ok.json).get('/hello')).status, 401);
    assert.equal((await w.dev(again.json).get('/hello')).status, 200);

    // نفس الجهاز ركّب ملف فرع ثاني => ينتقل له
    const jeddah = (await w.download('جدة')).cfg;
    const moved = await w.enroll(jeddah.installKey, 'PC-DAMMAM-1', again.json);
    assert.equal(moved.json.branch, 'جدة');
    assert.equal(moved.json.device_id, ok.json.device_id);

    // كمبيوتر ثاني بنفس الاسم وبدون مفتاح الجهاز: سجل جديد، والجهاز الأصلي ما يتأثر
    const other = await w.enroll(cfg.installKey, 'pc-dammam-1');
    assert.notEqual(other.json.device_id, ok.json.device_id);
    assert.equal(other.json.branch, 'الدمام');
    assert.equal((await w.dev(moved.json).get('/hello')).json.branch, 'جدة', 'الجهاز الأصلي باقي على فرعه ومفتاحه');

    for (let i = 0; i < 10; i++) await w.enroll('br_zzz', 'x');
    assert.equal((await w.enroll(cfg.installKey, 'PC-2')).status, 429, 'مقفل مؤقتاً بعد 10 محاولات خاطئة');
  } finally { await w.site.close(); }
});

test('ملف جديد للفرع: القديم ما يركّب أجهزة جديدة، والأجهزة المركّبة تكمل — والجهاز الموقوف ما يرجع بإعادة التركيب', async () => {
  const w = await world();
  try {
    await w.addBranch('مكة');
    const old = (await w.download('مكة')).cfg;
    const a = (await w.enroll(old.installKey, 'PC-A')).json;
    await w.admin.post('/admin/branches/rotate', { branch: 'مكة' }, '/admin/branches');
    assert.equal((await w.enroll(old.installKey, 'PC-B')).status, 403, 'الملف القديم وقف');
    assert.equal((await w.dev(a).get('/hello')).status, 200, 'الجهاز المركّب يكمل');
    const fresh = (await w.download('مكة')).cfg;
    assert.notEqual(fresh.installKey, old.installKey);
    assert.equal((await w.enroll(fresh.installKey, 'PC-B')).status, 200);

    await w.admin.post(`/admin/branches/${a.device_id}/active`, { active: '' }, '/admin/branches');
    const back = await w.enroll(fresh.installKey, 'PC-A');
    assert.equal(back.status, 403);
    assert.equal(back.json.error, 'stopped');
  } finally { await w.site.close(); }
});

test('الإدارة تغيّر فرع الجهاز', async () => {
  const w = await world();
  try {
    const a = await w.device('الرياض', 'PC-R');
    await w.addBranch('الدمام');
    await w.admin.post(`/admin/branches/${a.device_id}/branch`, { branch: 'الدمام' }, '/admin/branches');
    assert.equal((await w.dev(a).get('/hello')).json.branch, 'الدمام');
  } finally { await w.site.close(); }
});

test('قائمة فروع وحدة: الفرع المضاف من "أجهزة المحاسبين" يطلع في الحسابات والموظفين، وكلمة "فرع" ما تتكرر', async () => {
  const w = await world();
  try {
    await w.addBranch('فرع القصيم');
    await w.addBranch('خميس مشيط');
    assert.deepEqual(await branches.allBranches(w.site.db), ['جدة', 'القصيم', 'خميس مشيط']);
    const users = await w.admin.html('/admin/users');
    for (const b of ['جدة', 'القصيم', 'خميس مشيط']) assert.match(users, new RegExp(`<option value="${b}"[^>]*>فرع ${b}</option>`));
    assert.doesNotMatch(users, /فرع فرع/);
    const people = await w.admin.html('/admin/couriers');
    assert.match(people, /<option value="القصيم"[^>]*>فرع القصيم<\/option>/);
    assert.doesNotMatch(await w.admin.html('/admin/branches'), /فرع فرع/);
    // نفس الفرع بالكلمة أو بدونها = فرع واحد (نفس ملف الطابعة)
    assert.equal(await branches.installKeyFor(w.site.db, 'فرع القصيم'), await branches.installKeyFor(w.site.db, 'القصيم'));
    await w.addBranch('القصيم');
    assert.equal((await branches.allBranches(w.site.db)).length, 3);
  } finally { await w.site.close(); }
});

test('الطريق كامل: جهاز الفرع يرفع ← الجهاز الرئيسي يسحب ويستلم (الملف ينحذف من الموقع) ← النتيجة ترجع للفرع', async () => {
  const w = await world();
  try {
    const creds = await w.device('الرياض', 'جهاز المحاسب 1');
    const d = w.dev(creds);
    assert.equal((await d.get('/hello')).json.branch, 'الرياض');

    const pdf = fakePdf('relay-1');
    const up = await d.upload(pdf, 'Print_2026_001.pdf');
    assert.equal(up.status, 201);
    const again = await d.upload(pdf, 'Print_2026_001.pdf');
    assert.equal(again.status, 200);
    assert.equal(again.json.job_id, up.json.job_id, 'نفس الملف = نفس المهمة');
    assert.equal((await d.get(`/jobs/${up.json.job_id}`)).json.status, 'waiting');
    assert.match(await w.admin.html('/admin/branches'), /1 مستند ينتظر الإرسال/);

    // الجهاز الرئيسي يسحب
    let next = await w.main('GET', '/relay/next');
    assert.equal(next.json.jobs.length, 1);
    const job = next.json.jobs[0];
    assert.deepEqual({ branch: job.branch, device: job.device_name, file: job.file_name, sha: job.sha256 },
      { branch: 'الرياض', device: 'جهاز المحاسب 1', file: 'Print_2026_001.pdf', sha: sha256(pdf) });
    assert.equal((await w.main('GET', '/relay/next')).json.jobs.length, 0, 'المأخوذة ما تنعطى مرتين');

    const file = await w.main('GET', `/relay/${job.job_id}/file`);
    assert.deepEqual(file.buf, pdf);
    const stored = () => w.site.db.prepare('SELECT COUNT(*) n FROM file_chunks WHERE key = ?').get(`relay/${creds.device_id}-${sha256(pdf)}.pdf`).n;
    assert.ok(stored() > 0);
    await w.main('POST', `/relay/${job.job_id}/received`);
    assert.equal(stored(), 0, 'الملف انحذف من الموقع بعد الاستلام');
    assert.equal((await w.main('GET', `/relay/${job.job_id}/file`)).status, 404);
    assert.equal((await d.get(`/jobs/${job.job_id}`)).json.status, 'received');

    // النتيجة
    assert.equal((await w.main('POST', `/relay/${job.job_id}/outcome`, { status: 'weird' })).status, 400);
    await w.main('POST', `/relay/${job.job_id}/outcome`, { status: 'sent', customer_number: '1001', destination: 'قروب: مؤسسة النخبة 1001' });
    const st = (await d.get(`/jobs/${job.job_id}`)).json;
    assert.equal(st.status, 'done');
    assert.deepEqual(st.outcome, { status: 'sent', customer_number: '1001', destination: 'قروب: مؤسسة النخبة 1001', message: null });
  } finally { await w.site.close(); }
});

test('الجهاز الرئيسي انطفى بعد السحب: المستند يرجع متاح بعد 10 دقائق', async () => {
  const w = await world();
  try {
    const creds = await w.device('الرياض', 'ج1');
    await w.dev(creds).upload(fakePdf('lease'));
    assert.equal((await w.main('GET', '/relay/next')).json.jobs.length, 1);
    assert.equal((await w.main('GET', '/relay/next')).json.jobs.length, 0);
    w.site.db.prepare('UPDATE relay_jobs SET taken_at = ?').run(new Date(Date.now() - 11 * 60000).toISOString());
    assert.equal((await w.main('GET', '/relay/next')).json.jobs.length, 1);
  } finally { await w.site.close(); }
});

test('الحماية: بدون مفتاح، أو جهاز موقوف، أو مهمة جهاز ثاني => مرفوض', async () => {
  const w = await world();
  try {
    const a = await w.device('الرياض', 'أ');
    const b = await w.device('الدمام', 'ب');
    const up = await w.dev(a).upload(fakePdf('sec'));
    assert.equal((await w.dev(b).get(`/jobs/${up.json.job_id}`)).status, 404, 'جهاز ثاني ما يشوف مهمة غيره');
    assert.equal((await w.dev({ device_id: a.device_id, token: 'dev_wrong' }).get('/hello')).status, 401);
    assert.equal((await w.dev({ device_id: b.device_id, token: a.token }).get('/hello')).status, 401, 'مفتاح جهاز على رقم جهاز ثاني');
    assert.equal((await w.dev(a).upload(Buffer.from('not a pdf'.repeat(30)))).status, 422);

    const id = w.site.db.prepare("SELECT id FROM relay_devices WHERE name = 'أ'").get().id;
    await w.admin.post(`/admin/branches/${id}/active`, { active: '' }, '/admin/branches');
    assert.equal((await w.dev(a).get('/hello')).status, 401, 'الموقوف ينقطع فوراً');
    // واجهة سحب المستندات تحتاج مفتاح الموقع الداخلي، مو مفتاح جهاز
    const r = await fetch(`${w.site.base}/api/integration/relay/next`, { headers: { authorization: `Bearer ${b.token}` } });
    assert.equal(r.status, 401);
  } finally { await w.site.close(); }
});

test('الفرع يتسجّل على الفسح: من البرنامج أو فرع الجهاز الرئيسي، ويظهر في القائمة والبحث', async () => {
  const w = await world();
  try {
    const p1 = fakePdf('branch-1');
    await upload(w.site, w.key, p1, clearanceMeta(p1, { branch: 'الرياض', customer_name: 'ورشة الرياض' }));
    const p2 = fakePdf('branch-2');
    await upload(w.site, w.key, p2, clearanceMeta(p2, { customer_name: 'ورشة جدة' }));
    const rows = w.site.db.prepare('SELECT branch FROM documents ORDER BY id').all().map(r => r.branch);
    assert.deepEqual(rows, ['الرياض', 'جدة'], 'بدون فرع = فرع الجهاز الرئيسي (جدة افتراضياً)');

    await w.admin.post('/admin/branches/main', { name: 'جدة - الرئيسي' }, '/admin/branches');
    const p3 = fakePdf('branch-3');
    await upload(w.site, w.key, p3, clearanceMeta(p3));
    assert.equal(w.site.db.prepare('SELECT branch FROM documents WHERE id = 3').get().branch, 'جدة - الرئيسي');

    const list = await w.admin.html('/documents');
    assert.match(list, /class="tl-branch"> · فرع /, 'الفرع يطلع مع العميل لما فيه أكثر من فرع');
    assert.match(list, /فرع الرياض/);
    const found = await w.admin.html(`/documents?q=${encodeURIComponent('الرياض')}`);
    assert.match(found, /ورشة الرياض/);
    assert.doesNotMatch(found, /ورشة جدة/);
    assert.match(await w.admin.html('/documents/1'), / · فرع الرياض/);
  } finally { await w.site.close(); }
});
