/**
 * list-groups.js
 *
 * أداة مراجعة: تعرض كل قروبات واتساب مع الرقم المكتشف في اسم كل قروب وهل القروب صالح للإرسال،
 * بنفس قواعد المطابقة التي يستخدمها البرنامج (group-matcher.js). لا ترسل أي شيء.
 *
 * التشغيل (أوقف البرنامج الرئيسي أولاً لأن نفس الحساب لا يعمل في نافذتين في نفس الوقت):
 *   npm run list-groups
 */

const { buildGroupIndex } = require('./group-matcher');

function printReport(groups) {
  let minDigits = 4;
  try { minDigits = Number(JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'settings.json'), 'utf8')).minCustomerDigits) || 4; } catch (_) {}
  const index = buildGroupIndex(groups, { minDigits });
  const rows = [];

  for (const g of index.valid) {
    const sameNumber = index.byNumber.get(g.number) || [];
    rows.push({
      status: sameNumber.length > 1 ? '⚠ مكرر (لن يُرسل)' : '✅ صالح',
      number: g.number,
      name: g.name,
      note: sameNumber.length > 1 ? `نفس الرقم موجود في ${sameNumber.length} قروبات` : ''
    });
  }
  for (const g of index.invalid) {
    rows.push({
      status: '❌ غير صالح',
      number: g.numbers.length ? g.numbers.join('، ') : '-',
      name: g.name,
      note: g.reason
    });
  }

  const order = { '✅ صالح': 0, '⚠ مكرر (لن يُرسل)': 1, '❌ غير صالح': 2 };
  rows.sort((a, b) => (order[a.status] - order[b.status]) || String(a.number).localeCompare(String(b.number), 'en', { numeric: true }));

  console.log('\n=======================================================');
  console.log('              قائمة قروبات واتساب ومطابقتها              ');
  console.log('=======================================================');
  for (const r of rows) {
    console.log(`${r.status} | الرقم: ${r.number} | القروب: ${r.name}${r.note ? ` | ${r.note}` : ''}`);
  }

  const duplicates = rows.filter(r => r.status.startsWith('⚠')).length;
  console.log('-------------------------------------------------------');
  console.log(`📁 إجمالي القروبات        : ${rows.length}`);
  console.log(`✅ صالحة برقم عميل فريد   : ${index.valid.length - duplicates}`);
  console.log(`⚠ مكررة (نفس رقم العميل) : ${duplicates}`);
  console.log(`❌ غير صالحة (صفر أو أكثر من رقم): ${index.invalid.length}`);
  console.log('=======================================================\n');
}

async function run() {
  const { BaileysClient } = require('./wa-baileys');
  const qrcode = require('qrcode-terminal');
  const client = new BaileysClient();

  client.on('qr', (qr) => {
    console.log('\n📌 امسح رمز الـ QR التالي عبر واتساب لربط الحساب:');
    qrcode.generate(qr, { small: true });
  });

  client.on('disconnected', (reason) => {
    if (reason === 'CONFLICT') {
      console.error('❌ الحساب مفتوح في البرنامج الرئيسي. أغلقه أولاً ثم أعد تشغيل: npm run list-groups');
    } else {
      console.error('❌ انقطع اتصال واتساب:', reason);
    }
    process.exit(1);
  });

  client.once('ready', async () => {
    let exitCode = 0;
    try {
      console.log('🚀 واتساب متصل، جاري جلب القروبات...');
      const groups = (await client.getChats()).map(c => ({ id: c.id._serialized, name: c.name || '' }));
      printReport(groups);
    } catch (err) {
      console.error('❌ تعذر جلب القروبات:', err.message);
      exitCode = 1;
    } finally {
      await client.destroy();
      process.exit(exitCode);
    }
  });

  try {
    await client.initialize();
  } catch (err) {
    console.error('❌ تعذر تشغيل واتساب:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

module.exports = { printReport };
