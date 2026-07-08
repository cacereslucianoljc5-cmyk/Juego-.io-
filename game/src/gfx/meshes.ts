/** Geometría procedural: rocas, pilares, cristales, muro, quads. Formato: [pos3, nrm3, uv2]. */
import { makeRng } from '../core/mathx';

export interface MeshData {
  verts: Float32Array; // stride 8: pos(3) nrm(3) uv(2)
  indices: Uint32Array;
}

class Builder {
  v: number[] = [];
  i: number[] = [];
  vert(px: number, py: number, pz: number, nx: number, ny: number, nz: number, u = 0, vv = 0): number {
    this.v.push(px, py, pz, nx, ny, nz, u, vv);
    return this.v.length / 8 - 1;
  }
  tri(a: number, b: number, c: number): void { this.i.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number): void { this.i.push(a, b, c, a, c, d); }
  build(): MeshData {
    return { verts: new Float32Array(this.v), indices: new Uint32Array(this.i) };
  }
  /** Recalcula normales planas (facetado estilizado). */
  flatShade(): void {
    const src = this.v;
    const idx = this.i;
    const nv: number[] = [];
    const ni: number[] = [];
    for (let t = 0; t < idx.length; t += 3) {
      const pa = idx[t] * 8; const pb = idx[t + 1] * 8; const pc = idx[t + 2] * 8;
      const ax = src[pa]; const ay = src[pa + 1]; const az = src[pa + 2];
      const bx = src[pb]; const by = src[pb + 1]; const bz = src[pb + 2];
      const cx = src[pc]; const cy = src[pc + 1]; const cz = src[pc + 2];
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (const p of [pa, pb, pc]) {
        nv.push(src[p], src[p + 1], src[p + 2], nx, ny, nz, src[p + 6], src[p + 7]);
        ni.push(nv.length / 8 - 1);
      }
    }
    this.v = nv;
    this.i = ni;
  }
}

/** Roca low-poly: icosaedro subdividido y deformado. */
export function rockMesh(seed: number): MeshData {
  const rng = makeRng(seed);
  const b = new Builder();
  const t = (1 + Math.sqrt(5)) / 2;
  const pts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const deformed = pts.map((p) => {
    const l = Math.hypot(p[0], p[1], p[2]);
    const r = (0.75 + rng() * 0.5) / l;
    return [p[0] * r, Math.abs(p[1] * r) * 0.75 + 0.08, p[2] * r * (0.85 + rng() * 0.3)];
  });
  const vi = deformed.map((p) => b.vert(p[0], p[1], p[2], 0, 1, 0, 0.5, 0.5));
  for (const f of faces) b.tri(vi[f[0]], vi[f[1]], vi[f[2]]);
  b.flatShade();
  return b.build();
}

/** Pilar octogonal roto (ruina). */
export function pillarMesh(seed: number): MeshData {
  const rng = makeRng(seed);
  const b = new Builder();
  const sides = 8;
  const h = 1;
  const rings = [0, 0.15, 0.85, 1];
  const radii = [0.5, 0.42, 0.4, 0.44];
  const ringVerts: number[][] = [];
  for (let ri = 0; ri < rings.length; ri++) {
    const ring: number[] = [];
    const jag = ri === rings.length - 1;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const r = radii[ri] * (0.95 + rng() * 0.1);
      const y = rings[ri] * h * (jag ? 0.85 + rng() * 0.3 : 1);
      ring.push(b.vert(Math.cos(a) * r, y, Math.sin(a) * r, Math.cos(a), 0, Math.sin(a), s / sides, rings[ri]));
    }
    ringVerts.push(ring);
  }
  for (let ri = 0; ri < ringVerts.length - 1; ri++) {
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides;
      b.quad(ringVerts[ri][s], ringVerts[ri][s1], ringVerts[ri + 1][s1], ringVerts[ri + 1][s]);
    }
  }
  // tapa
  const top = ringVerts[ringVerts.length - 1];
  const c = b.vert(0, h, 0, 0, 1, 0, 0.5, 0.5);
  for (let s = 0; s < sides; s++) b.tri(top[s], c, top[(s + 1) % sides]);
  b.flatShade();
  return b.build();
}

/** Cristal emisivo: bipirámide alargada. */
export function crystalMesh(seed: number): MeshData {
  const rng = makeRng(seed);
  const b = new Builder();
  const sides = 5;
  const r = 0.32;
  const hMid = 0.55 + rng() * 0.25;
  const hTop = 1;
  const ring: number[] = [];
  for (let s = 0; s < sides; s++) {
    const a = (s / sides) * Math.PI * 2 + rng() * 0.2;
    ring.push(b.vert(Math.cos(a) * r * (0.85 + rng() * 0.3), hMid, Math.sin(a) * r, Math.cos(a), 0, Math.sin(a), 0.5, 0.5));
  }
  const bot = b.vert(0, 0, 0, 0, -1, 0, 0.5, 0.5);
  const top = b.vert(rng() * 0.1 - 0.05, hTop, rng() * 0.1 - 0.05, 0, 1, 0, 0.5, 0.5);
  for (let s = 0; s < sides; s++) {
    const s1 = (s + 1) % sides;
    b.tri(bot, ring[s1], ring[s]);
    b.tri(top, ring[s], ring[s1]);
  }
  b.flatShade();
  return b.build();
}

/** Tocón/tronco seco decorativo. */
export function stumpMesh(seed: number): MeshData {
  const rng = makeRng(seed);
  const b = new Builder();
  const sides = 7;
  const ring0: number[] = [];
  const ring1: number[] = [];
  for (let s = 0; s < sides; s++) {
    const a = (s / sides) * Math.PI * 2;
    const r0 = 0.5 * (0.9 + rng() * 0.25);
    const r1 = 0.34 * (0.9 + rng() * 0.2);
    ring0.push(b.vert(Math.cos(a) * r0, 0, Math.sin(a) * r0, Math.cos(a), 0, Math.sin(a), 0, 0));
    ring1.push(b.vert(Math.cos(a) * r1, 0.8 + rng() * 0.4, Math.sin(a) * r1, Math.cos(a), 0, Math.sin(a), 0, 1));
  }
  for (let s = 0; s < sides; s++) {
    const s1 = (s + 1) % sides;
    b.quad(ring0[s], ring0[s1], ring1[s1], ring1[s]);
  }
  const c = b.vert(0, 0.9, 0, 0, 1, 0, 0.5, 0.5);
  for (let s = 0; s < sides; s++) b.tri(ring1[s], c, ring1[(s + 1) % sides]);
  b.flatShade();
  return b.build();
}

/** Cáscara cilíndrica para el muro de energía del borde (sin tapas, doble cara vía cull none). */
export function wallMesh(segments = 96, height = 1): MeshData {
  const b = new Builder();
  const rows = 2;
  const ringA: number[] = [];
  const ringB: number[] = [];
  for (let s = 0; s <= segments; s++) {
    const a = (s / segments) * Math.PI * 2;
    const cx = Math.cos(a);
    const sz = Math.sin(a);
    ringA.push(b.vert(cx, 0, sz, -cx, 0, -sz, s / segments * 24, 0));
    ringB.push(b.vert(cx, height, sz, -cx, 0, -sz, s / segments * 24, 1));
  }
  for (let s = 0; s < segments; s++) {
    b.quad(ringA[s], ringA[s + 1], ringB[s + 1], ringB[s]);
  }
  return b.build();
}

/** Plano de suelo gigante (un quad; el fragment shader hace el resto). */
export function groundMesh(half = 220): MeshData {
  const b = new Builder();
  const a = b.vert(-half, 0, -half, 0, 1, 0, 0, 0);
  const b2 = b.vert(half, 0, -half, 0, 1, 0, 1, 0);
  const c = b.vert(half, 0, half, 0, 1, 0, 1, 1);
  const d = b.vert(-half, 0, half, 0, 1, 0, 0, 1);
  b.quad(a, b2, c, d);
  return b.build();
}
