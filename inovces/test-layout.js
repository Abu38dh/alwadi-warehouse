/**
 * اختبار قراءة رقم العميل من شكل الصفحة (مواضع مربعات النص) — لفواتير برنامج المحاسبة
 * التي تحفظ مربعات النص داخل الملف بترتيب مختلف عن شكلها.
 * ملفات الاختبار مطبوعة فعلاً عبر "Microsoft Print to PDF" (نفس تعريف طابعة البرنامج).
 * التشغيل: npm test
 */
process.env.ALWADY_TEST_LOCK = process.env.ALWADY_TEST_LOCK || 'unit-layout';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parsePdf, extractCustomerNumber, buildVisualLines } = require('./index');

async function extract(name) {
  const d = await parsePdf(fs.readFileSync(path.join(__dirname, 'samples', name)));
  return extractCustomerNumber(d.text, d.layoutItems);
}

test('فاتورة برنامج المحاسبة: رقم العميل 1094 يُقرأ صح مهما كان ترتيب النص داخل الملف', async () => {
  for (const f of ['report_invoice_shifted_1094.pdf', 'report_invoice_labels_first_1094.pdf', 'report_invoice_values_first_1094.pdf']) {
    const r = await extract(f);
    assert.equal(r.success, true, `${f}: ${r.reason}`);
    assert.equal(r.customerNumber, '1094', f);
  }
});

test('لا يُؤخذ رقم أمر البيع (1911020) ولا رقم الصنف (28113) بدل رقم العميل', async () => {
  const d = await parsePdf(fs.readFileSync(path.join(__dirname, 'samples', 'report_invoice_shifted_1094.pdf')));
  // الطريقة القديمة (ترتيب النص فقط) كانت تلتقط أرقاماً خاطئة
  assert.equal(extractCustomerNumber(d.text).success, false);
  const r = extractCustomerNumber(d.text, d.layoutItems);
  assert.equal(r.customerNumber, '1094');
});

test('خانة رقم العميل فاضية => لا إرسال (حتى لو بجانبها خانة فيها رقم)', async () => {
  for (const f of ['report_invoice_empty_customer.pdf', 'report_invoice_empty_customer_next_cell.pdf']) {
    const r = await extract(f);
    assert.equal(r.success, false, `${f} كان سيُرسل لـ ${r.customerNumber}`);
  }
});

test('مستند فيه رقمي عميل مختلفين => لا إرسال (كما كان)', async () => {
  const r = await extract('invoice_conflict.pdf');
  assert.equal(r.success, false);
  assert.deepEqual([...r.uniqueNumbers].sort(), ['1001', '2002']);
});

test('الأشكال السابقة ما زالت تعمل: Word، الأرقام العربية، الوسم المعكوس، الفسح، المرتجع، الجدول', async () => {
  const expected = {
    'word_print_invoice_1001.pdf': '1001',
    'invoice_1001.pdf': '1001',
    'invoice_1002_arabic_digits.pdf': '1002',
    'invoice_9999_cash.pdf': '9999',
    'invoice_reversed_label.pdf': '1001',
    'sample_clearance.pdf': '1001',
    'sample_return.pdf': '1001',
    'table_invoice_header_4321.pdf': '4321'
  };
  for (const [f, n] of Object.entries(expected)) {
    const r = await extract(f);
    assert.equal(r.success, true, `${f}: ${r.reason}`);
    assert.equal(r.customerNumber, n, f);
  }
  assert.equal((await extract('invoice_no_customer.pdf')).success, false);
});

test('السطر كما تراه العين: الرقم ملاصق للوسم', async () => {
  const d = await parsePdf(fs.readFileSync(path.join(__dirname, 'samples', 'report_invoice_labels_first_1094.pdf')));
  const line = buildVisualLines(d.layoutItems).find(l => /ليمعلا|العميل/.test(l.text));
  assert.match(line.text, /1094\s*:\s*(ليمعلا|العميل)/);
});

test('التعرف على الفسح والمرتجع حتى لو خرجت الكلمة مقلوبة الحروف أو بأشكال خاصة', async () => {
  const { detectDocumentType } = require('./index');
  assert.equal(detectDocumentType('بيان فسح جمركي').id, 'clearance');
  assert.equal(detectDocumentType('يكرمج حسف نايب').id, 'clearance');
  assert.equal(detectDocumentType('ﻓﺴﺢ ﺟﻤﺮﻛﻲ').id, 'clearance'); // أشكال الحروف الخاصة
  assert.equal(detectDocumentType('تاعيبم عجترم').id, 'return');
  assert.equal(detectDocumentType('فاتورة ضريبية مبيعات آجلة').id, 'invoice');
  const d = await parsePdf(fs.readFileSync(path.join(__dirname, 'samples', 'report_clearance_3339.pdf')));
  assert.equal(detectDocumentType(d.text).id, 'clearance');
});

test('اسم الملف للعميل: نوع المستند + رقم العميل', () => {
  const { customerFileName, DOC_TYPES } = require('./index');
  assert.equal(customerFileName(DOC_TYPES.INVOICE, '1094'), 'فاتورة 1094.pdf');
  assert.equal(customerFileName(DOC_TYPES.STATEMENT, '3226'), 'كشف حساب 3226.pdf');
  assert.equal(customerFileName(DOC_TYPES.RETURN, '1094'), 'مرتجع 1094.pdf');
  assert.equal(customerFileName(DOC_TYPES.CLEARANCE, '1094'), 'فسح 1094.pdf');
  assert.equal(customerFileName(DOC_TYPES.INVOICE, '10/94\..'), 'فاتورة 1094.pdf', 'لا رموز غريبة في الاسم');
});

test('رقم العميل من كل الجهات: يمين الكلمة، تحتها، ورقمين حولها => مراجعة', async () => {
  assert.equal((await extract('dir_value_right_1094.pdf')).customerNumber, '1094');
  assert.equal((await extract('dir_value_below_2468.pdf')).customerNumber, '2468');
  const both = await extract('dir_both_sides_5512_1094.pdf');
  assert.equal(both.success, false, 'رقم يمين ورقم يسار نفس الكلمة => ما يرسل');
  assert.deepEqual([...both.uniqueNumbers].sort(), ['1094', '5512']);
});

test('كلمتين "رقم العميل" وكل وحدة جنبها رقم مختلف => ما يرسل', async () => {
  const r = await extract('two_labels_1094_2002.pdf');
  assert.equal(r.success, false);
  assert.deepEqual([...r.uniqueNumbers].sort(), ['1094', '2002']);
});

test('الفسح يوقف حتى لو فيه كلمة "مرتجع"، وكشف الحساب اللي فيه "رسوم فسح" يبقى كشف', async () => {
  const { detectDocumentType } = require('./index');
  const type = async (f) => { const d = await parsePdf(fs.readFileSync(path.join(__dirname, 'samples', f))); return detectDocumentType(d.text, d.layoutItems).id; };
  assert.equal(await type('clearance_with_return_word.pdf'), 'clearance');
  assert.equal(await type('clearance_body_return.pdf'), 'clearance');
  assert.equal(await type('statement_with_clearance_fee.pdf'), 'statement');
  assert.equal(await type('sample_return.pdf'), 'return');
  assert.equal(await type('report_invoice_shifted_1094.pdf'), 'invoice');
});

test('الرقم لاصق بكلمة "رقم العميل" بدون مسافة (مثل "١٠٠١رقم العميل :") => يُقرأ صح', async () => {
  const r = await extract('glued_label_1001.pdf');
  assert.equal(r.success, true, r.reason);
  assert.equal(r.customerNumber, '1001');
  // "رقم العميل:1001" في مربع عربي واحد
  const item = (str, x, dir = 'rtl') => ({ page: 1, str, dir, x, y: 700, w: 60, h: 10 });
  const r2 = extractCustomerNumber('رقم العميل:1001', [item('رقم العميل:1001', 400)]);
  assert.equal(r2.success, true, r2.reason);
  assert.equal(r2.customerNumber, '1001');
});

test('نموذج: "رقم العميل" بخانة والرقم بالخانة اللي جنبها بفراغ واسع => يُقرأ صح', async () => {
  const r = await extract('form_wide_gap_1001.pdf');
  assert.equal(r.success, true, r.reason);
  assert.equal(r.customerNumber, '1001');
});

test('الخانة المجاورة: رقمين مختلفين على جهتين الوسم => ما يرسل', () => {
  const item = (str, x, w, dir = 'ltr') => ({ page: 1, str, dir, x, y: 700, w, h: 6 });
  const items = [item('5512', 300, 20), item('ليمعلا مقر', 360, 36, 'rtl'), item('1094', 440, 20)];
  const r = extractCustomerNumber('5512 رقم العميل 1094', items);
  assert.equal(r.success, false);
});

test('أول قراءة بعد التشغيل لملف جدوله الداخلي فيه خلل ما تفشل', () => {
  // عملية جديدة: البرنامج محمّل (فيه http) وهذي أول قراءة — كانت أول 3 قراءات لهالنوع من الملفات تفشل
  const { execFileSync } = require('child_process');
  const script = `const m = require(${JSON.stringify(path.join(__dirname, 'index.js'))});
    m.parsePdf(require('fs').readFileSync(${JSON.stringify(path.join(__dirname, 'samples', 'glued_label_1001.pdf'))}))
      .then(d => { process.stdout.write(/رقم العميل/.test(d.text) ? 'OK' : 'NOTEXT'); process.exit(0); },
            e => { process.stdout.write('FAIL ' + e.message); process.exit(0); });`;
  const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, ALWADY_TEST_LOCK: 'unit-layout-first-read' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(out.trim(), 'OK');
});

test('رقم الفاتورة (أمر البيع) من الفسح: الرقم الصحيح، وما ياخذ رقم الحقل اللي جنبه', async () => {
  const { extractSalesOrderNumber, buildClearanceMeta, warehouseCaption } = require('./index');
  // فسح حقيقي (Microsoft Print to PDF): "رقم الفاتورة : 2026/11/17/101698   أمر بيع : 1911020"
  const d = await parsePdf(fs.readFileSync(path.join(__dirname, 'samples', 'report_clearance_3339.pdf')));
  assert.equal(extractSalesOrderNumber(d.text, d.layoutItems), '1911020');
  // نص بالترتيب العادي: الرقم بعد الوسم، والرقم اللي قبله (رقم فاتورة ثاني) ما ينأخذ
  assert.equal(extractSalesOrderNumber('رقم الفاتورة : 12345 أمر بيع : 778899'), '778899');
  assert.equal(extractSalesOrderNumber('أمر البيع: ٥٥٦٦٧٧'), '556677', 'أرقام عربية');
  // رقم الفاتورة المركّب ما ينأخذ، وبدون أمر بيع = فاضي
  assert.equal(extractSalesOrderNumber('أمر بيع : 2026/11/17/101698'), '');
  assert.equal(extractSalesOrderNumber('فاتورة ضريبية رقم العميل : 1001'), '');
  // رقمين مختلفين = ما نعرف أي واحد
  assert.equal(extractSalesOrderNumber('أمر بيع : 111222\nأمر بيع : 333444'), '');
  // يوصل للموقع ولقروب المستودع
  assert.equal(buildClearanceMeta('C:/x/Print_1.pdf', { success: true, customerNumber: '3339', salesOrderNo: '1911020' }).sales_order_no, '1911020');
  assert.equal(buildClearanceMeta('C:/x/Print_1.pdf', { success: true, customerNumber: '3339' }).sales_order_no, null);
  assert.match(warehouseCaption('3339', null, null, '1911020'), /رقم أمر الشراء: 1911020/);
  assert.doesNotMatch(warehouseCaption('3339', null, null, ''), /رقم أمر الشراء/);
});

test('قائمة الفسوحات (الشكل الحقيقي): تنعرف فسح، والعميل "العميل : 0004"، ورقم الطلب "رقم أمر الشراء"', async () => {
  const { extractClearanceData, extractClearanceCustomerNumber, extractSalesOrderNumber, detectDocumentType: detect, normalizeArabicText } = require('./index');
  // ملف بنفس ترتيب الفسح الحقيقي (مطبوع بكروم): "رقم أمر الشراء: 1911620" و "العميل : 0004  مؤسسة..." و "قائمة الفسوحات"
  const d = await parsePdf(fs.readFileSync(path.join(__dirname, 'samples', 'clearance_list_form_0004.pdf')));
  assert.equal(detect(normalizeArabicText(d.text), d.layoutItems).id, 'clearance', 'قائمة الفسوحات = فسح (مو فاتورة)');
  const x = extractClearanceData(d.text, d.layoutItems);
  assert.equal(x.success, true);
  assert.equal(x.customerNumber, '0004');
  assert.equal(x.salesOrderNo, '1911620');
  // كلمة "الفسوحات" (والمقلوبة) تعرّف الفسح
  assert.equal(detect('قائمة الفسوحات'), detect('فسح جمركي'));
  assert.equal(detect('تاحوسفلا ةمئاق').id, 'clearance');
  // نص بالترتيب العادي
  assert.equal(extractSalesOrderNumber('رقم أمر الشراء: 1911620\nالعميل : 9999 مؤسسة همس'), '1911620');
  assert.equal(extractClearanceCustomerNumber('رقم أمر الشراء: 1911620\nالعميل : 9999 مؤسسة همس'), '9999');
  // "اسم العميل" بدون رقم ما يطلع شي، والفواتير ما تتغير قواعدها (العميل بدون "رقم" ما ينقبل فيها)
  assert.equal(extractClearanceCustomerNumber('اسم العميل : مؤسسة همس'), '');
  assert.equal(extractCustomerNumber('فاتورة\nالعميل : 9999').success, false);
});

test('قائمة الفسوحات بخانة عميل فاضية: ما ياخذ رقم أمر الشراء ولا الهاتف كرقم عميل', async () => {
  const { extractClearanceData } = require('./index');
  const d = await parsePdf(fs.readFileSync(path.join(__dirname, 'samples', 'clearance_list_form_empty_customer.pdf')));
  const x = extractClearanceData(d.text, d.layoutItems);
  assert.equal(x.success, false, 'بدون رقم عميل => بيانات ناقصة (مو رقم غلط)');
  assert.equal(x.salesOrderNo, '1911630');
});

test('أصناف الفسح وكمياتها: عدد الأصناف ومجموع عامود الكمية', async () => {
  const { extractClearanceItems, extractClearanceData, buildClearanceMeta } = require('./index');
  const read = async (name) => parsePdf(fs.readFileSync(path.join(__dirname, 'samples', name)));
  // الفسح الحقيقي: صنف واحد كميته 2
  let d = await read('report_clearance_3339.pdf');
  assert.deepEqual(extractClearanceItems(d.layoutItems), { count: 1, qty: 2 });
  // قائمة الفسوحات بـ 15 صنف، مجموع الكميات 67
  d = await read('clearance_list_items_15.pdf');
  assert.deepEqual(extractClearanceItems(d.layoutItems), { count: 15, qty: 67 });
  const x = extractClearanceData(d.text, d.layoutItems);
  assert.deepEqual(x.items, { count: 15, qty: 67 });
  // مستند بدون جدول أصناف => ما يخترع أرقام
  assert.equal(extractClearanceItems([]), null);
  assert.equal(typeof buildClearanceMeta, 'function');
});

test('قائمة الفسوحات (نسخة من فسح حقيقي للعميل 1054): العميل ورقم أمر الشراء والأصناف، بدون ما ياخذ أرقام الوصف أو التسلسل أو الهاتف', async () => {
  const { extractClearanceData, detectDocumentType: detect } = require('./index');
  const d = await parsePdf(fs.readFileSync(path.join(__dirname, 'samples', 'clearance_list_1054.pdf')));
  assert.equal(detect(d.text).id, 'clearance');
  const x = extractClearanceData(d.text, d.layoutItems);
  assert.equal(x.success, true);
  assert.equal(x.customerNumber || x.number, '1054');
  assert.equal(x.salesOrderNo, '1911990', 'مو رقم التسلسل 159852 ولا الهاتف');
  // 5 أصناف: 1+2+2+2+1 — الوصف فيه أرقام (2007، 0.25، 15/11) وعامود م.ف فيه 1-5
  assert.deepEqual(x.items, { count: 5, qty: 8 });
});
