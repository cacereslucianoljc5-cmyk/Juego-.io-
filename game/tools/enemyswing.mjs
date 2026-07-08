import { chromium } from 'playwright-core';
import fs from 'node:fs';
const outDir = process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--headless=new','--no-sandbox','--enable-unsafe-webgpu','--use-webgpu-adapter=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message.slice(0,200)}`));
await page.goto('http://localhost:5173/?headless=1', { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 150000 });
const shot = async (name) => {
  const dataUrl = await Promise.race([
    page.evaluate('window.__shot()'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000)),
  ]).catch(() => null);
  if (dataUrl) { fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(dataUrl.split(',')[1], 'base64')); console.log('shot:', name); }
};
await page.waitForTimeout(2500);
// spawnear al rey (cetro, idx 7) y al de hielo (idx 9) al lado del jugador
await page.evaluate(`(async () => {
  const g = window.__game; const e = g.enemies;
  await g.ensureChar(7); await g.ensureChar(9);
  e.spawn(7, g.player.x + 2.4, g.player.z - 0.5, 0);
  e.spawn(9, g.player.x - 2.4, g.player.z + 0.5, 0);
})()`);
// windup 0.55s + spawn 0.55 → capturar en mitad del swing
await page.waitForTimeout(1350);
await shot('h1_enemigos_swing_a');
await page.waitForTimeout(220);
await shot('h2_enemigos_swing_b');
await page.waitForTimeout(220);
await shot('h3_enemigos_swing_c');
await browser.close();
process.exit(0);
