/**
 * برنامج الواتساب "عن بعد" (نسخة فيرسيل).
 *
 * البرنامج على جهاز الشركة، وفيرسيل ما يقدر يكلمه. فالبرنامج هو اللي يتصل كل 10 ثواني:
 *  - يرسل حالته (الاتصال، الباركود، سجل الإرسال، النقدي، الإعدادات) لما تتغير => تنحفظ هنا
 *  - وياخذ أوامر الإدارة (حفظ الإعدادات، إعادة الإرسال، تمت الطباعة…) => ينفذها ويرجّع النتيجة
 *
 * RemoteEngine له نفس شكل البرنامج المدمج في الموقع المحلي (get/post/status/restart)، عشان صفحات
 * "واتساب والإرسال" تشتغل زي ما هي.
 */
const storage = require('./storage');
const { getSetting, setSetting } = require('../db');

const STATE_KEY = 'engine/state.json';
const STATE_META = 'engine_state_meta';
const OFFLINE_AFTER_MS = 3 * 60 * 1000;      // ما وصلت حالة من 3 دقائق = البرنامج مطفي
const EXPIRE_AFTER_MS = 5 * 60 * 1000;        // أمر ما انسحب خلال 5 دقائق ينلغي
const RETAKE_AFTER_MS = 2 * 60 * 1000;        // أمر انسحب وما رجعت نتيجته: يتعرض مرة ثانية (البرنامج ما ينفذه مرتين)
const MAX_WAIT_MS = 25000;

class EngineDown extends Error {}
let lastCleanup = 0;

// ---------- الحالة ----------

async function saveState(db, state) {
  if (!state || typeof state !== 'object') return;
  await storage.replaceFile(db, STATE_KEY, Buffer.from(JSON.stringify(state), 'utf8'));
  await setSetting(db, STATE_META, { at: new Date().toISOString() });
}

/** آخر حالة + متى وصلت (آخر اتصال من البرنامج = آخر مزامنة، حتى لو الحالة ما تغيّرت) */
async function loadState(db) {
  const [buf, meta, seen] = await Promise.all([storage.getFile(db, STATE_KEY), getSetting(db, STATE_META, null), getSetting(db, 'engine_last_sync', null)]);
  let state = null;
  if (buf) { try { state = JSON.parse(buf.toString('utf8')); } catch (_) {} }
  const lastSync = seen && seen.at ? Date.parse(seen.at) : (meta && meta.at ? Date.parse(meta.at) : 0);
  return { state, lastSync, online: !!state && Date.now() - lastSync < OFFLINE_AFTER_MS };
}

// ---------- الأوامر ----------

async function enqueue(db, { method, path, body, userId }) {
  const info = await db.prepare('INSERT INTO engine_commands (method, path, body_json, status, user_id, created_at) VALUES (?, ?, ?, \'pending\', ?, ?)')
    .run(String(method).toUpperCase(), String(path).slice(0, 2000), body === undefined ? null : JSON.stringify(body), userId || null, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

/** مزامنة من البرنامج: نتائج الأوامر + الحالة (لو تغيّرت) => الأوامر الجديدة */
async function sync(db, { state, results }) {
  const now = new Date();
  await setSetting(db, 'engine_last_sync', { at: now.toISOString() });
  if (state) await saveState(db, state);
  for (const r of Array.isArray(results) ? results.slice(0, 50) : []) {
    const id = Number(r && r.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    await db.prepare("UPDATE engine_commands SET status = 'done', result_json = ?, done_at = ? WHERE id = ? AND status IN ('pending', 'taken')")
      .run(JSON.stringify({ status: Number(r.status) || 200, json: r.json === undefined ? null : r.json }), now.toISOString(), id);
  }
  // تنظيف: الأوامر المنتهية الأقدم من يوم تنحذف (نتائجها ممكن فيها ملفات) — مرة كل 10 دقائق
  if (now - lastCleanup > 10 * 60 * 1000) {
    lastCleanup = now.getTime();
    await db.prepare("DELETE FROM engine_commands WHERE status IN ('done', 'expired') AND created_at < ?").run(new Date(now - 24 * 60 * 60 * 1000).toISOString());
  }
  // القديمة اللي ما انسحبت تنلغي (البرنامج كان مطفي)
  await db.prepare("UPDATE engine_commands SET status = 'expired' WHERE status = 'pending' AND created_at < ?").run(new Date(now - EXPIRE_AFTER_MS).toISOString());
  const rows = await db.prepare("SELECT id, method, path, body_json FROM engine_commands WHERE status = 'pending' OR (status = 'taken' AND taken_at < ?) ORDER BY id ASC LIMIT 10")
    .all(new Date(now - RETAKE_AFTER_MS).toISOString());
  for (const c of rows) await db.prepare("UPDATE engine_commands SET status = 'taken', taken_at = ? WHERE id = ?").run(now.toISOString(), c.id);
  return rows.map(c => ({ id: c.id, method: c.method, path: c.path, body: c.body_json ? JSON.parse(c.body_json) : undefined }));
}

/** تلميحات للبرنامج: هل فيه رسائل عملاء أو مستندات فروع تنتظره؟ (عشان ما يسأل عنها كل 10 ثواني على الفاضي) */
async function hints(db) {
  const [n, r] = await Promise.all([
    db.prepare("SELECT 1 AS x FROM wa_notifications WHERE state = 'pending' LIMIT 1").get(),
    db.prepare("SELECT 1 AS x FROM relay_jobs WHERE status IN ('waiting', 'taken') LIMIT 1").get()
  ]);
  return { notifications: !!n, relay: !!r };
}

async function waitResult(db, id, timeoutMs) {
  const end = Date.now() + Math.min(timeoutMs || MAX_WAIT_MS, MAX_WAIT_MS);
  while (Date.now() < end) {
    const row = await db.prepare('SELECT status, result_json FROM engine_commands WHERE id = ?').get(id);
    if (row && row.status === 'done') return row.result_json ? JSON.parse(row.result_json) : { status: 200, json: null };
    if (row && row.status === 'expired') return null;
    await new Promise(r => setTimeout(r, 800));
  }
  return null;
}

// ---------- نفس شكل البرنامج المدمج ----------

const OFFLINE_MESSAGE = 'برنامج الواتساب على جهاز الشركة ما يرد (الجهاز مطفي أو بدون نت).';
const PENDING_MESSAGE = 'انرسل الطلب لبرنامج الواتساب وما رد للحين — يتنفذ أول ما يرد. حدّث الصفحة بعد شوي.';

class RemoteEngine {
  constructor(db) { this.db = db; this.cache = null; }

  /** آخر حالة (تنقرأ من جديد مع كل طلب — البرنامج يحدّثها كل 10 ثواني) */
  async current() {
    this.cache = { ...(await loadState(this.db)), loadedAt: Date.now() };
    return this.cache;
  }

  /** للقوالب: هل البرنامج يتواصل (الحالة محملة مسبقاً في الطلب) */
  status() {
    const c = this.cache;
    return { running: !!(c && c.online), remote: true, lastSync: c ? c.lastSync : 0 };
  }

  async restart(userId) {
    await enqueue(this.db, { method: 'POST', path: '/__restart', userId });
  }

  async call(method, path, body, { timeoutMs, userId } = {}) {
    const c = await this.current();
    const m = String(method).toUpperCase();
    const p = String(path);
    const base = p.split('?')[0];
    if (m === 'GET' && base !== '/api/document-data') {
      if (!c.state) throw new EngineDown(OFFLINE_MESSAGE);
      const s = c.state;
      const map = {
        '/api/status': s.status || {},
        '/api/logs': s.logs || [],
        '/api/cash-pending': { items: s.cash || [] },
        '/api/settings': s.settings || {},
        '/api/warehouse': s.warehouse || {}
      };
      if (!(base in map)) throw new EngineDown('غير متاح');
      // البرنامج مطفي: الحالة "متوقف" (السجل والإعدادات آخر نسخة وصلت)
      if (base === '/api/status' && !c.online) return { status: 200, json: { ...map[base], status: 'down', qrSvg: null } };
      return { status: 200, json: map[base] };
    }
    if (!c.online) throw new EngineDown(OFFLINE_MESSAGE);
    const id = await enqueue(this.db, { method: m, path: p, body, userId });
    const r = await waitResult(this.db, id, timeoutMs);
    if (!r) throw new EngineDown(PENDING_MESSAGE);
    this.cache = null; // الحالة تتحدث بعد الأمر
    return r;
  }
}

module.exports = { EngineDown, RemoteEngine, sync, hints, loadState, saveState, enqueue, OFFLINE_MESSAGE };
