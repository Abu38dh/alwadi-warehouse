/* صفحة المستندات: تحديث تلقائي كل 15 ثانية + صوت عند وصول مستند جديد */
(function () {
  'use strict';
  var list = document.getElementById('doc-list');
  // نتائج البحث ما تتحدث لحالها
  if (!list || !list.dataset.status) return;

  var REFRESH_MS = 15000;
  var status = list.dataset.status;
  var branch = list.dataset.branch || '';
  var latestId = Number(list.dataset.latestId) || 0;
  var live = document.getElementById('live-status');
  var banner = document.getElementById('new-banner');
  var baseTitle = document.title;
  var audioCtx = null;
  var busy = false;

  // المتصفحات لا تسمح بالصوت قبل أول لمسة من المستخدم على الصفحة
  function unlockAudio() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* بدون صوت */ }
  }
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  document.addEventListener('keydown', unlockAudio);

  function tone(freq, start, duration) {
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function beep() {
    if (!audioCtx || audioCtx.state !== 'running') return;
    var t = audioCtx.currentTime;
    tone(880, t, 0.18);
    tone(1175, t + 0.2, 0.28);
  }

  function setLive(ok) {
    if (!live) return;
    live.textContent = ok ? 'تحديث تلقائي' : 'تعذر التحديث — يعيد المحاولة';
    live.classList.toggle('offline', !ok);
  }

  function announceNew() {
    beep();
    if (navigator.vibrate) { try { navigator.vibrate([120, 60, 120]); } catch (e) { /* غير مدعوم */ } }
    if (banner && status !== 'received' && status !== 'all') banner.hidden = false;
    if (document.hidden) document.title = '● فسح جديد — ' + baseTitle;
  }

  function refresh() {
    if (busy) return;
    busy = true;
    fetch('/documents/cards?status=' + encodeURIComponent(status) + (branch ? '&branch=' + encodeURIComponent(branch) : ''), {
      headers: { 'x-requested-with': 'fetch', accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (res) {
      if (res.status === 401) { window.location.href = '/login'; return null; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!data) return;
      // الكروت جاهزة من السيرفر (نفس قالب الصفحة والنصوص فيه مؤمّنة)
      list.innerHTML = data.html;
      Object.keys(data.counts || {}).forEach(function (key) {
        var el = document.querySelector('[data-count="' + key + '"]');
        if (el) el.textContent = data.counts[key];
      });
      if (data.latestId > latestId) {
        latestId = data.latestId;
        announceNew();
      }
      setLive(true);
    }).catch(function () {
      setLive(false);
    }).then(function () {
      busy = false;
    });
  }

  setInterval(refresh, REFRESH_MS);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      document.title = baseTitle;
      refresh();
    }
  });
})();
