/**
 * أدوات مشتركة لاختبارات الموقع: موقع مؤقت (قاعدة ومجلد بيانات مؤقتان)، متصفح بسيط، ورفع مستندات.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const auth = require('../src/auth');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** ملف PDF صغير للاختبار (الموقع لا يقرأ محتواه، يتأكد فقط أنه PDF) */
function fakePdf(label) {
  return Buffer.from(`%PDF-1.4\n% ${label}\n${'0'.repeat(200)}\n%%EOF\n`);
}

/**
 * قاعدة للاختبارات على نفس ملف الموقع (better-sqlite3، متزامن) — للفحص المباشر في الاختبارات.
 * الموقع نفسه يشتغل بطبقة Turso/libSQL الحقيقية (async). نفس الواجهة: الخدمات تقبل الاثنين.
 */
function testDb(file) {
  const Database = require('better-sqlite3');
  const raw = new Database(file);
  raw.pragma('busy_timeout = 5000');
  const shim = {
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => raw.exec(sql),
    transaction: async (fn) => fn(shim),
    close: () => raw.close(),
    raw
  };
  return shim;
}

async function startSite(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-site-test-'));
  const config = loadConfig({ dataDir, bcryptRounds: 4, production: false, secureCookies: false, trustProxy: false, setupToken: '', ...overrides });
  const siteDb = await openDb({ dataDir });
  const app = createApp({ config, db: siteDb });
  const db = testDb(path.join(dataDir, 'warehouse.sqlite'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, db, siteDb, config, dataDir,
    async close() {
      app.locals.sessionStore.close();
      await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
      db.close();
      siteDb.close();
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
    }
  };
}

/** متصفح بسيط: يحفظ الكوكي ويقرأ رمز CSRF من الصفحات */
// صورة JPG صغيرة جداً (سند تسليم للاختبارات)
const TEST_RECEIPT = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);

function browser(base) {
  let cookie = '';
  const request = async (method, url, { form, multipart, headers = {} } = {}) => {
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {
        accept: 'text/html',
        ...(cookie ? { cookie } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers
      },
      body: multipart || (form ? (form instanceof URLSearchParams ? form : new URLSearchParams(form)).toString() : undefined)
    });
    const set = res.headers.getSetCookie();
    for (const c of set) { if (c.startsWith('wh.sid=')) cookie = c.split(';')[0]; }
    return res;
  };
  const b = {
    cookie: () => cookie,
    get: (url, opts) => request('GET', url, opts),
    async html(url) { return (await request('GET', url)).text(); },
    async csrf(url) {
      const html = await (await request('GET', url)).text();
      const m = /name="_csrf" value="([^"]+)"/.exec(html);
      assert.ok(m, `لا يوجد رمز CSRF في ${url}`);
      return m[1];
    },
    /** POST برمز CSRF مأخوذ من صفحة (fromPage)، والقيم المصفوفة تُرسل كحقول متكررة */
    async post(url, form = {}, fromPage) {
      // التسليم للموصل يحتاج سند (إجباري): الاختبارات ترفق صورة صغيرة تلقائياً، إلا لو receipt: null
      if (url === '/handover' && form.receipt !== null) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(form)) {
          if (k === 'receipt') continue;
          for (const item of Array.isArray(v) ? v : [v]) fd.append(k, String(item));
        }
        fd.append('_csrf', await b.csrf(fromPage || url));
        const files = form.receipt ? (Array.isArray(form.receipt) ? form.receipt : [form.receipt]) : [{ data: TEST_RECEIPT, type: 'image/jpeg', name: 'receipt.jpg' }];
        for (const f of files) fd.append('receipt', new Blob([f.data], { type: f.type }), f.name);
        return request('POST', url, { multipart: fd });
      }
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) {
        for (const item of Array.isArray(v) ? v : [v]) params.append(k, String(item));
      }
      params.append('_csrf', await b.csrf(fromPage || url));
      return request('POST', url, { form: params });
    },
    /** POST ثم فتح الصفحة التي حُوِّل إليها (لقراءة رسالة النتيجة) */
    async postAndFollow(url, form, fromPage) {
      const res = await b.post(url, form, fromPage);
      assert.equal(res.status, 302, `${url} => ${res.status}`);
      const location = res.headers.get('location');
      return { location, html: await b.html(location) };
    },
    postRaw: (url, form) => request('POST', url, { form })
  };
  return b;
}

const ADMIN = { full_name: 'مدير التجربة', username: 'admin', password: 'correct-horse-1', password2: 'correct-horse-1' };

async function setupAdmin(site) {
  const b = browser(site.base);
  const res = await b.post('/setup', ADMIN);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/integration');
  return b;
}

/** إنشاء مستخدم مباشرة في القاعدة ثم الدخول به */
async function loginAs(site, { username, password = 'test-password-1', role = 'warehouse', fullName = 'مسؤول التجربة', branch = null }) {
  const hash = await auth.hashPassword(site.config, password);
  site.db.prepare('INSERT INTO users (username, password_hash, full_name, role, active, branch, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run(username, hash, fullName, role, branch, new Date().toISOString());
  const b = browser(site.base);
  const res = await b.post('/login', { username, password });
  assert.equal(res.headers.get('location'), '/documents');
  return b;
}

async function newKey(b) {
  const res = await b.post('/admin/integration/rotate', {}, '/admin/integration');
  assert.equal(res.status, 200);
  const m = /id="new-key"[^>]*value="(wh_[^"]+)"/.exec(await res.text());
  assert.ok(m, 'المفتاح الجديد لم يظهر');
  return m[1];
}

function upload(site, key, pdf, meta, { fileName = 'doc.pdf', type = 'application/pdf' } = {}) {
  const form = new FormData();
  if (meta !== undefined) form.append('meta', typeof meta === 'string' ? meta : JSON.stringify(meta));
  if (pdf) form.append('pdf', new Blob([pdf], { type }), fileName);
  return fetch(`${site.base}/api/integration/documents`, { method: 'POST', headers: key ? { authorization: `Bearer ${key}` } : {}, body: form });
}

const clearanceMeta = (pdf, extra = {}) => ({
  doc_type: 'clearance', doc_no: null, sales_order_no: null, customer_number: '3339', customer_name: 'مؤسسة التجربة',
  doc_date: null, sent_at: new Date().toISOString(), source_device: 'ACC-PC-1', file_name: 'Print_1.pdf', sha256: sha256(pdf), meta_problems: [], ...extra
});

module.exports = { TEST_RECEIPT, sha256, fakePdf, startSite, testDb, browser, ADMIN, setupAdmin, loginAs, newKey, upload, clearanceMeta };
