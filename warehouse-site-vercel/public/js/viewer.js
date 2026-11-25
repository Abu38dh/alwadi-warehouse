/* عارض الـ PDF داخل الموقع (pdf.js): يرسم الصفحات كصور بعرض الشاشة مع تكبير وتصغير.
   يدعم أكثر من ملف في نفس الصفحة (مقارنة نسختين): كل ".viewer-pages[data-src]" ملف، والتكبير لهم كلهم. */
import * as pdfjsLib from '/static/vendor/pdfjs/legacy/build/pdf.min.mjs';

const VENDOR = '/static/vendor/pdfjs/';
pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR + 'legacy/build/pdf.worker.min.mjs';

const containers = Array.from(document.querySelectorAll('.viewer-pages[data-src]'));
const zoomLabel = document.getElementById('zoom-label');
const ZOOMS = [1, 1.5, 2, 3];
// دقة الرسم: أعلى من عرض الشاشة حتى يبقى النص واضحاً عند التكبير (مع حد أعلى لحماية ذاكرة الجوال)
const MAX_BITMAP_WIDTH = 2200;
let zoomIndex = 0;

/** خانة الحالة لكل ملف: data-status-id، وإلا الخانة العامة */
function statusOf(container) {
  return document.getElementById(container.dataset.statusId || 'viewer-status');
}

function setStatus(container, text, isError) {
  const el = statusOf(container);
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('viewer-error', !!isError);
}

function applyZoom() {
  for (const c of containers) c.dataset.zoom = String(ZOOMS[zoomIndex]);
  if (zoomLabel) zoomLabel.textContent = Math.round(ZOOMS[zoomIndex] * 100) + '%';
}

const zoomIn = document.getElementById('zoom-in');
const zoomOut = document.getElementById('zoom-out');
if (zoomIn) zoomIn.addEventListener('click', () => { zoomIndex = Math.min(ZOOMS.length - 1, zoomIndex + 1); applyZoom(); });
if (zoomOut) zoomOut.addEventListener('click', () => { zoomIndex = Math.max(0, zoomIndex - 1); applyZoom(); });

function base64ToBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function load(container) {
  const res = await fetch(container.dataset.src, {
    headers: { 'x-requested-with': 'fetch', accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store'
  });
  if (res.status === 401) { window.location.href = '/login'; return; }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();

  const pdf = await pdfjsLib.getDocument({
    data: base64ToBytes(data.base64),
    cMapUrl: VENDOR + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: VENDOR + 'standard_fonts/',
    wasmUrl: VENDOR + 'wasm/',
    iccUrl: VENDOR + 'iccs/',
    disableWorkerRendering: true
  }).promise;

  const cssWidth = Math.max(280, container.clientWidth);
  const ratio = Math.min(window.devicePixelRatio || 1, 3) * 2;
  for (let n = 1; n <= pdf.numPages; n++) {
    setStatus(container, pdf.numPages > 1 ? `جاري عرض الصفحة ${n} من ${pdf.numPages}...` : 'جاري عرض الملف...');
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const bitmapWidth = Math.min(MAX_BITMAP_WIDTH, Math.round(cssWidth * ratio));
    const viewport = page.getViewport({ scale: bitmapWidth / base.width });
    const canvas = document.createElement('canvas');
    canvas.className = 'viewer-page';
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `الصفحة ${n}`);
    container.appendChild(canvas);
    await page.render({ canvas, viewport }).promise;
  }
  container.dataset.rendered = String(pdf.numPages);
  setStatus(container, '');
}

applyZoom();
for (const container of containers) {
  load(container).catch((err) => {
    console.error(err);
    container.dataset.rendered = 'error';
    setStatus(container, 'تعذر عرض الملف هنا. اضغط "تنزيل" لفتحه من الجهاز.', true);
  });
}
