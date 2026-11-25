/**
 * اختبار سجل العملاء وتقاريرهم.
 * التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CustomerReport, parseCustomerListFromCsv, localMonth } = require('./customer-report');

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cust-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new CustomerReport({ dataDir: dir });
  s.importCustomers([
    { number: '0004', repCode: '1021', repName: 'باوزير' },
    { number: '1094', repCode: '1003', repName: 'احمد الحوكي' },
    { number: '3226', repCode: '1003', repName: 'احمد الحوكي' }
  ], 'test');
  return { s, dir };
}

test('القائمة المرفقة مع البرنامج: 487 عميل بأسماء المناديب صحيحة', () => {
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'customers-list.default.json'), 'utf8')).customers;
  assert.equal(list.length, 487);
  assert.equal(new Set(list.map(c => c.number)).size, 487);
  assert.deepEqual(list.find(c => c.number === '1094'), { number: '1094', repCode: '1003', repName: 'احمد الحوكي' });
  assert.deepEqual(list.find(c => c.number === '0004'), { number: '0004', repCode: '1021', repName: 'باوزير' });
  const reps = {};
  for (const c of list) reps[c.repName] = (reps[c.repName] || 0) + 1;
  assert.deepEqual(reps, { 'باوزير': 129, 'احمد الحوكي': 93, 'وليد اليافعي': 91, 'اسلام': 94, 'باقطيان': 57, 'اديب': 23 });
});

test('كل مستند يُسجل للعميل، ونفس المستند بعد إعادة الإرسال لا يتكرر', (t) => {
  const { s, dir } = store(t);
  s.record({ file: 'a.pdf', customerNumber: '3226', docSubfolder: 'فواتير', status: 'review', reason: 'لا يوجد قروب' });
  s.record({ file: 'a.pdf', customerNumber: '3226', docSubfolder: 'فواتير', status: 'sent', destination: 'قروب: مؤسسة الأمانة 3226' });
  const h = s.history('3226');
  assert.equal(h.length, 1);
  assert.equal(h[0].status, 'sent');
  assert.equal(h[0].group, 'مؤسسة الأمانة 3226');
  assert.ok(h[0].sentAt);
  // يبقى بعد إعادة تشغيل البرنامج
  assert.equal(new CustomerReport({ dataDir: dir }).history('3226').length, 1);
});

test('التقرير: مين طلب ومين ما طلب، مين انرسل له كشف، حسب الشهر', (t) => {
  const { s } = store(t);
  s.record({ file: 'DESKTOP-A__inv1.pdf', customerNumber: '1094', docSubfolder: 'فواتير', status: 'sent', destination: 'قروب: x 1094' });
  s.record({ file: 'inv2.pdf', customerNumber: '1094', docSubfolder: 'فواتير', status: 'review', reason: 'x' });
  s.record({ file: 'st1.pdf', customerNumber: '3226', docSubfolder: 'كشوفات', status: 'sent' });
  s.record({ file: 'ret.pdf', customerNumber: '1094', docSubfolder: 'مرتجعات', status: 'sent' });
  s.record({ file: 'cash.pdf', customerNumber: '9999', docSubfolder: 'فواتير', status: 'skipped', kind: 'cash' });
  s.record({ file: 'clr.pdf', customerNumber: '0004', docSubfolder: 'فسوحات', status: 'skipped', kind: 'stopped' });

  const r = s.report({ hasGroup: (n) => n === '1094' });
  const row = (n) => r.rows.find(x => x.number === n);
  assert.equal(r.customersCount, 3);
  assert.deepEqual(r.summary.ordered, 1);
  assert.deepEqual(r.summary.notOrdered, 2);
  assert.equal(r.summary.statementSent, 1);
  assert.equal(row('1094').invoices, 2);
  assert.equal(row('1094').invoicesSent, 1);
  assert.equal(row('1094').returns, 1);
  assert.equal(row('1094').problems, 1);
  assert.equal(row('1094').hasGroup, true);
  assert.equal(row('0004').hasGroup, false);
  assert.equal(row('0004').clearances, 1);
  assert.equal(row('3226').statementsSent, 1);
  assert.equal(row('9999').known, false, 'عميل خارج القائمة يظهر منفصلاً');
  assert.equal(row('9999').cash, 1);
  assert.equal(s.history('1094').find(h => h.file === 'DESKTOP-A__inv1.pdf').device, 'DESKTOP-A');

  // شهر ثاني: ما فيه شي
  const other = s.report({ month: '2020-01' });
  assert.equal(other.summary.documents, 0);
  assert.equal(other.summary.notOrdered, 3);
});

test('رقم العميل بأصفار في البداية (0004 = 4) يُطابق نفس العميل', (t) => {
  const { s } = store(t);
  s.record({ file: 'z.pdf', customerNumber: '4', docSubfolder: 'فواتير', status: 'sent' });
  const r = s.report({});
  assert.equal(r.rows.find(x => x.number === '0004').invoices, 1);
  assert.equal(r.rows.filter(x => !x.known).length, 0);
});

test('مستند بدون رقم عميل صحيح لا يُسجل', (t) => {
  const { s } = store(t);
  assert.equal(s.record({ file: 'x.pdf', customerNumber: '-', docSubfolder: 'فواتير', status: 'review' }), false);
  assert.equal(s.record({ file: 'y.pdf', customerNumber: '1001, 2002', docSubfolder: 'فواتير', status: 'review' }), false);
  assert.equal(s.activity.records.length, 0);
});

test('استيراد قائمة العملاء من CSV / Excel', () => {
  const list = parseCustomerListFromCsv('﻿#,customer_no,rep_code,rep_name\n1,0004,1021,باوزير\n2,1094,1003,احمد الحوكي\n');
  assert.deepEqual(list, [{ number: '0004', repCode: '1021', repName: 'باوزير' }, { number: '1094', repCode: '1003', repName: 'احمد الحوكي' }]);
  const simple = parseCustomerListFromCsv('customer_no;rep_code;rep_name\n3236;;اديب\n');
  assert.deepEqual(simple, [{ number: '3236', repCode: '', repName: 'اديب' }]);
});

test('الشهر حسب توقيت الجهاز', () => {
  const d = new Date(2026, 10, 30, 23, 30); // 30 نوفمبر 11:30 ليلاً بالتوقيت المحلي
  assert.equal(localMonth(d.toISOString()), '2026-11');
});

test('التقرير بين تاريخين محددين (شاملة اليومين)', (t) => {
  const { s } = store(t);
  const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();
  s.record({ file: 'a.pdf', customerNumber: '1094', docSubfolder: 'فواتير', status: 'sent' });
  s.record({ file: 'b.pdf', customerNumber: '3226', docSubfolder: 'فواتير', status: 'sent' });
  s.record({ file: 'c.pdf', customerNumber: '0004', docSubfolder: 'كشوفات', status: 'sent' });
  s.activity.records[0].at = at(2026, 11, 1, 0);   // أول دقيقة في 1 نوفمبر
  s.activity.records[1].at = at(2026, 11, 15);
  s.activity.records[2].at = at(2026, 11, 20, 23); // آخر ساعة في 20 نوفمبر
  const r = s.report({ from: '2026-11-01', to: '2026-11-15' });
  assert.equal(r.from, '2026-11-01'); assert.equal(r.to, '2026-11-15');
  assert.equal(r.summary.documents, 2);
  assert.equal(r.summary.ordered, 2);
  assert.equal(s.report({ from: '2026-11-16', to: '2026-11-20' }).summary.statementSent, 1);
  assert.equal(s.report({ from: '2026-11-21', to: '2026-11-30' }).summary.documents, 0);
  assert.equal(s.report({ from: '2026-11-15', to: '2026-11-15' }).summary.documents, 1, 'يوم واحد');
  assert.equal(s.report({ from: '2026-11-20', to: '2026-11-01' }).summary.documents, 3, 'لو انعكس التاريخان يُصحح');
  const def = s.report({});
  assert.ok(def.from.endsWith('-01') && def.to >= def.from, 'الافتراضي: من أول الشهر لليوم');
});

test('ملف Excel الحقيقي (xlsx): أعمدة منفصلة، من اليمين لليسار، رقم العميل يبقى بأصفاره', () => {
  const { buildXlsx, crc32 } = require('./xlsx-writer');
  const buf = buildXlsx({ sheetName: 'ما طلبوا', title: 'تقرير', headers: ['رقم العميل', 'فواتير'], rows: [['0004', 0], ['1094', 3]] });
  assert.equal(buf.slice(0, 2).toString(), 'PK');
  const text = buf.toString('utf8');
  assert.ok(text.includes('rightToLeft="1"'));
  assert.ok(text.includes('<t xml:space="preserve">0004</t>'), 'رقم العميل نص');
  assert.ok(/<c r="B4" s="2"><v>3<\/v><\/c>/.test(text), 'عدد الفواتير رقم');
  assert.ok(text.includes('name="ما طلبوا"'));
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926, 'CRC32 صحيح');
});

test('سجل العملاء ما ينمسح: ملف تالف يرجع من النسخة الاحتياطية، وملف ما ينقرأ ما يُكتب فوقه', (t) => {
  const { s, dir } = store(t);
  s.record({ file: 'a.pdf', size: 100, customerNumber: '1094', docSubfolder: 'فواتير', status: 'sent' });
  s.record({ file: 'b.pdf', size: 200, customerNumber: '3226', docSubfolder: 'فواتير', status: 'sent' });
  const f = path.join(dir, 'customer-activity.json');
  // انقطاع كهرباء أثناء الحفظ => ملف تالف: يرجع من .bak (فيه السجل قبل آخر حفظ)
  fs.writeFileSync(f, '{"records": [ {"file": "a.p');
  const restored = new CustomerReport({ dataDir: dir });
  assert.ok(restored.activity.records.length >= 1, 'رجع من النسخة الاحتياطية');
  assert.equal(restored.activityWritable, true);
  // الملف والنسخة الاحتياطية كلهم تالفين => ما يكتب فوقهم أبداً
  fs.writeFileSync(f, 'xx'); fs.writeFileSync(f + '.bak', 'yy');
  const broken = new CustomerReport({ dataDir: dir });
  assert.equal(broken.activityWritable, false);
  assert.equal(broken.record({ file: 'c.pdf', size: 1, customerNumber: '1094', docSubfolder: 'فواتير', status: 'sent' }), false);
  assert.equal(fs.readFileSync(f, 'utf8'), 'xx', 'الملف ما انكتب فوقه');
  assert.ok(broken.loadError);
});

test('ملفين بنفس الاسم (مستندين مختلفين) ينحسبون اثنين، ونفس المستند بعد إعادة الإرسال واحد', (t) => {
  const { s } = store(t);
  s.record({ file: 'فاتورة.pdf', size: 1000, customerNumber: '1094', docSubfolder: 'فواتير', status: 'sent' });
  s.record({ file: 'فاتورة.pdf', size: 2222, customerNumber: '1094', docSubfolder: 'فواتير', status: 'sent' });
  s.record({ file: 'x.pdf', size: 50, customerNumber: '3226', docSubfolder: 'فواتير', status: 'review' });
  s.record({ file: 'x.pdf', size: 50, customerNumber: '3226', docSubfolder: 'فواتير', status: 'sent' });
  assert.equal(s.history('1094').length, 2);
  assert.equal(s.history('3226').length, 1);
  assert.equal(s.history('3226')[0].status, 'sent');
});

test('استيراد قائمة العملاء: لازم عمود رقم العميل، وملف أصغر بكثير يطلب تأكيد، والقديمة تنحفظ', (t) => {
  const { s, dir } = store(t);
  assert.throws(() => parseCustomerListFromCsv('1094,12,احمد,0551234567\n'), /customer_no/);
  const cols = parseCustomerListFromCsv('رقم المندوب,customer_no,اسم المندوب,phone\n12,1094,احمد,0551\n');
  assert.deepEqual(cols, [{ number: '1094', repCode: '12', repName: 'احمد' }], 'الأعمدة حسب العناوين');
  const big = Array.from({ length: 40 }, (_, i) => ({ number: String(1000 + i), repCode: '1', repName: 'x' }));
  s.importCustomers(big, 'big');
  assert.throws(() => s.importCustomers([{ number: '5555' }], 'small'), (e) => e.needsConfirm === true);
  assert.equal(s.customers.customers.length, 40, 'القائمة ما تغيرت');
  assert.equal(s.importCustomers([{ number: '5555' }], 'small', { force: true }), 1);
  assert.ok(fs.readdirSync(dir).some(f => /^customers-list\.before-\d+\.json$/.test(f)), 'نسخة من القائمة القديمة');
});
