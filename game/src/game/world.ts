/**
 * Disposición de la arena: estatuas (los 3 personajes sin rig como reliquias),
 * pilares en ruinas, rocas, cristales emisivos y tocones. Además, colisión de
 * círculos contra obstáculos y el borde del mapa.
 */
import { mat4 } from 'wgpu-matrix';
import { ARENA_R } from '../core/constants';
import { makeRng, randRange } from '../core/mathx';
import { crystalMesh, pillarMesh, rockMesh, stumpMesh } from '../gfx/meshes';
import { loadGlb } from '../gfx/glb';
import { writeInstance } from '../gfx/staticPipeline';
import type { Renderer } from '../gfx/renderer';
import type { Gfx } from '../gfx/gpu';
import { d } from 'typegpu';

export interface Obstacle {
  x: number; z: number; r: number;
}

export interface World {
  obstacles: Obstacle[];
  crystals: { x: number; z: number }[];
  /** empuja (x,z) fuera de los obstáculos y del borde; muta el punto dado */
  collide(p: { x: number; z: number }, radius: number): void;
}

const STATUES = ['12_devil_trident', '13_banana_katana', '16_ghost_lantern'];

export async function buildWorld(gfx: Gfx, renderer: Renderer): Promise<World> {
  const rng = makeRng(20260708);
  const obstacles: Obstacle[] = [];
  const crystals: { x: number; z: number }[] = [];
  const white = await gfx.uploadTexture(null);
  const whiteView = white.createView(d.texture2d(d.f32));
  const m = new Float32Array(16);

  const place = (dist: number, ang: number, jitter = 0): { x: number; z: number } => ({
    x: Math.cos(ang) * dist + (rng() - 0.5) * jitter,
    z: Math.sin(ang) * dist + (rng() - 0.5) * jitter,
  });

  // --- estatuas: reliquias de los 3 personajes sin rig ---
  for (let i = 0; i < STATUES.length; i++) {
    try {
      const model = await loadGlb(`./assets/props/${STATUES[i]}.glb`);
      const ang = (i / STATUES.length) * Math.PI * 2 + 0.7;
      const pos = place(30, ang);
      const height = model.bboxMax[1] - Math.min(0, model.bboxMin[1]);
      const s = 3.4 / Math.max(height, 0.01);
      mat4.identity(m);
      mat4.translate(m, [pos.x, 0, pos.z], m);
      mat4.rotateY(m, -ang + Math.PI * 0.5, m);
      mat4.uniformScale(m, s, m);
      for (const prim of model.primitives) {
        const mesh = gfx.uploadMeshFrom(prim.positions, prim.normals, prim.uvs, prim.indices);
        const tex = await gfx.uploadTexture(model.materials[prim.materialIdx]?.image ?? null);
        const batch = renderer.statics.createBatch(mesh, tex.createView(d.texture2d(d.f32)), 1);
        writeInstance(batch.raw, 0, m, 0.85, 0.82, 0.78, 0, 0, 0, 0.06, 0);
        batch.count = 1;
        batch.dirty = true;
        renderer.staticBatches.push(batch);
      }
      obstacles.push({ x: pos.x, z: pos.z, r: 1.3 });
    } catch (e) {
      console.warn('estatua no disponible:', STATUES[i], e);
    }
  }

  // --- pilares en ruinas (anillo interior) ---
  const pillars = renderer.statics.createBatch(gfx.uploadMesh(pillarMesh(11)), whiteView, 10);
  for (let i = 0; i < 7; i++) {
    const ang = (i / 7) * Math.PI * 2 + 0.25;
    const pos = place(15.5, ang, 2);
    const h = randRange(rng, 2.2, 4.2);
    mat4.identity(m);
    mat4.translate(m, [pos.x, 0, pos.z], m);
    mat4.rotateY(m, rng() * Math.PI, m);
    mat4.scale(m, [randRange(rng, 1.5, 1.9), h, randRange(rng, 1.5, 1.9)], m);
    writeInstance(pillars.raw, i, m, 0.48, 0.46, 0.45, 0, 0, 0, 0, 0);
    obstacles.push({ x: pos.x, z: pos.z, r: 0.95 });
  }
  pillars.count = 7;
  pillars.dirty = true;
  renderer.staticBatches.push(pillars);

  // --- rocas ---
  const rocks = renderer.statics.createBatch(gfx.uploadMesh(rockMesh(5)), whiteView, 22);
  for (let i = 0; i < 18; i++) {
    const pos = place(randRange(rng, 24, ARENA_R - 6), rng() * Math.PI * 2, 6);
    const s = randRange(rng, 1.0, 2.6);
    mat4.identity(m);
    mat4.translate(m, [pos.x, 0, pos.z], m);
    mat4.rotateY(m, rng() * Math.PI * 2, m);
    mat4.uniformScale(m, s, m);
    writeInstance(rocks.raw, i, m, 0.3, 0.3, 0.34, 0, 0, 0, 0, 0);
    if (s > 1.4) obstacles.push({ x: pos.x, z: pos.z, r: s * 0.55 });
  }
  rocks.count = 18;
  rocks.dirty = true;
  renderer.staticBatches.push(rocks);

  // --- cristales emisivos ---
  const crys = renderer.statics.createBatch(gfx.uploadMesh(crystalMesh(9)), whiteView, 12, false);
  for (let i = 0; i < 9; i++) {
    const pos = place(randRange(rng, 20, ARENA_R - 8), rng() * Math.PI * 2 + 0.4, 8);
    const s = randRange(rng, 1.6, 3.0);
    mat4.identity(m);
    mat4.translate(m, [pos.x, 0, pos.z], m);
    mat4.rotateY(m, rng() * Math.PI * 2, m);
    mat4.uniformScale(m, s, m);
    const cool = rng() > 0.4;
    writeInstance(crys.raw, i, m,
      cool ? 0.35 : 1.0, cool ? 0.9 : 0.5, cool ? 1.0 : 0.9, 0,
      0, 0, 1.7, 0);
    crystals.push(pos);
    obstacles.push({ x: pos.x, z: pos.z, r: s * 0.3 });
  }
  crys.count = 9;
  crys.dirty = true;
  renderer.staticBatches.push(crys);

  // --- tocones ---
  const stumps = renderer.statics.createBatch(gfx.uploadMesh(stumpMesh(4)), whiteView, 8);
  for (let i = 0; i < 6; i++) {
    const pos = place(randRange(rng, 34, ARENA_R - 10), rng() * Math.PI * 2 + 1.9, 6);
    const s = randRange(rng, 1.0, 1.7);
    mat4.identity(m);
    mat4.translate(m, [pos.x, 0, pos.z], m);
    mat4.rotateY(m, rng() * Math.PI * 2, m);
    mat4.uniformScale(m, s, m);
    writeInstance(stumps.raw, i, m, 0.4, 0.3, 0.22, 0, 0, 0, 0, 0);
    obstacles.push({ x: pos.x, z: pos.z, r: s * 0.5 });
  }
  stumps.count = 6;
  stumps.dirty = true;
  renderer.staticBatches.push(stumps);

  return {
    obstacles,
    crystals,
    collide(p, radius) {
      // borde de la arena
      const dist = Math.hypot(p.x, p.z);
      const maxR = ARENA_R - 0.8 - radius;
      if (dist > maxR) {
        const s = maxR / dist;
        p.x *= s;
        p.z *= s;
      }
      // obstáculos
      for (const o of obstacles) {
        const dx = p.x - o.x;
        const dz = p.z - o.z;
        const rr = o.r + radius;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr && d2 > 1e-6) {
          const dd = Math.sqrt(d2);
          const push = (rr - dd) / dd;
          p.x += dx * push;
          p.z += dz * push;
        }
      }
    },
  };
}

