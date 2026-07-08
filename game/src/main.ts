/**
 * Arranque del juego.
 * Controles: WASD mover · ratón apuntar · clic izq. atacar · clic dcho. ataque
 * pesado · Espacio/Shift dash · 1-9/0 personaje · Tab/E/Q ciclar · rueda zoom.
 */
import { Game } from './game/game';
import { showCharacterMenu } from './game/menu';

async function boot() {
  const canvas = document.getElementById('gfx') as HTMLCanvasElement;
  if (!navigator.gpu) {
    document.body.innerHTML = '<p style="color:#eee;font:16px system-ui;padding:2em">Este juego necesita WebGPU (Chrome/Edge 113+).</p>';
    return;
  }
  const params = new URLSearchParams(location.search);
  const headless = params.has('headless');
  const game = await Game.create(canvas, headless);

  if (headless && !params.has('menu')) {
    await game.start(0);
  } else {
    showCharacterMenu((idx) => game.start(idx));
  }

  const loop = (now: number) => {
    game.frame(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // hooks de verificación headless
  (window as any).__game = game;
  (window as any).__shot = async () => {
    const img = await game.renderer.capture();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  };
  (window as any).__ready = true;
}

boot().catch((e) => {
  console.error('BOOT ERROR', e);
  (window as any).__bootError = String(e?.stack ?? e);
});
