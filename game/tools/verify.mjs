/**
 * Verificación headless del juego: lo arranca en Chromium (swiftshader),
 * simula input (mover, atacar, heavy, dash, boss, cambio de personaje) y
 * guarda screenshots vía el hook window.__shot (readback de GPU).
 *
 * Uso:
 *   npx vite --port 5173 &        # dev server
 *   node tools/verify.mjs out/    # guarda out/v1_*.png ...
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const outDir = process.argv[2] ?? '.';
const url = process.argv[3] ?? 'http://localhost:5173/?headless=1';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--headless=new', '--no-sandbox', '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('console', (m) => {
  const t = m.text();
  if (!t.includes('Implicit') && !t.includes('vite')) console.log(`[${m.type()}] ${t.slice(0, 200)}`);
});
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true || window.__bootError', { timeout: 150000 });
const bootErr = await page.evaluate('window.__bootError ?? null');
if (bootErr) {
  console.error('BOOT ERROR:', bootErr);
  process.exit(1);
}

const shot = async (name) => {
  const dataUrl = await Promise.race([
    page.evaluate('window.__shot()'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('shot timeout')), 60000)),
  ]).catch((e) => (console.log('SHOT FAILED:', name, e.message), null));
  if (dataUrl) {
    fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('shot:', name);
  }
};

await page.waitForTimeout(3000);
await page.keyboard.down('KeyW');
await page.waitForTimeout(600);
await page.keyboard.up('KeyW');
await shot('v1_mundo');

await page.mouse.move(400, 220);
await page.mouse.down();
await page.waitForTimeout(400);
await shot('v2_combate');
await page.mouse.up();

await page.mouse.down({ button: 'right' });
await page.waitForTimeout(500);
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(250);
await shot('v3_heavy');

await page.keyboard.press('Space');
await page.waitForTimeout(150);
await shot('v4_dash');

await page.evaluate('window.__game.enemies.spawn(6, window.__game.player.x + 8, window.__game.player.z, 0)');
await page.waitForTimeout(2000);
await shot('v5_boss');

await page.keyboard.press('Digit7');
await page.waitForTimeout(900);
await shot('v6_personaje');

const state = await page.evaluate(
  '({hp: Math.round(window.__game.player.hp), char: window.__game.player.asset.def.name, enemigos: window.__game.enemies.aliveCount, kills: window.__game.enemies.killCount})',
);
console.log('estado final:', JSON.stringify(state));
await browser.close();
process.exit(0);
