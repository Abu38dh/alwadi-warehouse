/**
 * test-extract.js
 * 
 * أداة مساعدة لاختبار استخراج النص ورقم العميل ونوع المستند (فاتورة / فسح / مرتجع) من ملف PDF دون لمس واتساب.
 * 
 * الاستخدام:
 *   node test-extract.js "C:\Invoices\file.pdf"
 *   npm run test-extract "C:\Invoices\file.pdf"
 */

const fs = require('fs');
const path = require('path');
const { normalizeArabicText, extractCustomerNumber, parsePdf, detectDocumentType } = require('./index');

async function run() {
  const args = process.argv.slice(2).filter(arg => arg !== '--');

  if (args.length === 0) {
    console.log('\n❌ يرجى تمرير مسار ملف الـ PDF المراد اختباره.');
    console.log('طريقة الاستخدام:');
    console.log('  node test-extract.js "pdfssssssssss\\invoice.pdf"');
    console.log('  npm run test-extract "pdfssssssssss\\invoice.pdf"\n');
    process.exit(1);
  }

  const targetPath = path.resolve(args[0]);

  if (!fs.existsSync(targetPath)) {
    console.error(`\n❌ الملف غير موجود في المسار المحدد: ${targetPath}\n`);
    process.exit(1);
  }

  console.log('\n=======================================================');
  console.log(`📄 فحص ملف المستند: ${path.basename(targetPath)}`);
  console.log(`📁 المسار الكامل: ${targetPath}`);
  console.log('=======================================================');

  try {
    const dataBuffer = fs.readFileSync(targetPath);
    const pdfData = await parsePdf(dataBuffer);
    const rawText = pdfData.text || '';

    console.log('\n--- [1] النص الخام المستخرج من الـ PDF ---');
    if (rawText.trim().length > 0) {
      console.log(rawText.trim());
    } else {
      console.log('(لم يتم العثور على نص)');
    }

    const normalized = normalizeArabicText(rawText);
    console.log('\n--- [2] أول 400 حرف بعد التوحيد والمعالجة ---');
    console.log(normalized.slice(0, 400));
    console.log('-------------------------------------------------------');

    // تحديد نوع المستند (فاتورة / فسح / مرتجع)
    const docType = detectDocumentType(rawText);
    console.log(`\n🏷 نوع المستند المكتشف تلقائياً: [ ${docType.label} ]`);
    console.log(`📁 مجلد الحفظ المخصص بعد الإرسال: [ Sent\\${docType.subfolder} ]`);
    console.log(`💬 نص الرسالة التلقائي: "${docType.defaultCaption}"`);

    console.log('\n--- [3] نتيجة التعرف على رقم العميل ---');
    const result = extractCustomerNumber(rawText);

    if (result.success) {
      console.log(`✅ تم التعرف على رقم العميل بنجاح!`);
      console.log(`   🔢 رقم العميل: [ ${result.customerNumber} ]`);
      console.log(`   🎯 النمط المطابق: ${result.pattern}`);
    } else {
      console.log(`⚠ تعذر استخراج رقم العميل:`);
      console.log(`   السبب: ${result.reason}`);
      if (result.uniqueNumbers && result.uniqueNumbers.length > 0) {
        console.log(`   الأرقام المعثور عليها: ${result.uniqueNumbers.join(', ')}`);
      }
    }
    console.log('=======================================================\n');

  } catch (err) {
    console.error(`\n❌ حدث خطأ أثناء قراءة ملف الـ PDF: ${err.message}\n`);
    process.exit(1);
  }
}

run();
