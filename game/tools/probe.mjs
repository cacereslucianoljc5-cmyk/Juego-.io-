import { chromium } from 'playwright-core';
const mode = process.argv[2] ?? 'present';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--headless=new','--no-sandbox','--enable-unsafe-webgpu','--use-webgpu-adapter=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
await page.goto('http://localhost:5173/probe.html?mode=' + mode, { waitUntil: 'load' });
await page.waitForTimeout(Number(process.argv[3] ?? 15000));
const state = await page.evaluate('window.__state').catch(e => 'EVAL FAIL');
console.log(mode, '→', JSON.stringify(state));
await browser.close();
process.exit(0);
