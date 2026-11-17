import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { launchBrowser } from './browser-runtime.js';
const browser = await launchBrowser();
try {
  const svg = (await fs.readFile(path.join(ROOT, 'public/icon.svg'), 'utf8')).replace('rx="48"', 'rx="0"');
  await fs.mkdir(path.join(ROOT, 'public/icons'), { recursive: true });
  const page = await browser.newPage();
  for (const [size, name] of [[192, 'icon-192.png'], [512, 'icon-512.png'], [180, 'apple-touch-icon.png']]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>body{margin:0}svg{width:100vw;height:100vh;display:block}</style>${svg}`);
    await page.screenshot({ path: path.join(ROOT, 'public/icons', name) });
  }
  console.log('Generated three PWA icons.');
} finally { await browser.close(); }
