/**
 * Decals de suelo por SDF: telegraphs de ataques (círculo, sector, línea),
 * anillos de shockwave, charcos, quemaduras y anillo de vida bajo el jugador.
 */
import tgpu, { d, std } from 'typegpu';
import { perlin2d } from '@typegpu/noise';
import { MAX_DECALS } from '../core/constants';
import { DEPTH_FORMAT, HDR_FORMAT } from './gpu';
import type { Gfx } from './gpu';

export const DECAL = {
  telegraphCircle: 0,
  ring: 1,
  sector: 2,
  line: 3,
  hpArc: 4,
  goo: 5,
  scorch: 6,
} as const;

const Decal = d.struct({
  posRot: d.vec4f, // x, z, tamaño (radio o long/2), rot
  params: d.vec4f, // tipo, progreso 0..1, arco/anchura, alpha
  color: d.vec4f,
});

const layout = tgpu.bindGroupLayout({
  decals: { storage: d.arrayOf(Decal) },
});

export interface DecalSystem {
  /** Añade un decal para este frame. Devuelve false si el pool está lleno. */
  push(x: number, z: number, size: number, rot: number, type: number, progress: number, arc: number, alpha: number, r: number, g: number, b: number): void;
  upload(): void;
  draw(pass: GPURenderPassEncoder): void;
}

export function createDecalSystem(gfx: Gfx): DecalSystem {
  const scene = gfx.scene;
  const root = gfx.root as any;
  const buffer = root.createBuffer(d.arrayOf(Decal, MAX_DECALS)).$usage('storage');
  const bg = gfx.root.createBindGroup(layout, { decals: buffer });

  const vert = tgpu.vertexFn({
    in: { vid: d.builtin.vertexIndex, iid: d.builtin.instanceIndex },
    out: { position: d.builtin.position, local: d.vec2f, params: d.vec4f, color: d.vec4f },
  })((input) => {
    'use gpu';
    const dec = layout.$.decals[input.iid];
    const cx = std.select(-1.0, 1.0, input.vid === 1 || input.vid === 3);
    const cy = std.select(-1.0, 1.0, input.vid >= 2);
    const size = dec.posRot.z;
    const cr = std.cos(dec.posRot.w);
    const sr = std.sin(dec.posRot.w);
    const lx = cx * cr - cy * sr;
    const lz = cx * sr + cy * cr;
    const wp = d.vec3f(dec.posRot.x + lx * size, 0.04, dec.posRot.y + lz * size);
    return {
      position: std.mul(scene.$.viewProj, d.vec4f(wp, 1)),
      local: d.vec2f(cx, cy),
      params: d.vec4f(dec.params),
      color: d.vec4f(dec.color),
    };
  });

  const frag = tgpu.fragmentFn({
    in: { local: d.vec2f, params: d.vec4f, color: d.vec4f },
    out: d.vec4f,
  })((input) => {
    'use gpu';
    const ty = input.params.x;
    const prog = input.params.y;
    const arc = input.params.z;
    const alphaIn = input.params.w;
    const r = std.length(input.local);
    const aa = std.fwidth(r) * 1.5 + 0.001;
    let a = d.f32(0);
    let boost = d.f32(1);
    if (ty < 0.5) {
      // telegraph circular: aro + relleno que crece con el progreso
      const rim = 1 - std.smoothstep(0.02, 0.02 + aa * 2, std.abs(r - 0.97) - 0.02);
      const fill = (1 - std.smoothstep(prog - aa, prog, r)) * 0.42;
      const pulse = 0.75 + 0.25 * std.sin(scene.$.camPosTime.w * 12.0);
      a = (rim * pulse + fill) * (1 - std.step(1.0, r));
      boost = 1 + prog * 2.2;
    } else if (ty < 1.5) {
      // anillo en expansión
      const rr = std.abs(r - prog);
      a = (1 - std.smoothstep(0.0, 0.09 + aa, rr)) * (1 - prog * 0.85);
      boost = 2.2;
    } else if (ty < 2.5) {
      // sector angular
      const ang = std.abs(std.atan2(input.local.y, input.local.x));
      const inArc = 1 - std.smoothstep(arc - 0.04, arc + 0.02, ang);
      const rim = 1 - std.smoothstep(0.03, 0.03 + aa * 2, std.abs(r - 0.96) - 0.015);
      const fill = (1 - std.smoothstep(prog - aa, prog, r)) * 0.45;
      a = inArc * (rim * 0.8 + fill) * (1 - std.step(1.0, r));
      boost = 1 + prog * 2.2;
    } else if (ty < 3.5) {
      // línea de carga (quad estirado): local.x = a lo largo
      const w = 1 - std.smoothstep(arc - aa, arc + aa, std.abs(input.local.y));
      const head = 1 - std.smoothstep(prog - 0.04, prog, (input.local.x + 1) * 0.5);
      const rim = std.smoothstep(arc * 0.55, arc, std.abs(input.local.y));
      a = w * (0.28 + rim * 0.5) * (1 - head * 0.0) * (1 - std.step(1.0, std.abs(input.local.x)));
      const fillHead = (1 - std.smoothstep(prog - 0.03, prog + 0.001, std.abs((input.local.x + 1) * 0.5 - prog)));
      a += w * fillHead * 0.0;
      boost = 1.6 + prog * 1.4;
    } else if (ty < 4.5) {
      // arco de vida: anillo parcial
      const ring = std.smoothstep(0.78, 0.82, r) * (1 - std.smoothstep(0.95, 0.99, r));
      const ang01 = (std.atan2(input.local.x, -input.local.y) + 3.14159265) / 6.2831853;
      const on = 1 - std.step(prog, ang01);
      a = ring * (0.12 + on * 0.88);
      boost = 1.8;
    } else if (ty < 5.5) {
      // charco orgánico
      const wob = perlin2d.sample(input.local * 2.6 + d.vec2f(input.params.z, 0)) * 0.16;
      a = (1 - std.smoothstep(0.62 + wob, 0.8 + wob, r)) * 0.75;
      const rim = 1 - std.smoothstep(0.0, 0.1, std.abs(r - (0.72 + wob)));
      a += rim * 0.4;
      boost = 1.2;
    } else {
      // quemadura
      a = (1 - std.smoothstep(0.2, 0.95, r)) * 0.72;
      boost = 0.0;
    }
    const alpha = a * alphaIn;
    return d.vec4f(input.color.rgb * (alpha * boost), alpha);
  });

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
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less' },
  });

  const raw = new Float32Array(MAX_DECALS * 12);
  let count = 0;

  return {
    push(x, z, size, rot, type, progress, arc, alpha, r, g, b) {
      if (count >= MAX_DECALS) return;
      const o = count * 12;
      raw[o] = x; raw[o + 1] = z; raw[o + 2] = size; raw[o + 3] = rot;
      raw[o + 4] = type; raw[o + 5] = progress; raw[o + 6] = arc; raw[o + 7] = alpha;
      raw[o + 8] = r; raw[o + 9] = g; raw[o + 10] = b; raw[o + 11] = 1;
      count++;
    },
    upload() {
      if (count > 0) buffer.write(raw.subarray(0, count * 12));
      (this as any)._drawCount = count;
      count = 0;
    },
    draw(pass: GPURenderPassEncoder) {
      const n = (this as any)._drawCount ?? 0;
      if (n > 0) pipeline.with(pass).with(bg).draw(4, n);
    },
  };
}
