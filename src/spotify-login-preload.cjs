// Spotify's sign-in window. On Spotify's own pages it's a normal Chromium; only on Google's pages
// («Continuar con Google») it presents itself as desktop Firefox, as the Google login does (see
// login-preload.cjs): Google refuses sign-in from embedded Chromium, and Spotify refuses Firefox's
// identity on a Chromium (HTTP 400 on its Facebook/Google/Apple buttons).
if (/(^|\.)google\.com$/.test(location.hostname)) {
  try {
    const nav = Object.getPrototypeOf(navigator);
    const def = (name, value) => { try { Object.defineProperty(nav, name, { get: () => value, configurable: true }); } catch {} };
    def('userAgentData', undefined);
    def('webdriver', false);
    def('vendor', '');
    def('productSub', '20100101');
    def('oscpu', 'Windows NT 10.0; Win64; x64');
    def('buildID', '20181001000000');
    try { delete window.chrome; } catch {}
    try { Object.defineProperty(window, 'chrome', { get: () => undefined, configurable: true }); } catch {}
  } catch {}
}
