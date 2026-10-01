// Runs in Google's sign-in page before its own scripts (contextIsolation: false, sandboxed).
// Google refuses sign-in from "embedded browsers" when it detects Electron/Chromium-without-Chrome
// signals. We present ourselves consistently as desktop Firefox, which has no Client Hints.
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
