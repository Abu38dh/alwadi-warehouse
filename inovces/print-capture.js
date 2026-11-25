/**
 * print-capture.js
 *
 * استقبال المستندات المطبوعة على طابعة "WhatsApp Sender" مباشرة بدون أي برنامج PDF خارجي.
 *
 * الفكرة:
 *  - الطابعة مبنية على طابعة ويندوز المدمجة "Microsoft Print To PDF".
 *  - منفذ الطابعة (Port) هو أنبوب داخلي (Named Pipe) يستمع عليه البرنامج.
 *  - كل أمر طباعة = اتصال مستقل على الأنبوب، فلا يمكن أن يكتب مستند فوق آخر حتى لو طُبع عدة مستندات متتالية.
 *  - يُحفظ كل مستند كملف PDF باسم فريد داخل مجلد المراقبة، ومن هناك يكمل مساره الطبيعي (قراءة رقم العميل، القروب، الإرسال).
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const DEFAULT_PIPE_NAME = '\\\\.\\pipe\\alwady-whatsapp-print';
const MAX_JOB_BYTES = 100 * 1024 * 1024; // 100MB حد أقصى للمستند الواحد

let jobCounter = 0;

function makeJobFileName(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  jobCounter = (jobCounter + 1) % 1000;
  return `Print_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}_${pad(jobCounter, 3)}.pdf`;
}

function isPdf(buffer) {
  // ترويسة PDF تكون في أول الملف (نسمح بهامش بسيط)
  return buffer.length > 8 && buffer.subarray(0, 1024).includes('%PDF-');
}

/**
 * ملف PDF المكتمل ينتهي بعلامة %%EOF. إذا انقطعت الطباعة في المنتصف تكون مفقودة.
 */
function isCompletePdf(buffer) {
  return isPdf(buffer) && buffer.subarray(Math.max(0, buffer.length - 2048)).includes('%%EOF');
}

/**
 * حفظ مستند مطبوع: يُكتب أولاً بامتداد .part (لا يراه مراقب المجلد) ثم يُعاد تسميته إلى .pdf دفعة واحدة.
 * @returns {string} مسار الملف النهائي
 */
function saveJob(buffer, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  let finalPath = path.join(targetDir, makeJobFileName());
  while (fs.existsSync(finalPath)) finalPath = path.join(targetDir, makeJobFileName());
  const tempPath = `${finalPath}.part`;
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, finalPath);
  return finalPath;
}

/**
 * بدء استقبال أوامر الطباعة.
 * @param {{pipeName?: string, targetDir: string, log?: Console}} options
 * @returns {Promise<net.Server|null>} null إذا تعذر التشغيل (مثلاً نسخة أخرى من البرنامج تستقبل الطباعة)
 */
function startPrintCapture({ pipeName = DEFAULT_PIPE_NAME, targetDir, log = console }) {

  const server = net.createServer((socket) => {
    const chunks = [];
    let size = 0;
    let aborted = false;

    socket.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_JOB_BYTES) {
        aborted = true;
        log.warn(`⚠ [الطابعة] تم رفض مستند مطبوع لأن حجمه تجاوز ${MAX_JOB_BYTES / 1024 / 1024}MB`);
        socket.destroy();
        return;
      }
      chunks.push(chunk);
    });

    socket.on('end', () => {
      if (aborted) return;
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) return;
      try {
        // المستندات غير الصالحة لا تُحفظ (لا يبقى أي ملف لا فائدة منه)
        if (!isPdf(buffer)) {
          log.warn('⚠ [الطابعة] وصل مستند مطبوع ليس PDF وتم تجاهله (تأكد أن الطابعة مبنية على Microsoft Print To PDF).');
          return;
        }
        if (!isCompletePdf(buffer)) {
          log.warn(`⚠ [الطابعة] وصل مستند مطبوع ناقص (${Math.round(buffer.length / 1024)}KB) وتم تجاهله. ويندوز يعيد إرسال الطباعة تلقائياً.`);
          return;
        }
        const saved = saveJob(buffer, targetDir);
        log.log(`🖨 [الطابعة] تم استلام مستند مطبوع (${Math.round(buffer.length / 1024)}KB): ${path.basename(saved)}`);
      } catch (err) {
        log.error(`❌ [الطابعة] تعذر حفظ المستند المطبوع: ${err.message}`);
      }
    });

    socket.on('error', (err) => {
      log.warn(`⚠ [الطابعة] انقطع استلام مستند مطبوع: ${err.message}`);
    });
  });

  return new Promise((resolve) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log.warn('⚠ [الطابعة] استقبال الطباعة يعمل بالفعل في نسخة أخرى من البرنامج على هذا الجهاز.');
      } else {
        log.warn(`⚠ [الطابعة] تعذر تشغيل استقبال الطباعة: ${err.message}`);
      }
      resolve(null);
    });
    server.listen(pipeName, () => {
      log.log('🖨 [الطابعة] جاهز لاستقبال المستندات المطبوعة على طابعة البرنامج.');
      resolve(server);
    });
  });
}

/**
 * تشغيل الاستقبال في خيط مستقل (Worker Thread) حتى لا يتأخر استلام الطباعة أبداً
 * أثناء انشغال البرنامج الرئيسي بقراءة ملفات PDF أو الإرسال (التأخير كان يسبب انقطاع الطباعة).
 * @returns {Promise<{close: Function}|null>}
 */
function startPrintCaptureInWorker({ pipeName = DEFAULT_PIPE_NAME, targetDir, log = console }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const worker = new Worker(__filename, { workerData: { printCaptureWorker: true, pipeName, targetDir } });

    worker.on('message', (m) => {
      if (!m) return;
      if (m.type === 'log') (log[m.level] || log.log).call(log, m.text);
      else if (m.type === 'started') done({ close: () => worker.terminate() });
      else if (m.type === 'failed') { worker.terminate(); done(null); }
    });
    worker.on('error', (err) => {
      log.error(`❌ [الطابعة] توقف استقبال الطباعة بسبب خطأ: ${err.message}`);
      done(null);
    });
    worker.on('exit', () => done(null));
  });
}

// كود الخيط المستقل
if (!isMainThread && workerData && workerData.printCaptureWorker) {
  const relay = (level) => (text) => parentPort.postMessage({ type: 'log', level, text });
  const workerLog = { log: relay('log'), warn: relay('warn'), error: relay('error') };
  startPrintCapture({ pipeName: workerData.pipeName, targetDir: workerData.targetDir, log: workerLog })
    .then((server) => parentPort.postMessage({ type: server ? 'started' : 'failed' }));
}

/**
 * إعادة تشغيل أوامر الطباعة العالقة بحالة خطأ (مثلاً طُبع مستند والبرنامج مغلق، أو انقطعت الطباعة).
 * إعادة التشغيل لا تنشئ أمر طباعة جديداً، بل تعيد نفس الأمر من البداية.
 */
function resumeStuckPrintJobs(printerName, log = console) {
  if (process.platform !== 'win32' || !printerName) return;
  const ps = `
    $ErrorActionPreference = 'SilentlyContinue'
    $ProgressPreference = 'SilentlyContinue'
    $jobs = Get-PrintJob -PrinterName '${String(printerName).replace(/'/g, "''")}' | Where-Object { "$($_.JobStatus)" -match 'Error' }
    $n = 0
    foreach ($j in $jobs) { Restart-PrintJob -InputObject $j; $n++ }
    $n
  `;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 20000, windowsHide: true }, (err, stdout) => {
    if (err) return;
    const n = parseInt(String(stdout).trim(), 10);
    if (n > 0) log.log(`🖨 [الطابعة] تمت إعادة تشغيل (${n}) أمر طباعة كان معلقاً.`);
  });
}

/**
 * فحص دوري لأوامر الطباعة العالقة أثناء عمل البرنامج.
 */
function startStuckJobWatcher(printerName, intervalMs = 30000, log = console) {
  const timer = setInterval(() => resumeStuckPrintJobs(printerName, log), intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  DEFAULT_PIPE_NAME,
  startPrintCapture,
  startPrintCaptureInWorker,
  resumeStuckPrintJobs,
  startStuckJobWatcher,
  saveJob,
  isPdf,
  isCompletePdf,
  makeJobFileName
};
