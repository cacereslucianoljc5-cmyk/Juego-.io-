/**
 * Sistema de partículas 100% GPU:
 *  - la CPU encola EmitRequests (forma, dirección, colores, física)
 *  - compute de emisión: inicializa partículas en un ring buffer con RNG GPU
 *  - compute de update: integración, gravedad, drag, turbulencia perlin,
 *    rebote contra el suelo y atracción hacia el jugador (almas)
 *  - render instanciado con billboard, atlas procedural y blending
 *    premultiplicado (aditivo y alfa en un solo draw)
 */
import tgpu, { d, std } from 'typegpu';
import { perlin3d, randf } from '@typegpu/noise';
import { MAX_EMIT_REQUESTS, MAX_PARTICLES } from '../core/constants';
import { DEPTH_FORMAT, HDR_FORMAT } from './gpu';
import type { Gfx } from './gpu';

const Particle = d.struct({
  posAge: d.vec4f,
  velLife: d.vec4f,
  color0: d.vec4f,
  color1: d.vec4f,
  sizeRot: d.vec4f, // size0, size1, rot, rotVel
  physics: d.vec4f, // gravity, drag, kind, stretch
  flags: d.vec4f,   // collide, attract, align, turb
});

const EmitReq = d.struct({
  origin: d.vec4f,  // xyz, shape (0 cono, 1 esfera, 2 anillo, 3 hemisferio)
  dir: d.vec4f,     // xyz, spread 0..1
  speed: d.vec4f,   // min, max, radius, upBias
  life: d.vec4f,    // min, max, size0, size1
  color0: d.vec4f,
  color1: d.vec4f,
  physics: d.vec4f, // gravity, drag, kind, stretch
  flags: d.vec4f,
  range: d.vec4f,   // base, count, seed, rotVel
});

const Params = d.struct({
  a: d.vec4f, // dt, time, totalEmit, reqCount
  b: d.vec4f, // ringCursor, poolSize, -, -
});

const layout = tgpu.bindGroupLayout({
  particles: { storage: d.arrayOf(Particle), access: 'mutable' },
  requests: { storage: d.arrayOf(EmitReq) },
  params: { uniform: Params },
});

const renderLayout = tgpu.bindGroupLayout({
  particles: { storage: d.arrayOf(Particle) },
  atlas: { texture: d.texture2d(d.f32) },
});

export interface EmitOptions {
  x: number; y: number; z: number;
  shape?: number;      // 0 cono, 1 esfera, 2 anillo, 3 hemisferio arriba
  dirX?: number; dirY?: number; dirZ?: number;
  spread?: number;
  count: number;
  speedMin?: number; speedMax?: number;
  radius?: number; upBias?: number;
  lifeMin?: number; lifeMax?: number;
  size0?: number; size1?: number;
  kind?: number;       // celda del atlas
  r0: number; g0: number; b0: number; a0?: number; // a=0 → aditivo
  r1?: number; g1?: number; b1?: number; a1?: number;
  gravity?: number; drag?: number;
  stretch?: number; rotVel?: number;
  collide?: boolean; attract?: boolean; align?: boolean; turb?: number;
}

export interface ParticleSystem {
  emit(o: EmitOptions): void;
  compute(encoder: GPUCommandEncoder, dt: number, time: number): void;
  draw(pass: GPURenderPassEncoder): void;
}

export function createParticleSystem(gfx: Gfx, atlasView: any): ParticleSystem {
  const scene = gfx.scene;
  const root = gfx.root as any;

  const particleBuffer = root.createBuffer(d.arrayOf(Particle, MAX_PARTICLES)).$usage('storage');
  const requestBuffer = root.createBuffer(d.arrayOf(EmitReq, MAX_EMIT_REQUESTS)).$usage('storage');
  const paramsBuffer = root.createBuffer(Params).$usage('uniform');

  const computeBG = gfx.root.createBindGroup(layout, {
    particles: particleBuffer, requests: requestBuffer, params: paramsBuffer,
  });
  const renderBG = gfx.root.createBindGroup(renderLayout, {
    particles: particleBuffer, atlas: atlasView,
  });

  // ---------- EMIT ----------
  const emitFn = tgpu.computeFn({
    workgroupSize: [64],
    in: { gid: d.builtin.globalInvocationId },
  })((input) => {
    'use gpu';
    const i = input.gid.x;
    const total = d.u32(layout.$.params.a.z);
    if (i >= total) {
      return;
    }
    // busca la request de este hilo
    const reqCount = d.u32(layout.$.params.a.w);
    let reqIdx = d.u32(0);
    for (let r = d.u32(0); r < reqCount; r++) {
      const rq = layout.$.requests[r];
      if (d.f32(i) >= rq.range.x && d.f32(i) < rq.range.x + rq.range.y) {
        reqIdx = r;
      }
    }
    const req = layout.$.requests[reqIdx];
    const slotF = layout.$.params.b.x + d.f32(i);
    const pool = layout.$.params.b.y;
    const slot = d.u32(slotF - std.floor(slotF / pool) * pool);

    randf.seed2(d.vec2f(d.f32(slot) * 0.0173 + 0.31, layout.$.params.a.y * 0.37 + req.range.z * 0.613));

    const shape = req.origin.w;
    const spread = req.dir.w;
    const speed = std.mix(req.speed.x, req.speed.y, randf.sample());
    let pos = d.vec3f(req.origin.xyz);
    let vel = d.vec3f();
    if (shape < 0.5) {
      // cono alrededor de dir
      const rd = randf.onUnitSphere();
      const dir = std.normalize(std.mix(d.vec3f(req.dir.xyz), rd, spread) + d.vec3f(0.0001, 0, 0));
      vel = dir * speed;
    } else if (shape < 1.5) {
      // cáscara esférica
      const rd = randf.onUnitSphere();
      pos += rd * (req.speed.z * (0.5 + randf.sample() * 0.5));
      vel = rd * speed;
    } else if (shape < 2.5) {
      // anillo XZ hacia fuera
      const a = randf.sample() * 6.2831853;
      const rd = d.vec3f(std.cos(a), 0, std.sin(a));
      pos += rd * req.speed.z;
      vel = rd * speed;
    } else {
      // hemisferio hacia arriba
      const rd = randf.onHemisphere(d.vec3f(0, 1, 0));
      vel = std.normalize(std.mix(rd, d.vec3f(req.dir.xyz), 1 - spread)) * speed;
    }
    vel.y += req.speed.w;
    const life = std.mix(req.life.x, req.life.y, randf.sample());
    const sizeJitter = 0.75 + randf.sample() * 0.5;

    layout.$.particles[slot] = Particle({
      posAge: d.vec4f(pos, 0),
      velLife: d.vec4f(vel, life),
      color0: d.vec4f(req.color0),
      color1: d.vec4f(req.color1),
      sizeRot: d.vec4f(
        req.life.z * sizeJitter, req.life.w * sizeJitter,
        randf.sample() * 6.2831853, (randf.sample() - 0.5) * req.range.w,
      ),
      physics: d.vec4f(req.physics),
      flags: d.vec4f(req.flags),
    });
  });

  // ---------- UPDATE ----------
  const updateFn = tgpu.computeFn({
    workgroupSize: [64],
    in: { gid: d.builtin.globalInvocationId },
  })((input) => {
    'use gpu';
    const i = input.gid.x;
    if (i >= MAX_PARTICLES) {
      return;
    }
    const p = layout.$.particles[i];
    const age = p.posAge.w;
    const life = p.velLife.w;
    if (age >= life) {
      return;
    }
    const dt = layout.$.params.a.x;
    const time = layout.$.params.a.y;
    let pos = d.vec3f(p.posAge.xyz);
    let vel = d.vec3f(p.velLife.xyz);
    // atracción al jugador (almas)
    let newAge = age + dt;
    if (p.flags.y > 0.5) {
      const to = scene.$.playerGlow.xyz + d.vec3f(0, 0.9, 0) - pos;
      const dist = std.length(to);
      const pull = std.clamp(newAge * 2.2 - 0.35, 0, 1);
      vel = std.mix(vel, (to / std.max(dist, 0.01)) * 21, std.clamp(dt * (2 + pull * 14), 0, 1));
      if (dist < 0.7) {
        newAge = life;
      }
    }
    // turbulencia
    if (p.flags.w > 0.01) {
      const tn1 = perlin3d.sample(pos * 0.5 + d.vec3f(0, time * 0.25, 0));
      const tn2 = perlin3d.sample(pos * 0.5 + d.vec3f(53.7, time * 0.25, 11.9));
      vel += d.vec3f(tn1, 0.35 * tn2, tn2) * (p.flags.w * dt);
    }
    vel.y -= p.physics.x * dt;
    const dragK = std.clamp(1 - p.physics.y * dt, 0, 1);
    vel = vel * dragK;
    pos += vel * dt;
    // suelo
    if (p.flags.x > 0.5 && pos.y < 0.03 && vel.y < 0) {
      pos.y = 0.03;
      vel = d.vec3f(vel.x * 0.72, vel.y * -0.42, vel.z * 0.72);
    }
    layout.$.particles[i].posAge = d.vec4f(pos, newAge);
    layout.$.particles[i].velLife = d.vec4f(vel, life);
  });

  const emitPipeline = gfx.root.createComputePipeline({ compute: emitFn });
  const updatePipeline = gfx.root.createComputePipeline({ compute: updateFn });

  // ---------- RENDER ----------
  const vert = tgpu.vertexFn({
    in: { vid: d.builtin.vertexIndex, iid: d.builtin.instanceIndex },
    out: {
      position: d.builtin.position,
      uv: d.vec2f,
      color: d.vec4f, // premultiplicado; a=0 → aditivo
    },
  })((input) => {
    'use gpu';
    const p = renderLayout.$.particles[input.iid];
    const age = p.posAge.w;
    const life = p.velLife.w;
    const t = std.clamp(age / std.max(life, 0.001), 0, 1);
    const dead = std.select(d.f32(1), d.f32(0), age >= life || life <= 0);
    // esquinas del strip: 0:(-1,-1) 1:(1,-1) 2:(-1,1) 3:(1,1)
    const cxRaw = std.select(-1.0, 1.0, input.vid === 1 || input.vid === 3);
    const cyRaw = std.select(-1.0, 1.0, input.vid >= 2);
    const size = std.mix(p.sizeRot.x, p.sizeRot.y, t) * dead;
    const env = std.smoothstep(0, 0.07, t) * (1 - std.smoothstep(0.62, 1, t));

    // rotación en plano de pantalla
    const rot = p.sizeRot.z + p.sizeRot.w * age;
    const cr = std.cos(rot);
    const sr = std.sin(rot);
    const cx = cxRaw * cr - cyRaw * sr;
    const cy = cxRaw * sr + cyRaw * cr;

    let wpos = d.vec3f(p.posAge.xyz);
    if (p.flags.z > 0.5) {
      // alineada a la velocidad (chispas)
      const vlen = std.length(p.velLife.xyz);
      const axis = p.velLife.xyz / std.max(vlen, 0.001);
      const side = std.normalize(std.cross(scene.$.camFwdShockAmp.xyz, axis) + d.vec3f(0.001, 0, 0));
      const stretch = std.clamp(1 + vlen * p.physics.w * 0.14, 1, 5);
      wpos += axis * (cxRaw * size * stretch) + side * (cyRaw * size * 0.4);
    } else {
      wpos += scene.$.camRightAspect.xyz * (cx * size) + scene.$.camUpShockR.xyz * (cy * size);
    }

    const col = std.mix(p.color0, p.color1, t);
    const alphaMode = std.select(d.f32(1), col.a, col.a > 0.01);
    const premul = col.rgb * (env * alphaMode);

    // celda del atlas
    const kind = p.physics.z;
    const row = std.floor(kind * 0.125);
    const colIdx = kind - row * 8;
    const uv = d.vec2f(
      (colIdx + cxRaw * 0.5 + 0.5) * 0.125,
      (row + 0.5 - cyRaw * 0.5) * 0.125,
    );
    return {
      position: std.mul(scene.$.viewProj, d.vec4f(wpos, 1)),
      uv,
      color: d.vec4f(premul, col.a * env),
    };
  });

  const frag = tgpu.fragmentFn({
    in: { uv: d.vec2f, color: d.vec4f },
    out: d.vec4f,
  })((input) => {
    'use gpu';
    const tex = std.textureSample(renderLayout.$.atlas, gfxSampler.$, input.uv);
    return d.vec4f(input.color.rgb * (tex.rgb * tex.a), input.color.a * tex.a);
  });

  const gfxSampler = gfx.clampSampler;

  const renderPipeline = gfx.root.createRenderPipeline({
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

  // ---------- CPU ----------
  const reqRaw = new Float32Array(MAX_EMIT_REQUESTS * 36);
  let reqCount = 0;
  let totalEmit = 0;
  let ringCursor = 0;
  let seedCounter = 1;

  const emit = (o: EmitOptions): void => {
    if (reqCount >= MAX_EMIT_REQUESTS) return;
    const count = Math.min(o.count, 512);
    if (count <= 0) return;
    const b = reqCount * 36;
    reqRaw[b] = o.x; reqRaw[b + 1] = o.y; reqRaw[b + 2] = o.z; reqRaw[b + 3] = o.shape ?? 0;
    reqRaw[b + 4] = o.dirX ?? 0; reqRaw[b + 5] = o.dirY ?? 1; reqRaw[b + 6] = o.dirZ ?? 0; reqRaw[b + 7] = o.spread ?? 1;
    reqRaw[b + 8] = o.speedMin ?? 1; reqRaw[b + 9] = o.speedMax ?? 3; reqRaw[b + 10] = o.radius ?? 0; reqRaw[b + 11] = o.upBias ?? 0;
    reqRaw[b + 12] = o.lifeMin ?? 0.4; reqRaw[b + 13] = o.lifeMax ?? 0.9; reqRaw[b + 14] = o.size0 ?? 0.2; reqRaw[b + 15] = o.size1 ?? 0.05;
    reqRaw[b + 16] = o.r0; reqRaw[b + 17] = o.g0; reqRaw[b + 18] = o.b0; reqRaw[b + 19] = o.a0 ?? 0;
    reqRaw[b + 20] = o.r1 ?? o.r0; reqRaw[b + 21] = o.g1 ?? o.g0; reqRaw[b + 22] = o.b1 ?? o.b0; reqRaw[b + 23] = o.a1 ?? o.a0 ?? 0;
    reqRaw[b + 24] = o.gravity ?? 0; reqRaw[b + 25] = o.drag ?? 0; reqRaw[b + 26] = o.kind ?? 0; reqRaw[b + 27] = o.stretch ?? 1;
    reqRaw[b + 28] = o.collide ? 1 : 0; reqRaw[b + 29] = o.attract ? 1 : 0; reqRaw[b + 30] = o.align ? 1 : 0; reqRaw[b + 31] = o.turb ?? 0;
    reqRaw[b + 32] = totalEmit; reqRaw[b + 33] = count; reqRaw[b + 34] = (seedCounter = (seedCounter * 16807) % 2147483647) % 1000; reqRaw[b + 35] = o.rotVel ?? 0;
    reqCount++;
    totalEmit += count;
  };

  const paramsRaw = new Float32Array(8);

  const compute = (encoder: GPUCommandEncoder, dt: number, time: number): void => {
    paramsRaw[0] = dt; paramsRaw[1] = time; paramsRaw[2] = totalEmit; paramsRaw[3] = reqCount;
    paramsRaw[4] = ringCursor; paramsRaw[5] = MAX_PARTICLES;
    paramsBuffer.write(paramsRaw);
    if (totalEmit > 0) {
      requestBuffer.write(reqRaw.subarray(0, reqCount * 36));
      emitPipeline.with(encoder).with(computeBG).dispatchWorkgroups(Math.ceil(totalEmit / 64));
      ringCursor = (ringCursor + totalEmit) % MAX_PARTICLES;
    }
    updatePipeline.with(encoder).with(computeBG).dispatchWorkgroups(Math.ceil(MAX_PARTICLES / 64));
    reqCount = 0;
    totalEmit = 0;
  };

  const draw = (pass: GPURenderPassEncoder): void => {
    renderPipeline.with(pass).with(renderBG).draw(4, MAX_PARTICLES);
  };

  return { emit, compute, draw };
}
