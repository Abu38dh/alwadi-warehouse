/**
 * اختبار تنبيهات ويندوز (بدون إظهارها على الشاشة).
 * التشغيل: npm test
 */
process.env.ALWADY_NO_WINDOW = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const notifier = require('./notify');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('نفس التنبيه لا يتكرر خلال المدة المحددة، ويعود بعد "نسيانه"', () => {
  const before = notifier.history.length;
  assert.equal(notifier.notify('wa-test', { title: 'واتساب غير متصل', text: 'x', minIntervalMs: 60000 }), true);
  assert.equal(notifier.notify('wa-test', { title: 'واتساب غير متصل', text: 'x', minIntervalMs: 60000 }), false);
  notifier.forget('wa-test');
  assert.equal(notifier.notify('wa-test', { title: 'واتساب غير متصل', text: 'x', minIntervalMs: 60000 }), true);
  assert.equal(notifier.history.length - before, 2);
});

test('مستند واحد يحتاج مراجعة => تنبيه باسمه وسببه', async () => {
  const before = notifier.history.length;
  notifier.notifyReview('Print_001.pdf', 'لا يوجد قروب للعميل [3226]', { delayMs: 50 });
  await sleep(120);
  const n = notifier.history.slice(before);
  assert.equal(n.length, 1);
  assert.match(n[0].title, /يحتاج مراجعة/);
  assert.match(n[0].text, /Print_001\.pdf/);
  assert.match(n[0].text, /3226/);
});

test('عدة مستندات في نفس الوقت => تنبيه واحد فقط (بدون إزعاج)', async () => {
  const before = notifier.history.length;
  for (let i = 0; i < 5; i++) notifier.notifyReview(`Print_00${i}.pdf`, 'سبب', { delayMs: 50 });
  await sleep(120);
  const n = notifier.history.slice(before);
  assert.equal(n.length, 1);
  assert.match(n[0].title, /^5 مستندات/);
});

test('أي نص (اسم قروب/ملف) لا يُكتب داخل أمر PowerShell بل يُمرَّر كمتغير => لا يمكن أن يتحول إلى أمر', () => {
  const evil = "قروب 3226 ‘; Remove-Item C:/x ;’ ' \" $(calc)";
  notifier.configure({ url: 'http://127.0.0.1:3500' });
  const script = notifier.buildNotificationScript();
  assert.ok(!script.includes('3226'), 'النص لا يدخل في نص الأمر');
  assert.ok(!script.includes('Remove-Item'));
  const env = notifier.notificationEnv({ title: evil, text: evil, level: 'error' });
  assert.equal(env.ALWADY_N_TITLE, evil);
  assert.equal(env.ALWADY_N_TEXT, evil);
  assert.equal(env.ALWADY_N_LEVEL, 'Error');
  assert.equal(notifier.notificationEnv({ title: 'a', text: 'b', level: 'x; calc' }).ALWADY_N_LEVEL, 'Info');
});
