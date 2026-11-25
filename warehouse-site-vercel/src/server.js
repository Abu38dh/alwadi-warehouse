/**
 * تشغيل الموقع محلياً (للتجربة):  npm start
 * على فيرسيل ما يُستخدم هذا الملف — المدخل هناك api/index.js
 */
const { loadConfig, loadEnvFile } = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');

(async () => {
  loadEnvFile();
  const config = loadConfig();
  const db = await openDb({ url: config.databaseUrl, authToken: config.databaseAuthToken, dataDir: config.dataDir });
  const app = createApp({ config, db });

  const server = app.listen(config.port, config.host, async () => {
    const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`موقع المستودع (نسخة فيرسيل) يعمل على: http://${shownHost}:${config.port}`);
    console.log(`القاعدة: ${config.databaseUrl || 'ملف محلي داخل ' + config.dataDir}`);
    const users = (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n;
    if (users === 0) console.log(`أول تشغيل: افتح http://${shownHost}:${config.port}/setup لإنشاء حساب الإدارة.`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`المنفذ ${config.port} مستخدم — غيّر PORT في ملف .env`);
    else console.error('تعذر تشغيل الموقع:', err.message);
    process.exit(1);
  });

  const shutdown = () => {
    server.close(() => { try { db.close(); } catch (_) {} process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((err) => {
  console.error('تعذر تشغيل الموقع:', err.message);
  process.exit(1);
});
