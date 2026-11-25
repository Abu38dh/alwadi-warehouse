/**
 * اختبارات منطق مطابقة القروبات (بدون واتساب)
 * التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyGroup,
  buildGroupIndex,
  findGroupForCustomer,
  resolveWithRefresh,
  describeResolution
} = require('./group-matcher');

const GROUPS = [
  { id: 'g1@g.us', name: 'مؤسسة النخبة 1001' },
  { id: 'g2@g.us', name: 'شركة الأمل ١٠٠٢' },
  { id: 'g3@g.us', name: 'ورشة السرعة 11001' },
  { id: 'g4@g.us', name: 'فرع 2 ورشة 1003' },
  { id: 'g5@g.us', name: 'قروب بدون رقم' },
  { id: 'g6@g.us', name: 'محل الوفاء 1004' },
  { id: 'g7@g.us', name: 'مستودع الوفاء 1004' }
];

const index = buildGroupIndex(GROUPS);

test('"مؤسسة النخبة 1001" يطابق 1001', () => {
  const r = findGroupForCustomer(index, '1001');
  assert.equal(r.status, 'match');
  assert.equal(r.group.id, 'g1@g.us');
  assert.equal(r.group.name, 'مؤسسة النخبة 1001');
});

test('"شركة الأمل ١٠٠٢" (أرقام عربية) يطابق 1002', () => {
  const r = findGroupForCustomer(index, '1002');
  assert.equal(r.status, 'match');
  assert.equal(r.group.id, 'g2@g.us');
});

test('"ورشة السرعة 11001" لا يطابق 1001 (لا مطابقة جزئية)', () => {
  const r = findGroupForCustomer(index, '1001');
  assert.notEqual(r.group.id, 'g3@g.us');
  // 11001 نفسه يطابق قروبه فقط
  assert.equal(findGroupForCustomer(index, '11001').group.id, 'g3@g.us');
  // 1001 لا يطابق 10012
  const idx2 = buildGroupIndex([{ id: 'x@g.us', name: 'عميل 10012' }]);
  assert.equal(findGroupForCustomer(idx2, '1001').status, 'none');
  assert.equal(findGroupForCustomer(idx2, '001').status, 'none');
});

test('"فرع 2 ورشة 1003" غير صالح (رقمان) ولا يُرسل له', () => {
  const c = classifyGroup(GROUPS[3]);
  assert.equal(c.valid, false);
  assert.deepEqual(c.numbers, ['2', '1003']);
  assert.ok(index.invalid.some(g => g.id === 'g4@g.us'));
  assert.equal(findGroupForCustomer(index, '1003').status, 'none');
  assert.equal(findGroupForCustomer(index, '2').status, 'none');
});

test('"قروب بدون رقم" غير صالح', () => {
  const c = classifyGroup(GROUPS[4]);
  assert.equal(c.valid, false);
  assert.deepEqual(c.numbers, []);
  assert.ok(index.invalid.some(g => g.id === 'g5@g.us'));
});

test('قروبان ينتهيان بـ 1004 => غموض ولا إرسال', () => {
  const r = findGroupForCustomer(index, '1004');
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.groups.map(g => g.id).sort(), ['g6@g.us', 'g7@g.us']);
  const reason = describeResolution(r, '1004');
  assert.ok(reason.includes('محل الوفاء 1004') && reason.includes('مستودع الوفاء 1004'));
});

test('الأصفار البادئة تُحذف من الطرفين', () => {
  const idx = buildGroupIndex([{ id: 'z@g.us', name: 'عميل 0042' }]);
  assert.equal(findGroupForCustomer(idx, '42').status, 'match');
  assert.equal(findGroupForCustomer(idx, '00042').status, 'match');
  assert.equal(findGroupForCustomer(idx, '420').status, 'none');
  assert.equal(findGroupForCustomer(index, '01001').group.id, 'g1@g.us');
});

test('أرقام فارسية وأرقام عريضة (NFKC) والرقم في أي مكان من الاسم', () => {
  const idx = buildGroupIndex([
    { id: 'p@g.us', name: 'شركة ۱۰۰۵ للتجارة' },
    { id: 'f@g.us', name: 'محل １００６' }
  ]);
  assert.equal(findGroupForCustomer(idx, '1005').group.id, 'p@g.us');
  assert.equal(findGroupForCustomer(idx, '1006').group.id, 'f@g.us');
});

test('نفس القروب المكرر بنفس المعرّف لا يُعتبر غموضاً', () => {
  const idx = buildGroupIndex([GROUPS[0], GROUPS[0]]);
  assert.equal(findGroupForCustomer(idx, '1001').status, 'match');
});

test('رقم ملصوق بحروف إنجليزية (كود) لا يُعتبر رقم عميل', () => {
  const idx = buildGroupIndex([
    { id: 'dmk@g.us', name: 'قائمة المتدربين DMK2-OXSA✔️' },
    { id: '4g@g.us', name: 'باقات 4G' },
    { id: 'b2b@g.us', name: 'مبيعات B2B' }
  ]);
  assert.equal(findGroupForCustomer(idx, '2').status, 'none');
  assert.equal(findGroupForCustomer(idx, '4').status, 'none');
  assert.equal(idx.valid.length, 0);
  // الرقم المفصول بمسافة أو شرطة ما زال يُقرأ
  const idx2 = buildGroupIndex([{ id: 'a@g.us', name: 'محل الوفاء - 3226' }, { id: 'b@g.us', name: 'عميل1005' }]);
  assert.equal(findGroupForCustomer(idx2, '3226').status, 'match');
  assert.equal(findGroupForCustomer(idx2, '1005').status, 'match');
});

test('أرقام العملاء 4 خانات: ما حدث فعلاً (فاتورة رقم عميلها 2) لا تُرسل لأي قروب', async () => {
  // أسماء القروبات الحقيقية في الحساب
  const real = [
    { id: 'dmk@g.us', name: 'قائمة المتدربين DMK2-OXSA✔️' },
    { id: 'jobs@g.us', name: 'وظائف واشغال بحضرموت 11' },
    { id: 'c1001@g.us', name: 'مبيعات عميل رقم 1001' },
    { id: 'p2026@g.us', name: 'خريجين تقنية معلومات 2026p' }
  ];
  const idx = buildGroupIndex(real, { minDigits: 4 });
  for (const n of ['2', '11', '02', '011']) {
    const r = await resolveWithRefresh(() => idx, async () => true, n);
    assert.equal(r.status, 'invalid_customer', `customer ${n}`);
    assert.ok(describeResolution(r, n).includes('أقل من 4 خانات'));
  }
  assert.equal(findGroupForCustomer(idx, '1001').group.id, 'c1001@g.us');
  assert.equal(findGroupForCustomer(idx, '3226').status, 'none');
  assert.ok(idx.invalid.some(g => g.id === 'jobs@g.us' && /أقل من 4 خانات/.test(g.reason)));
  // الأرقام القصيرة ما زالت تُحسب في "أكثر من رقم" (لا يصبح القروب صالحاً بتجاهلها)
  const mixed = buildGroupIndex([{ id: 'm@g.us', name: 'فرع 2 ورشة 1003' }], { minDigits: 4 });
  assert.equal(findGroupForCustomer(mixed, '1003').status, 'none');
  // 5 خانات تعمل (عملاء مستقبلاً)
  const five = buildGroupIndex([{ id: 'f@g.us', name: 'عميل 10045' }], { minDigits: 4 });
  assert.equal(findGroupForCustomer(five, '10045').status, 'match');
});

test('رقم عميل غير رقمي لا يطابق شيئاً', () => {
  assert.equal(findGroupForCustomer(index, '').status, 'none');
  assert.equal(findGroupForCustomer(index, 'abc').status, 'none');
});

test('عدم التطابق => تحديث القائمة مرة واحدة ثم إعادة المحاولة', async () => {
  let current = buildGroupIndex([GROUPS[0]]);
  let refreshCalls = 0;
  const refresh = async () => {
    refreshCalls++;
    current = buildGroupIndex([GROUPS[0], { id: 'new@g.us', name: 'عميل جديد 2000' }]);
    return true;
  };
  const r = await resolveWithRefresh(() => current, refresh, '2000');
  assert.equal(r.status, 'match');
  assert.equal(r.group.id, 'new@g.us');
  assert.equal(refreshCalls, 1);
});

test('لا تطابق حتى بعد التحديث => none ومرة تحديث واحدة فقط', async () => {
  let refreshCalls = 0;
  const r = await resolveWithRefresh(() => index, async () => { refreshCalls++; return true; }, '9999');
  assert.equal(r.status, 'none');
  assert.equal(refreshCalls, 1);
  assert.ok(describeResolution(r, '9999').includes('[9999]'));
});

test('التطابق من أول مرة لا يستدعي التحديث', async () => {
  let refreshCalls = 0;
  const r = await resolveWithRefresh(() => index, async () => { refreshCalls++; return true; }, '1001');
  assert.equal(r.status, 'match');
  assert.equal(refreshCalls, 0);
});

test('الغموض لا يستدعي التحديث ولا يُرسل', async () => {
  let refreshCalls = 0;
  const r = await resolveWithRefresh(() => index, async () => { refreshCalls++; return true; }, '1004');
  assert.equal(r.status, 'ambiguous');
  assert.equal(refreshCalls, 0);
});

test('تعذر تحميل القائمة => unavailable (لا إرسال)', async () => {
  const r = await resolveWithRefresh(() => null, async () => false, '1001');
  assert.equal(r.status, 'unavailable');
  assert.ok(describeResolution(r, '1001'));
});
