/**
 * Menú minimalista de selección de personaje. Overlay DOM sobre la arena
 * renderizada de fondo; cada tarjeta usa el color del arma del personaje.
 * Única pieza de UI del juego: desaparece al elegir y no vuelve.
 */
import { CHARACTERS } from './defs';

const SIGNATURE_LABEL: Record<string, string> = {
  sparks: 'chispas y críticos',
  flame: 'quemaduras',
  golden: 'golpe dorado',
  tide: 'marea que empuja',
  gears: 'impacto pesado',
  lightning: 'relámpago en cadena',
  souls: 'roba almas al matar',
  frost: 'congela enemigos',
  goo: 'baba ralentizante',
  bleed: 'sangrado',
  neon: 'nova neón',
  shards: 'nova de esquirlas',
  venom: 'veneno',
  none: '',
};

export function showCharacterMenu(onSelect: (idx: number) => Promise<void>): void {
  const css = document.createElement('style');
  css.textContent = `
  #csel { position: fixed; inset: 0; z-index: 10; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 20px;
    background: radial-gradient(ellipse at center, rgba(6,8,16,0.55) 0%, rgba(4,5,10,0.88) 100%);
    font-family: system-ui, -apple-system, sans-serif; color: #e8ecf4;
    opacity: 1; transition: opacity 0.45s ease; padding: 24px; box-sizing: border-box; }
  #csel.out { opacity: 0; pointer-events: none; }
  #csel h1 { margin: 0; font-size: clamp(26px, 4.5vw, 44px); font-weight: 900;
    letter-spacing: 0.24em; text-shadow: 0 0 24px rgba(90,200,255,0.55); }
  #csel p.sub { margin: 0; opacity: 0.65; font-size: 14px; letter-spacing: 0.12em; text-transform: uppercase; }
  #csel .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
    gap: 10px; width: min(920px, 94vw); }
  #csel button.card { position: relative; border: 1px solid rgba(255,255,255,0.14);
    border-left: 4px solid var(--c); border-radius: 10px; padding: 12px 12px 10px;
    background: rgba(16,20,32,0.72); color: inherit; text-align: left; cursor: pointer;
    transition: transform 0.12s ease, background 0.12s ease, box-shadow 0.12s ease; }
  #csel button.card:hover, #csel button.card:focus-visible { transform: translateY(-3px);
    background: rgba(28,34,52,0.85); box-shadow: 0 6px 22px -6px var(--c); outline: none; }
  #csel button.card .n { display: block; font-weight: 700; font-size: 14px; margin-bottom: 3px; }
  #csel button.card .s { display: block; font-size: 11px; opacity: 0.62; min-height: 26px; }
  #csel button.card .k { position: absolute; top: 8px; right: 9px; font-size: 10px;
    opacity: 0.4; font-variant-numeric: tabular-nums; }
  #csel button.card.loading { opacity: 0.55; cursor: wait; }
  #csel p.keys { margin: 0; font-size: 12px; opacity: 0.5; text-align: center; }
  `;
  document.head.appendChild(css);

  const root = document.createElement('div');
  root.id = 'csel';
  const h1 = document.createElement('h1');
  h1.textContent = 'ARENA.IO';
  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.textContent = 'Elige tu personaje — los otros 13 te cazan';
  const grid = document.createElement('div');
  grid.className = 'grid';

  let busy = false;
  CHARACTERS.forEach((def, idx) => {
    const card = document.createElement('button');
    card.className = 'card';
    const [r, g, b] = def.weapon.trail;
    card.style.setProperty('--c', `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`);
    const key = idx < 10 ? `${(idx + 1) % 10}` : '';
    card.innerHTML = `<span class="n">${def.name}</span>`
      + `<span class="s">${SIGNATURE_LABEL[def.weapon.signature] ?? ''}</span>`
      + (key ? `<span class="k">${key}</span>` : '');
    card.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      card.classList.add('loading');
      card.querySelector('.s')!.textContent = 'cargando…';
      try {
        await onSelect(idx);
        root.classList.add('out');
        setTimeout(() => {
          root.remove();
          css.remove();
        }, 500);
      } catch (e) {
        console.error('no se pudo cargar el personaje', e);
        card.classList.remove('loading');
        busy = false;
      }
    });
    grid.appendChild(card);
  });

  const keys = document.createElement('p');
  keys.className = 'keys';
  keys.textContent = 'WASD mover · ratón apuntar · clic atacar · clic derecho ataque pesado · Espacio dash · 1-9/0 y Tab cambiar de personaje · rueda zoom';

  root.append(h1, sub, grid, keys);
  document.body.appendChild(root);
}
