/**
 * اختبارات استخراج رقم العميل من كشوف الحساب ("رقم الحساب : 112110-3226")
 * التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCustomerNumber, detectDocumentType } = require('./index');
const { buildGroupIndex, findGroupForCustomer } = require('./group-matcher');

const STATEMENT = [
  'مؤسسة الوادي لقطع غيار السيارات',
  '- كيلو 2',
  'رقم الحساب : 112110-3226',
  'نوع السند رقم السند',
  'سند قبض 41387 دفعه من',
  'مرتجع مبيعات 41390'
].join('\n');

const ok = (text, expected) => {
  const r = extractCustomerNumber(text);
  assert.equal(r.success, true, r.reason);
  assert.equal(r.customerNumber, expected);
};
const fails = (text) => assert.equal(extractCustomerNumber(text).success, false);

test('كشف الحساب: رقم العميل هو الرقم بعد 112110', () => {
  ok(STATEMENT, '3226');
});

test('كشف الحساب يُصنَّف "كشف حساب" حتى لو فيه كلمة مرتجع في الحركات', () => {
  assert.equal(detectDocumentType(STATEMENT).id, 'statement');
  assert.equal(detectDocumentType('كشف حساب عميل').id, 'statement');
});

test('النص المعكوس من PDF: 3226-112110 و "باسحلا مقر"', () => {
  ok('3226-112110 : باسحلا مقر', '3226');
  ok('112110-3226 : رقم الحساب', '3226');
});

test('أرقام عربية وشرطة طويلة ومسافات وعلامات اتجاه مخفية', () => {
  ok('رقم الحساب : ١١٢١١٠–٣٢٢٦', '3226');
  ok('رقم الحساب : 112110 - 3226', '3226');
  ok('رقم الحساب : 112110‏-‎3226', '3226');
});

test('نفس رقم الحساب مكرر في الكشف => مقبول', () => {
  ok(STATEMENT + '\nرقم الحساب : 112110-3226', '3226');
});

test('رقمي حساب مختلفين => لا إرسال', () => {
  fails(STATEMENT + '\n112110-3227');
});

test('كود غير 112110 (مثل حساب مورد) => لا يُعتبر رقم عميل', () => {
  fails('رقم الحساب : 221100-3226');
  fails('رقم الحساب : 1121100-3226');
  assert.equal(detectDocumentType('رقم الحساب : 221100-3226').id, 'invoice');
});

test('سلسلة غامضة 5-112110-3226 => لا إرسال', () => {
  fails('رقم الحساب : 5-112110-3226');
});

test('رقم العميل يتعارض مع رقم الحساب => لا إرسال، ويتفقان => مقبول', () => {
  fails('رقم العميل: 1001\nرقم الحساب : 112110-3226');
  ok('رقم العميل: 3226\nرقم الحساب : 112110-3226', '3226');
});

test('فاتورة مطبوعة من Word على طابعة البرنامج: الوسم معكوس جزئياً "مقر العميل"', async () => {
  const { parsePdf } = require('./index');
  const text = (await parsePdf(require('fs').readFileSync(require('path').join(__dirname, 'samples', 'word_print_invoice_1001.pdf')))).text;
  ok(text, '1001');
  assert.equal(detectDocumentType(text).id, 'invoice');
  ok('1001\n \n مقر  العميل  :\n \n2026-11-15', '1001');
});

test('رقم آخر قبل الوسم في نفس السطر لا يُؤخذ كرقم عميل (تعارض => لا إرسال)', () => {
  fails('رقم الفاتورة: 101 رقم العميل: 3226');
  fails('رقم الفاتورة:\n101\nرقم العميل:\n3226');
  ok('رقم العميل: 3226  رقم الفاتورة: 101', '3226');
  ok('رقم العميل: 01001 ... 1001 رقم العميل', '1001');
});

test('"Customs" (جمارك) لا تُعتبر "Cust" (عميل)', () => {
  ok('3226 : ليمعلا مقر\nCustoms Declaration No: 445566', '3226');
  ok('Customer No: 77', '77');
  ok('Cust# 88', '88');
});

test('الفواتير العادية لم تتغير', () => {
  ok('فاتورة ضريبية\nرقم العميل: 1001\nالتاريخ 2026-11-15', '1001');
  assert.equal(detectDocumentType('فاتورة ضريبية\nرقم العميل: 1001').id, 'invoice');
});

test('رقم العميل من الكشف يطابق القروب بنفس القواعد الصارمة', () => {
  const idx = buildGroupIndex([
    { id: 'a@g.us', name: 'ورشة الأمانة 3226' },
    { id: 'b@g.us', name: 'محل 13226' }
  ]);
  const customer = extractCustomerNumber(STATEMENT).customerNumber;
  const r = findGroupForCustomer(idx, customer);
  assert.equal(r.status, 'match');
  assert.equal(r.group.id, 'a@g.us');
});
