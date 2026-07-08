import { chromium } from 'playwright-core';
import fs from 'node:fs';
const outDir = process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--headless=new','--no-sandbox','--enable-unsafe-webgpu','--use-webgpu-adapter=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('console', (m) => { const t = m.text(); if (t.includes('swing') || t.includes('fps')) console.log(t); });
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
await shot('g1_suelo');
// congelar mitad de swing del jugador: atacar y capturar en el pico
await page.mouse.move(480, 200);
await page.mouse.down();
await page.waitForTimeout(140);
await shot('g2_swing_cuchillo');
await page.mouse.up();
// cambiar a guadaña y capturar su swing
await page.keyboard.press('Digit7');
await page.waitForTimeout(700);
await page.mouse.down();
await page.waitForTimeout(300);
await shot('g3_swing_guadana');
await page.mouse.up();
// dejar que un enemigo ataque de cerca: teleport enemigo al lado y esperar su windup→attack
await page.evaluate(`(() => {
  const g = window.__game; const e = g.enemies;
  const i = e.spawn(3, g.player.x + 2.2, g.player.z, 0); // alfanje
  if (i >= 0) { e.state[i] = 1; }
})()`);
await page.waitForTimeout(1400);
await shot('g4_enemigo_atacando');
await browser.close();
process.exit(0);
