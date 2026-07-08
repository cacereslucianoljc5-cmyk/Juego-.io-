/**
 * Weapon trails: cintas construidas en CPU a partir del historial de la
 * posición del arma (base y punta), renderizadas aditivas con ruido de
 * corriente y desvanecimiento por edad.
 */
import tgpu, { d, std } from 'typegpu';
import { perlin2d } from '@typegpu/noise';
import { MAX_TRAILS, MAX_TRAIL_SAMPLES } from '../core/constants';
import { DEPTH_FORMAT, HDR_FORMAT } from './gpu';
import type { Gfx } from './gpu';

const trailVertexLayout = tgpu.vertexLayout(
  (n: number) => d.disarrayOf(d.unstruct({
    pos: d.float32x3,
    data: d.float32x4, // u (0 nuevo → 1 viejo), v (0 base → 1 punta), alpha, glow
    col: d.float32x4,
  }), n),
);

export interface Trail {
  /** empuja un segmento nuevo (base y punta del arma en mundo) */
  push(bx: number, by: number, bz: number, tx: number, ty: number, tz: number): void;
  setColor(r: number, g: number, b: number, glow: number): void;
  clear(): void;
  active: boolean;
}

export interface TrailSystem {
  trails: Trail[];
  update(dt: number): void;
  upload(): void;
  draw(pass: GPURenderPassEncoder): void;
}

const FLOATS_PER_VERT = 11;
const VERTS_PER_TRAIL = MAX_TRAIL_SAMPLES * 2;

export function createTrailSystem(gfx: Gfx): TrailSystem {
  const scene = gfx.scene;
  const root = gfx.root as any;
  const totalVerts = MAX_TRAILS * VERTS_PER_TRAIL;
  const vertexBuffer = root.createBuffer(trailVertexLayout.schemaForCount(totalVerts)).$usage('vertex');

  const vert = tgpu.vertexFn({
    in: { pos: d.vec3f, data: d.vec4f, col: d.vec4f },
    out: { position: d.builtin.position, data: d.vec4f, col: d.vec4f },
  })((input) => {
    'use gpu';
    return {
      position: std.mul(scene.$.viewProj, d.vec4f(input.pos, 1)),
      data: d.vec4f(input.data),
      col: d.vec4f(input.col),
    };
  });

  const frag = tgpu.fragmentFn({
    in: { data: d.vec4f, col: d.vec4f },
    out: d.vec4f,
  })((input) => {
    'use gpu';
    const u = input.data.x;
    const v = input.data.y;
    const time = scene.$.camPosTime.w;
    // corriente de energía a lo largo de la cinta
    const streak = perlin2d.sample(d.vec2f(u * 5 - time * 7, v * 2.4)) * 0.5 + 0.5;
    const core = std.pow(std.sin(v * 3.14159265), 0.7);
    const fade = (1 - u) * (1 - u);
    const a = input.data.z * fade * core * (0.45 + streak * 0.8);
    const edge = std.pow(std.sin(std.clamp(v, 0, 1) * 3.14159265), 4) * fade;
    const rgb = input.col.rgb * (a * (1 + input.data.w)) + d.vec3f(1, 1, 1) * (edge * a * 0.7);
    return d.vec4f(rgb, 0);
  });

  const pipeline = gfx.root.createRenderPipeline({
    attribs: { ...(trailVertexLayout as any).attrib },
    vertex: vert,
    fragment: frag,
    targets: {
      format: HDR_FORMAT,
      blend: {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      },
    },
    primitive: { topology: 'triangle-strip' },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less' },
  });

  const raw = new Float32Array(totalVerts * FLOATS_PER_VERT);

  interface TrailState {
    samples: Float32Array; // ring: [bx,by,bz,tx,ty,tz,age] × MAX_TRAIL_SAMPLES
    head: number;
    len: number;
    r: number; g: number; b: number; glow: number;
    active: boolean;
  }

  const states: TrailState[] = [];
  const trails: Trail[] = [];
  for (let i = 0; i < MAX_TRAILS; i++) {
    const st: TrailState = {
      samples: new Float32Array(MAX_TRAIL_SAMPLES * 7),
      head: 0, len: 0, r: 1, g: 1, b: 1, glow: 1, active: false,
    };
    states.push(st);
    trails.push({
      push(bx, by, bz, tx, ty, tz) {
        st.head = (st.head + 1) % MAX_TRAIL_SAMPLES;
        const o = st.head * 7;
        st.samples[o] = bx; st.samples[o + 1] = by; st.samples[o + 2] = bz;
        st.samples[o + 3] = tx; st.samples[o + 4] = ty; st.samples[o + 5] = tz;
        st.samples[o + 6] = 0;
        st.len = Math.min(st.len + 1, MAX_TRAIL_SAMPLES);
        st.active = true;
      },
      setColor(r, g, b, glow) {
        st.r = r; st.g = g; st.b = b; st.glow = glow;
      },
      clear() {
        st.len = 0;
        st.active = false;
      },
      get active() { return st.active; },
      set active(v: boolean) { st.active = v; },
    });
  }

  const TRAIL_LIFE = 0.16;

  return {
    trails,
    update(dt) {
      for (const st of states) {
        if (st.len === 0) continue;
        let alive = 0;
        for (let i = 0; i < st.len; i++) {
          const idx = ((st.head - i) % MAX_TRAIL_SAMPLES + MAX_TRAIL_SAMPLES) % MAX_TRAIL_SAMPLES;
          st.samples[idx * 7 + 6] += dt;
          if (st.samples[idx * 7 + 6] < TRAIL_LIFE) alive = i + 1;
        }
        st.len = alive;
        if (alive === 0) st.active = false;
      }
    },
    upload() {
      raw.fill(0);
      for (let t = 0; t < MAX_TRAILS; t++) {
        const st = states[t];
        const base = t * VERTS_PER_TRAIL * FLOATS_PER_VERT;
        for (let i = 0; i < st.len; i++) {
          const idx = ((st.head - i) % MAX_TRAIL_SAMPLES + MAX_TRAIL_SAMPLES) % MAX_TRAIL_SAMPLES;
          const s = idx * 7;
          const u = st.len > 1 ? i / (st.len - 1) : 0;
          const age = st.samples[s + 6];
          const alpha = Math.max(0, 1 - age / TRAIL_LIFE);
          for (let k = 0; k < 2; k++) {
            const o = base + (i * 2 + k) * FLOATS_PER_VERT;
            raw[o] = st.samples[s + k * 3];
            raw[o + 1] = st.samples[s + 1 + k * 3];
            raw[o + 2] = st.samples[s + 2 + k * 3];
            raw[o + 3] = u;
            raw[o + 4] = k;
            raw[o + 5] = alpha;
            raw[o + 6] = st.glow;
            raw[o + 7] = st.r; raw[o + 8] = st.g; raw[o + 9] = st.b; raw[o + 10] = 1;
          }
        }
      }
      vertexBuffer.write(raw);
    },
    draw(pass) {
      let any = false;
      for (const st of states) if (st.len > 1) { any = true; break; }
      if (!any) return;
      for (let t = 0; t < MAX_TRAILS; t++) {
        if (states[t].len < 2) continue;
        pipeline
          .with(pass)
          .with(trailVertexLayout as any, vertexBuffer)
          .draw(states[t].len * 2, 1, t * VERTS_PER_TRAIL);
      }
    },
  };
}
