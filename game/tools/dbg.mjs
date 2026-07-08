import { chromium } from 'playwright-core';
import fs from 'node:fs';
const flags = process.argv[4] ?? '{}';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--headless=new','--no-sandbox','--enable-unsafe-webgpu','--use-webgpu-adapter=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const logs = [];
page.on('console', (m) => { const t = m.text(); if (!t.includes('Implicit conversions')) logs.push(`[${m.type()}] ${t.slice(0,300)}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message.slice(0,300)}`));
await page.addInitScript(`window.__renderFlags = ${flags};`);
await page.goto('http://localhost:5173/?headless=1', { waitUntil: 'load' });
try {
  await page.waitForFunction('window.__ready === true || window.__bootError', { timeout: 120000 });
} catch { logs.push('TIMEOUT waiting ready'); }
await page.waitForTimeout(Number(process.argv[3] ?? 2500));
try {
  const dataUrl = await Promise.race([
    page.evaluate('window.__shot()'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('shot timeout')), 90000)),
  ]);
  fs.writeFileSync(process.argv[2], Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('SHOT OK:', process.argv[2]);
} catch (e) { console.log('shot failed:', e.message); }
console.log(logs.slice(-14).join('\n'));
await browser.close();
process.exit(0);
