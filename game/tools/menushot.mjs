import { chromium } from 'playwright-core';
import fs from 'node:fs';
const outDir = process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--headless=new','--no-sandbox','--enable-unsafe-webgpu','--use-webgpu-adapter=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message.slice(0,200)}`));
await page.goto('http://localhost:5173/?headless=1&menu=1', { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 150000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${outDir}/m1_menu.png` });
console.log('shot: m1_menu (DOM)');
// clic en la Guadaña (7ª tarjeta)
await page.click('#csel .grid button.card:nth-child(7)');
await page.waitForFunction('window.__game.started === true', { timeout: 30000 });
await page.waitForTimeout(1200);
const dataUrl = await Promise.race([
  page.evaluate('window.__shot()'),
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000)),
]).catch(() => null);
if (dataUrl) { fs.writeFileSync(`${outDir}/m2_ingame.png`, Buffer.from(dataUrl.split(',')[1], 'base64')); console.log('shot: m2_ingame'); }
const st = await page.evaluate('({started: window.__game.started, char: window.__game.player.asset.def.name})');
console.log('estado:', JSON.stringify(st));
await browser.close();
process.exit(0);
