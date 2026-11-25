/**
 * التقارير تنسب المستند للعميل بس لو رقمه مؤكد.
 * مثال: فسح بدون رقم عميل وفيه "TEST-0006" — البرنامج يرفض 0006 كرقم عميل (صح)، وما لازم يطلع في التقارير كعميل 0006.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-attr-'));
process.env.ALWADY_DATA_DIR = dir;
process.env.ALWADY_HOSTED = '1';
process.env.ALWADY_TEST_LOCK = process.env.ALWADY_TEST_LOCK || 'unit-report-attr';
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./index');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('رقم "مشتبه" ما ينحسب على عميل في التقارير، والرقم المؤكد ينحسب', () => {
  const file = (name) => { const f = path.join(dir, name); fs.writeFileSync(f, '%PDF-1.4 test ' + name); return f; };
  // فسح انرسل للمستودع ورقم العميل ما انقرأ (المعروض "0006" مشتبه)
  app.markFileAsProcessed(file('Print_a.pdf'), 'sent', { docType: 'فسوحات', customerNumber: '0006', reportCustomer: '' });
  // فسح رقم عميله مؤكد
  app.markFileAsProcessed(file('Print_b.pdf'), 'sent', { docType: 'فسوحات', customerNumber: '0004', reportCustomer: '0004' });
  // مستند قديم بدون reportCustomer: يبقى زي ما كان (رقمه هو المؤكد)
  app.markFileAsProcessed(file('Print_c.pdf'), 'sent', { docType: 'فواتير', customerNumber: '1094' });
  const recs = app.customerReports().activity.records.map(r => [r.file, r.customer]);
  assert.deepEqual(recs.filter(([f]) => f === 'Print_a.pdf'), [], 'ما يتسجل على 0006');
  assert.deepEqual(recs.filter(([f]) => f === 'Print_b.pdf'), [['Print_b.pdf', '0004']]);
  assert.deepEqual(recs.filter(([f]) => f === 'Print_c.pdf'), [['Print_c.pdf', '1094']]);
});
