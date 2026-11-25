/* واتساب والإرسال: تحديث حالة الاتصال والباركود كل 3 ثواني، وتحديث الصفحة لما يتغير سجل المستندات */
(function () {
  'use strict';
  var live = document.getElementById('wa-live');
  if (!live) return;
  var logsKey = live.getAttribute('data-logs-key') || '';
  var lastStatus = live.getAttribute('data-status');
  var busy = false;

  // ما نحدّث الصفحة والمستخدم يكتب أو فاتح خيار
  function userBusy() {
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) return true;
    return !!document.querySelector('details.wa-override[open]');
  }

  function tick() {
    if (busy || document.hidden) return;
    busy = true;
    fetch('/admin/whatsapp/live.json', { headers: { accept: 'application/json', 'x-requested-with': 'fetch' }, credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) { window.location.href = '/login'; return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (d) {
        if (!d) return;
        if (lastStatus === null) lastStatus = d.status;
        // تغيّرت الحالة (اتصل، طلع باركود، انقطع) أو وصل مستند جديد: نحدّث الصفحة كاملة
        if ((d.status !== lastStatus || (d.ok && d.logsKey !== logsKey)) && !userBusy()) {
          window.location.reload();
          return;
        }
        // الباركود يتغير كل شوي وهو بانتظار المسح
        var img = document.getElementById('wa-qr-img');
        if (img && d.qrSvg && img.getAttribute('data-svg') !== d.qrSvg) {
          img.innerHTML = d.qrSvg;
          img.setAttribute('data-svg', d.qrSvg);
        }
      })
      .catch(function () { /* المحاولة الجاية */ })
      .then(function () { busy = false; });
  }

  // البرنامج يحدّث حالته في الموقع كل 10 ثواني، فما فيه فايدة من سؤال أسرع
  setInterval(tick, 10000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
})();
