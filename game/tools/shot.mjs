/** Captura una screenshot del juego corriendo en el dev server. Uso: node tools/shot.mjs [url] [out.png] [waitMs] */
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'shot.png';
const waitMs = Number(process.argv[4] ?? 2500);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: [
    '--headless=new',
    '--no-sandbox',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer',
    '--use-angle=vulkan',
    '--use-webgpu-adapter=swiftshader',
    '--disable-gpu-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'load', timeout: 30000 });
const hasGpu = await page.evaluate(async () => {
  if (!navigator.gpu) return 'no navigator.gpu';
  const a = await navigator.gpu.requestAdapter();
  if (!a) return 'no adapter';
  return `adapter ok: ${a.info?.vendor ?? '?'} ${a.info?.architecture ?? ''}`;
});
console.log('WebGPU:', hasGpu);
await page.waitForTimeout(waitMs);
await page.screenshot({ path: out });
console.log('logs:\n' + logs.slice(0, 40).join('\n'));
console.log('screenshot:', out);
await browser.close();
