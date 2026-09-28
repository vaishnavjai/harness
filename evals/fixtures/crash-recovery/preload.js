(() => {
  const query = new URLSearchParams(location.search);
  const witness = window.crashRecovery = { fetches: [], beacons: [], errors: [], rejections: [], copies: [], clipboardAttempts: 0, ready: false, throws: 0, executed: false, boot: crypto.randomUUID(), trustedClicks: [] };
  window.residual = witness;
  // Installed before the product module graph. Never forwards to the network:
  // any call here is a crash report leaving the app, which must never happen.
  window.fetch = (url, options = {}) => {
    witness.fetches.push({ url: String(url), method: options.method, body: options.body, keepalive: options.keepalive, callStack: new Error('synthetic fetch witness').stack });
    return Promise.resolve(new Response('', { status: 200 }));
  };
  navigator.sendBeacon = url => { witness.beacons.push(String(url)); return true; };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: query.get('clipboard') === 'absent' ? undefined : { writeText(text) {
    witness.clipboardAttempts++;
    if (query.get('clipboard') === 'denied') return Promise.reject(new Error('FAKE_CLIPBOARD_DENIAL_SECRET'));
    witness.copies.push(text);
    return Promise.resolve();
  } } });
  window.addEventListener('error', event => witness.errors.push(event.message));
  window.addEventListener('unhandledrejection', event => witness.rejections.push(typeof event.reason?.message === 'string' ? event.reason.message : 'non-string rejection'));
  window.addEventListener('click', event => witness.trustedClicks.push(event.isTrusted), true);
  if (query.get('electron') === 'yes') window.__HARNESS_ELECTRON__ = {};
})();
