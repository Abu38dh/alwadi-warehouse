/**
 * اختبار استقبال الطباعة: يحاكي خدمة الطباعة في ويندوز (Spooler) بإرسال مستندات على الأنبوب.
 * التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startPrintCapture, startPrintCaptureInWorker } = require('./print-capture');

const SAMPLE_PDF = fs.readFileSync(path.join(__dirname, 'samples', 'invoice_1001.pdf'));
// طباعة حقيقية من Word على طابعة البرنامج: نسخة كاملة ونسخة انقطعت في المنتصف
const WORD_PDF = fs.readFileSync(path.join(__dirname, 'samples', 'word_print_invoice_1001.pdf'));
const WORD_TRUNCATED = fs.readFileSync(path.join(__dirname, 'samples', 'word_print_truncated.pdf'));
const quietLog = { log() {}, warn() {}, error() {} };

function sendJob(pipeName, buffer, chunkSize = 4096) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipeName, async () => {
      for (let i = 0; i < buffer.length; i += chunkSize) sock.write(buffer.subarray(i, i + chunkSize));
      sock.end();
    });
    sock.on('close', resolve);
    sock.on('error', reject);
  });
}

async function waitFor(fn, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return fn();
}

const pdfFiles = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.pdf')) : [];

test('استقبال الطباعة: كل أمر طباعة يصبح ملف PDF مستقل بدون فقدان أو كتابة فوق ملف آخر', async (t) => {
  const pipeName = `\\\\.\\pipe\\alwady-test-${process.pid}-${Date.now()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alwady-print-'));
  const server = await startPrintCapture({ pipeName, targetDir: dir, log: quietLog });
  assert.ok(server, 'server should start');
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // 1) مستند واحد
  await sendJob(pipeName, SAMPLE_PDF);
  assert.ok(await waitFor(() => pdfFiles(dir).length === 1));
  const first = fs.readFileSync(path.join(dir, pdfFiles(dir)[0]));
  assert.ok(first.equals(SAMPLE_PDF), 'المحتوى يجب أن يكون مطابقاً تماماً');

  // 2) خمسة مستندات متتالية بسرعة + خمسة في نفس اللحظة
  for (let i = 0; i < 5; i++) await sendJob(pipeName, SAMPLE_PDF);
  await Promise.all(Array.from({ length: 5 }, () => sendJob(pipeName, SAMPLE_PDF, 1000)));
  assert.ok(await waitFor(() => pdfFiles(dir).length === 11), `expected 11 files, got ${pdfFiles(dir).length}`);
  for (const f of pdfFiles(dir)) {
    assert.ok(fs.readFileSync(path.join(dir, f)).equals(SAMPLE_PDF), `file ${f} corrupted`);
  }
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.part')).length, 0, 'no temp files left');

  // 3) بيانات ليست PDF => تُتجاهل ولا يُحفظ أي ملف
  await sendJob(pipeName, Buffer.from('this is not a pdf'));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(pdfFiles(dir).length, 11);
  assert.equal(fs.readdirSync(dir).length, 11, 'لا ملفات أخرى ولا مجلدات');

  // 4) اتصال فارغ لا ينشئ ملفاً
  await sendJob(pipeName, Buffer.alloc(0));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(pdfFiles(dir).length, 11);
});

test('طباعة ناقصة (انقطعت في المنتصف) لا تدخل مجلد الإرسال، والكاملة تدخل', async (t) => {
  const pipeName = `\\\\.\\pipe\\alwady-test-trunc-${process.pid}-${Date.now()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alwady-print-'));
  const server = await startPrintCapture({ pipeName, targetDir: dir, log: quietLog });
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  await sendJob(pipeName, WORD_TRUNCATED, 65536);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(fs.readdirSync(dir).length, 0, 'الطباعة الناقصة لا تُحفظ إطلاقاً');

  await sendJob(pipeName, WORD_PDF, 65536);
  assert.ok(await waitFor(() => pdfFiles(dir).length === 1));
});

test('الاستقبال في خيط مستقل يستمر حتى لو كان البرنامج الرئيسي مشغولاً', async (t) => {
  const pipeName = `\\\\.\\pipe\\alwady-test-worker-${process.pid}-${Date.now()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alwady-print-'));
  const handle = await startPrintCaptureInWorker({ pipeName, targetDir: dir, log: quietLog });
  assert.ok(handle, 'worker should start');
  t.after(async () => { await handle.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // مرسل في عملية منفصلة يرسل المستند بينما نحجز الخيط الرئيسي 3 ثوانٍ (مثل قراءة PDF كبير)
  const { spawn } = require('child_process');
  const senderCode = `
    const net = require('net');
    const buf = require('fs').readFileSync(process.argv[1]);
    const s = net.connect(process.argv[2], () => {
      const t0 = Date.now();
      let i = 0;
      const step = () => { while (i < buf.length) { const ok = s.write(buf.subarray(i, i += 65536)); if (!ok) return s.once('drain', step); } s.end(); };
      step();
      s.on('close', () => console.log(Date.now() - t0));
    });`;
  const child = spawn(process.execPath, ['-e', senderCode, path.join(__dirname, 'samples', 'word_print_invoice_1001.pdf'), pipeName]);
  let out = '';
  child.stdout.on('data', d => out += d);
  const blockUntil = Date.now() + 3000;
  while (Date.now() < blockUntil) { /* الخيط الرئيسي مشغول */ }
  await new Promise(r => child.on('exit', r));
  const sendMs = Number(out.trim());
  assert.ok(sendMs < 2500, `الإرسال يجب أن يكتمل والخيط الرئيسي مشغول (استغرق ${sendMs}ms)`);
  assert.ok(await waitFor(() => pdfFiles(dir).length === 1));
  assert.ok(fs.readFileSync(path.join(dir, pdfFiles(dir)[0])).equals(WORD_PDF));
});

test('تشغيل نسخة ثانية على نفس الأنبوب لا يسرق الطباعة', async (t) => {
  const pipeName = `\\\\.\\pipe\\alwady-test-dup-${process.pid}-${Date.now()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alwady-print-'));
  const a = await startPrintCapture({ pipeName, targetDir: dir, log: quietLog });
  const b = await startPrintCapture({ pipeName, targetDir: dir, log: quietLog });
  t.after(() => { if (a) a.close(); if (b) b.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.ok(a);
  assert.equal(b, null);
});
