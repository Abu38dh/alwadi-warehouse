/**
 * قاعدة البيانات (نسخة فيرسيل): Turso / libSQL — نفس SQLite بس على الإنترنت.
 *  - DATABASE_URL=libsql://xxx.turso.io + DATABASE_AUTH_TOKEN  (الإنتاج)
 *  - أو ملف محلي: file:data/warehouse.sqlite  (التجربة والاختبارات)
 *
 * الواجهة نفس شكل better-sqlite3 بس كل شيء async:
 *   await db.prepare(sql).get(...args) / .all(...) / .run(...)
 *   await db.exec(sql)
 *   await db.transaction(async (tx) => { await tx.prepare(...).run(...) })
 * داخل المعاملة لازم كل الاستعلامات تمر عبر tx (نفس الواجهة).
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// ---------- تحويل القيم ----------

function toArg(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Buffer.isBuffer(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return v;
}

function isNamed(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Uint8Array) && !(v instanceof Date);
}

/** نفس طريقة better-sqlite3: (a, b, c) أو ({ name: ... }) للأسماء @name / :name / $name */
function toArgs(params) {
  if (params.length === 1 && isNamed(params[0])) {
    const out = {};
    for (const [k, v] of Object.entries(params[0])) out[k] = toArg(v);
    return out;
  }
  const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return flat.map(toArg);
}

function fromValue(v) {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  if (v instanceof Uint8Array && !Buffer.isBuffer(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return v;
}

function rowsOf(rs) {
  const cols = rs.columns;
  return rs.rows.map((r) => {
    const o = {};
    for (let i = 0; i < cols.length; i++) o[cols[i]] = fromValue(r[i]);
    return o;
  });
}

// ---------- الاستعلام ----------

class Statement {
  constructor(exec, sql) { this.exec = exec; this.sql = sql; }
  async get(...params) {
    const rs = await this.exec({ sql: this.sql, args: toArgs(params) });
    return rs.rows.length ? rowsOf(rs)[0] : undefined;
  }
  async all(...params) {
    return rowsOf(await this.exec({ sql: this.sql, args: toArgs(params) }));
  }
  async run(...params) {
    const rs = await this.exec({ sql: this.sql, args: toArgs(params) });
    return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? 0 : Number(rs.lastInsertRowid) };
  }
}

/** داخل معاملة: نفس الواجهة، والمعاملة المتداخلة تكمل على نفس المعاملة */
class TxDb {
  constructor(tx) { this.tx = tx; }
  prepare(sql) { return new Statement((q) => this.tx.execute(q), sql); }
  async exec(sql) { await this.tx.executeMultiple(sql); }
  async transaction(fn) { return fn(this); }
}

class Db {
  constructor(client) { this.client = client; }
  prepare(sql) { return new Statement((q) => this.client.execute(q), sql); }
  async exec(sql) { await this.client.executeMultiple(sql); }
  async transaction(fn) {
    const tx = await this.client.transaction('write');
    try {
      const result = await fn(new TxDb(tx));
      await tx.commit();
      return result;
    } catch (err) {
      try { await tx.rollback(); } catch (_) {}
      throw err;
    } finally {
      tx.close();
    }
  }
  close() { this.client.close(); }
}

// ---------- الفتح والتجهيز ----------

async function migrate(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set((await db.prepare('SELECT name FROM schema_migrations').all()).map(r => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').run(file, new Date().toISOString());
    });
  }
}

/**
 * يفتح القاعدة ويطبّق الـ migrations.
 * @param {object} o
 * @param {string} [o.url]  libsql://... أو file:...
 * @param {string} [o.authToken]
 * @param {string} [o.dataDir]  للتجربة: ملف محلي داخل هذا المجلد
 */
async function openDb({ url, authToken, dataDir } = {}) {
  let dbUrl = url;
  if (!dbUrl) {
    if (!dataDir) throw new Error('DATABASE_URL مطلوب');
    fs.mkdirSync(dataDir, { recursive: true });
    dbUrl = 'file:' + path.join(dataDir, 'warehouse.sqlite').split(path.sep).join('/');
  }
  const client = createClient({ url: dbUrl, authToken: authToken || undefined, intMode: 'number' });
  const db = new Db(client);
  if (dbUrl.startsWith('file:')) {
    await db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  }
  await db.exec('PRAGMA foreign_keys = ON;');
  await migrate(db);
  return db;
}

// ---------- جدول الإعدادات (مفتاح => JSON) ----------

async function getSetting(db, key, fallback = null) {
  const row = await db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch (_) { return fallback; }
}

async function setSetting(db, key, value) {
  await db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

async function audit(db, { userId = null, action, details = null, ip = null }) {
  await db.prepare('INSERT INTO audit_log (user_id, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, action, details == null ? null : String(details).slice(0, 500), ip, new Date().toISOString());
}

module.exports = { openDb, migrate, getSetting, setSetting, audit, Db };
