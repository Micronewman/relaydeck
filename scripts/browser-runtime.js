import fs from 'node:fs';
import { chromium, webkit } from 'playwright';
export function launchBrowser() {
  if (process.env.BROWSER_ENGINE === 'webkit') return webkit.launch({ headless: true });
  const executablePath = process.env.BROWSER_BIN || [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ].find(file => fs.existsSync(file));
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}
