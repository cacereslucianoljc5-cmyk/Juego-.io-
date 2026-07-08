/**
 * Sprites billboard en mundo: números de daño (dígitos del atlas) y glifos
 * (estrella de crítico). Animados en CPU (pop, subida, fade), render instanciado.
 */
import tgpu, { d, std } from 'typegpu';
import { CELL } from './atlas';
import { MAX_SPRITES } from '../core/constants';
import { DEPTH_FORMAT, HDR_FORMAT } from './gpu';
import type { Gfx } from './gpu';

const Sprite = d.struct({
  posSize: d.vec4f,  // xyz, tamaño
  color: d.vec4f,    // rgb, alpha
  cell: d.vec4f,     // celda atlas, aditivo 0/1, -, -
});

const layout = tgpu.bindGroupLayout({
  sprites: { storage: d.arrayOf(Sprite) },
  atlas: { texture: d.texture2d(d.f32) },
});

interface DamageNumber {
  x: number; y: number; z: number;
  vx: number; vy: number;
  value: number;
  t: number;
  life: number;
  crit: boolean;
  r: number; g: number; b: number;
}

export interface SpriteSystem {
  spawnDamage(x: number, y: number, z: number, value: number, crit: boolean, r?: number, g?: number, b?: number): void;
  update(dt: number): void;
  upload(): void;
  draw(pass: GPURenderPassEncoder): void;
}

export function createSpriteSystem(gfx: Gfx, atlasView: any): SpriteSystem {
  const scene = gfx.scene;
  const root = gfx.root as any;
  const buffer = root.createBuffer(d.arrayOf(Sprite, MAX_SPRITES)).$usage('storage');
  const bg = gfx.root.createBindGroup(layout, { sprites: buffer, atlas: atlasView });

  const vert = tgpu.vertexFn({
    in: { vid: d.builtin.vertexIndex, iid: d.builtin.instanceIndex },
    out: { position: d.builtin.position, uv: d.vec2f, color: d.vec4f },
  })((input) => {
    'use gpu';
    const s = layout.$.sprites[input.iid];
    const cx = std.select(-1.0, 1.0, input.vid === 1 || input.vid === 3);
    const cy = std.select(-1.0, 1.0, input.vid >= 2);
    const size = s.posSize.w;
    const wpos = s.posSize.xyz
      + scene.$.camRightAspect.xyz * (cx * size)
      + scene.$.camUpShockR.xyz * (cy * size);
    const cellIdx = s.cell.x;
    const row = std.floor(cellIdx * 0.125);
    const col = cellIdx - row * 8;
    const uv = d.vec2f((col + cx * 0.5 + 0.5) * 0.125, (row + 0.5 - cy * 0.5) * 0.125);
    // premultiplicado; los aditivos (cell.y=1) emiten alpha 0
    const outA = std.select(s.color.a, d.f32(0), s.cell.y > 0.5);
    return {
      position: std.mul(scene.$.viewProj, d.vec4f(wpos, 1)),
      uv,
      color: d.vec4f(s.color.rgb * s.color.a, outA),
    };
  });

  const frag = tgpu.fragmentFn({
    in: { uv: d.vec2f, color: d.vec4f },
    out: d.vec4f,
  })((input) => {
    'use gpu';
    const tex = std.textureSample(layout.$.atlas, samp.$, input.uv);
    return d.vec4f(input.color.rgb * (tex.rgb * tex.a), input.color.a * tex.a);
  });

  const samp = gfx.clampSampler;

  const pipeline = gfx.root.createRenderPipeline({
    vertex: vert,
    fragment: frag,
    targets: {
      format: HDR_FORMAT,
      blend: {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
    },
    primitive: { topology: 'triangle-strip' },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
  });

  const numbers: DamageNumber[] = [];
  const raw = new Float32Array(MAX_SPRITES * 12);
  let drawCount = 0;

  const pushSprite = (x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, cell: number, additive: number): void => {
    if (drawCount >= MAX_SPRITES) return;
    const o = drawCount * 12;
    raw[o] = x; raw[o + 1] = y; raw[o + 2] = z; raw[o + 3] = size;
    raw[o + 4] = r; raw[o + 5] = g; raw[o + 6] = b; raw[o + 7] = a;
    raw[o + 8] = cell; raw[o + 9] = additive;
    drawCount++;
  };

  return {
    spawnDamage(x, y, z, value, crit, r, g, b) {
      if (numbers.length > 48) numbers.shift();
      const jx = (Math.random() - 0.5) * 0.6;
      numbers.push({
        x: x + jx, y, z: z + (Math.random() - 0.5) * 0.4,
        vx: jx * 1.4, vy: 5.2 + Math.random() * 1.5,
        value: Math.min(9999, Math.round(value)),
        t: 0, life: crit ? 1.0 : 0.75, crit,
        r: r ?? (crit ? 1.0 : 1.0), g: g ?? (crit ? 0.62 : 0.95), b: b ?? (crit ? 0.1 : 0.85),
      });
    },
    update(dt) {
      for (let i = numbers.length - 1; i >= 0; i--) {
        const n = numbers[i];
        n.t += dt;
        if (n.t >= n.life) { numbers.splice(i, 1); continue; }
        n.vy -= 12 * dt;
        n.y += n.vy * dt;
        n.x += n.vx * dt;
      }
      drawCount = 0;
      for (const n of numbers) {
        const t01 = n.t / n.life;
        // pop elástico al aparecer
        const pop = 1 + Math.max(0, 1 - n.t * 6) * (n.crit ? 1.6 : 0.8);
        const size = (n.crit ? 0.62 : 0.4) * pop;
        const alpha = 1 - Math.max(0, t01 - 0.55) / 0.45;
        const digits = String(n.value);
        const w = size * 0.72;
        const x0 = n.x - ((digits.length - 1) * w) / 2;
        if (n.crit) {
          pushSprite(n.x, n.y + 0.1, n.z, size * 2.2, 1.0, 0.5, 0.05, alpha * 0.5, CELL.crit, 1);
        }
        for (let i = 0; i < digits.length; i++) {
          pushSprite(x0 + i * w, n.y, n.z, size, n.r, n.g, n.b, alpha, CELL.digit0 + (digits.charCodeAt(i) - 48), 0);
        }
      }
    },
    upload() {
      if (drawCount > 0) buffer.write(raw.subarray(0, drawCount * 12));
    },
    draw(pass) {
      if (drawCount > 0) pipeline.with(pass).with(bg).draw(4, drawCount);
    },
  };
}
