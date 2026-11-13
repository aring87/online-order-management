'use strict';
// Shared phone-app setup: registers the service worker and shows an "Install app" button / hint.
(() => {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  const btn = document.getElementById('install');
  const hint = document.getElementById('install-hint');
  if (!btn) return;

  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return;

  // Android / Chrome / Edge: native install prompt.
  let deferred;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.classList.remove('hidden');
  });
  btn.addEventListener('click', async () => {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      btn.classList.add('hidden');
    } else if (hint) {
      hint.classList.toggle('hidden');
    }
  });
  window.addEventListener('appinstalled', () => btn.classList.add('hidden'));

  // iPhone / iPad Safari has no install prompt — show how to add to the Home Screen instead.
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) btn.classList.remove('hidden');
})();
