/**
 * Loader GLB mínimo y autocontenido para los assets del juego.
 * Soporta: mallas (multi-primitiva), KHR_mesh_quantization (dequantiza a f32),
 * EXT_texture_webp, skins, animaciones TRS, materiales baseColor.
 */
import { mat4 } from 'wgpu-matrix';

export interface GlbPrimitive {
  positions: Float32Array; // ya transformadas por la matriz de mundo del nodo (modelos estáticos)
  normals: Float32Array;
  uvs: Float32Array;
  joints: Uint8Array | null;   // 4 por vértice
  weights: Float32Array | null; // 4 por vértice
  indices: Uint32Array;
  materialIdx: number;
}

export interface GlbMaterial {
  baseColorFactor: [number, number, number, number];
  image: ImageBitmap | null;
}

export interface GlbNodeTRS {
  parent: number;
  t: Float32Array; // vec3
  r: Float32Array; // quat
  s: Float32Array; // vec3
  name: string;
}

export interface GlbChannel {
  node: number;
  path: 'translation' | 'rotation' | 'scale';
  times: Float32Array;
  values: Float32Array;
}

export interface GlbClip {
  name: string;
  duration: number;
  channels: GlbChannel[];
}

export interface GlbSkin {
  joints: number[]; // índices de nodo
  invBind: Float32Array; // 16 * joints
}

export interface GlbModel {
  primitives: GlbPrimitive[];
  materials: GlbMaterial[];
  nodes: GlbNodeTRS[];
  skin: GlbSkin | null;
  clips: GlbClip[];
  bboxMin: Float32Array;
  bboxMax: Float32Array;
}

const COMP_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

interface Gltf {
  accessors: any[]; bufferViews: any[]; meshes: any[]; nodes: any[];
  skins?: any[]; animations?: any[]; materials?: any[]; textures?: any[];
  images?: any[]; scenes: any[]; scene?: number;
}

function readAccessor(gltf: Gltf, bin: DataView, idx: number): Float32Array {
  const acc = gltf.accessors[idx];
  const nComp = TYPE_COUNT[acc.type];
  const n = acc.count * nComp;
  const out = new Float32Array(n);
  if (acc.bufferView === undefined) return out;
  const bv = gltf.bufferViews[acc.bufferView];
  const compSize = COMP_SIZE[acc.componentType];
  const stride = bv.byteStride ?? compSize * nComp;
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const norm = !!acc.normalized;
  const ct = acc.componentType;
  for (let i = 0; i < acc.count; i++) {
    let off = base + i * stride;
    for (let c = 0; c < nComp; c++) {
      let v: number;
      switch (ct) {
        case 5126: v = bin.getFloat32(off, true); break;
        case 5123: v = bin.getUint16(off, true); if (norm) v /= 65535; break;
        case 5122: v = bin.getInt16(off, true); if (norm) v = Math.max(v / 32767, -1); break;
        case 5121: v = bin.getUint8(off); if (norm) v /= 255; break;
        case 5120: v = bin.getInt8(off); if (norm) v = Math.max(v / 127, -1); break;
        case 5125: v = bin.getUint32(off, true); break;
        default: v = 0;
      }
      out[i * nComp + c] = v;
      off += compSize;
    }
  }
  return out;
}

function readIndices(gltf: Gltf, bin: DataView, idx: number): Uint32Array {
  const acc = gltf.accessors[idx];
  const bv = gltf.bufferViews[acc.bufferView];
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const out = new Uint32Array(acc.count);
  const ct = acc.componentType;
  const compSize = COMP_SIZE[ct];
  const stride = bv.byteStride ?? compSize;
  for (let i = 0; i < acc.count; i++) {
    const off = base + i * stride;
    out[i] = ct === 5125 ? bin.getUint32(off, true) : ct === 5123 ? bin.getUint16(off, true) : bin.getUint8(off);
  }
  return out;
}

/** Matrices de mundo de todos los nodos (jerarquía TRS o matrix). */
function worldMatrices(gltf: Gltf): Float32Array[] {
  const n = gltf.nodes.length;
  const local: Float32Array[] = new Array(n);
  const world: Float32Array[] = new Array(n);
  const parent = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const node = gltf.nodes[i];
    for (const c of node.children ?? []) parent[c] = i;
    const m = new Float32Array(16);
    if (node.matrix) {
      m.set(node.matrix);
    } else {
      const t = node.translation ?? [0, 0, 0];
      const r = node.rotation ?? [0, 0, 0, 1];
      const s = node.scale ?? [1, 1, 1];
      mat4.fromQuat(r, m);
      m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
      mat4.scale(m, s, m);
    }
    local[i] = m;
  }
  const resolve = (i: number): Float32Array => {
    if (world[i]) return world[i];
    world[i] = parent[i] >= 0 ? mat4.multiply(resolve(parent[i]), local[i]) as Float32Array : local[i];
    return world[i];
  };
  for (let i = 0; i < n; i++) resolve(i);
  return world;
}

export async function loadGlb(url: string): Promise<GlbModel> {
  const buf = await (await fetch(url)).arrayBuffer();
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error(`GLB inválido: ${url}`);
  const jsonLen = dv.getUint32(12, true);
  const gltf: Gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const binOff = 20 + jsonLen + 8;
  const bin = new DataView(buf, binOff);

  // imágenes → ImageBitmap
  const materials: GlbMaterial[] = [];
  const imageCache = new Map<number, Promise<ImageBitmap>>();
  const getImage = (imgIdx: number): Promise<ImageBitmap> => {
    let p = imageCache.get(imgIdx);
    if (!p) {
      const img = gltf.images![imgIdx];
      const bv = gltf.bufferViews[img.bufferView];
      const bytes = new Uint8Array(buf, binOff + (bv.byteOffset ?? 0), bv.byteLength);
      p = createImageBitmap(new Blob([bytes.slice()], { type: img.mimeType }), { colorSpaceConversion: 'none' });
      imageCache.set(imgIdx, p);
    }
    return p;
  };
  for (const mat of gltf.materials ?? [{}]) {
    const pbr = mat.pbrMetallicRoughness ?? {};
    const texIdx = pbr.baseColorTexture?.index;
    let image: ImageBitmap | null = null;
    if (texIdx !== undefined) {
      const tex = gltf.textures![texIdx];
      const src = tex.extensions?.EXT_texture_webp?.source ?? tex.source;
      if (src !== undefined) image = await getImage(src);
    }
    materials.push({ baseColorFactor: (pbr.baseColorFactor ?? [1, 1, 1, 1]) as [number, number, number, number], image });
  }

  const world = worldMatrices(gltf);
  const skinned = (gltf.skins?.length ?? 0) > 0;

  // primitivas: para modelos estáticos, hornea la matriz de mundo del nodo
  const primitives: GlbPrimitive[] = [];
  const bboxMin = new Float32Array([Infinity, Infinity, Infinity]);
  const bboxMax = new Float32Array([-Infinity, -Infinity, -Infinity]);
  const tmp = new Float32Array(3);
  for (let ni = 0; ni < gltf.nodes.length; ni++) {
    const node = gltf.nodes[ni];
    if (node.mesh === undefined) continue;
    const mesh = gltf.meshes[node.mesh];
    const isSkinnedNode = node.skin !== undefined;
    const m = world[ni];
    for (const prim of mesh.primitives) {
      if (prim.mode !== undefined && prim.mode !== 4) continue;
      const positions = readAccessor(gltf, bin, prim.attributes.POSITION);
      const normals = prim.attributes.NORMAL !== undefined
        ? readAccessor(gltf, bin, prim.attributes.NORMAL)
        : new Float32Array(positions.length);
      const uvs = prim.attributes.TEXCOORD_0 !== undefined
        ? readAccessor(gltf, bin, prim.attributes.TEXCOORD_0)
        : new Float32Array((positions.length / 3) * 2);
      let joints: Uint8Array | null = null;
      let weights: Float32Array | null = null;
      if (isSkinnedNode && prim.attributes.JOINTS_0 !== undefined) {
        const j = readAccessor(gltf, bin, prim.attributes.JOINTS_0);
        joints = new Uint8Array(j.length);
        for (let i = 0; i < j.length; i++) joints[i] = j[i];
        weights = readAccessor(gltf, bin, prim.attributes.WEIGHTS_0);
        // normaliza pesos
        for (let i = 0; i < weights.length; i += 4) {
          const s = weights[i] + weights[i + 1] + weights[i + 2] + weights[i + 3] || 1;
          weights[i] /= s; weights[i + 1] /= s; weights[i + 2] /= s; weights[i + 3] /= s;
        }
      } else {
        // hornea transformación del nodo en los vértices (modelos estáticos)
        const nrm = mat4.clone(m);
        nrm[12] = 0; nrm[13] = 0; nrm[14] = 0;
        for (let i = 0; i < positions.length; i += 3) {
          tmp[0] = positions[i]; tmp[1] = positions[i + 1]; tmp[2] = positions[i + 2];
          const x = m[0] * tmp[0] + m[4] * tmp[1] + m[8] * tmp[2] + m[12];
          const y = m[1] * tmp[0] + m[5] * tmp[1] + m[9] * tmp[2] + m[13];
          const z = m[2] * tmp[0] + m[6] * tmp[1] + m[10] * tmp[2] + m[14];
          positions[i] = x; positions[i + 1] = y; positions[i + 2] = z;
          const nx = normals[i]; const ny = normals[i + 1]; const nz = normals[i + 2];
          normals[i] = nrm[0] * nx + nrm[4] * ny + nrm[8] * nz;
          normals[i + 1] = nrm[1] * nx + nrm[5] * ny + nrm[9] * nz;
          normals[i + 2] = nrm[2] * nx + nrm[6] * ny + nrm[10] * nz;
        }
      }
      for (let i = 0; i < positions.length; i += 3) {
        for (let c = 0; c < 3; c++) {
          const v = positions[i + c];
          if (v < bboxMin[c]) bboxMin[c] = v;
          if (v > bboxMax[c]) bboxMax[c] = v;
        }
      }
      const indices = prim.indices !== undefined
        ? readIndices(gltf, bin, prim.indices)
        : new Uint32Array([...Array(positions.length / 3).keys()]);
      primitives.push({ positions, normals, uvs, joints, weights, indices, materialIdx: prim.material ?? 0 });
    }
  }

  // nodos TRS (para bake de animación)
  const nodes: GlbNodeTRS[] = gltf.nodes.map((n: any) => ({
    parent: -1,
    t: new Float32Array(n.translation ?? [0, 0, 0]),
    r: new Float32Array(n.rotation ?? [0, 0, 0, 1]),
    s: new Float32Array(n.scale ?? [1, 1, 1]),
    name: n.name ?? '',
  }));
  gltf.nodes.forEach((n: any, i: number) => {
    for (const c of n.children ?? []) nodes[c].parent = i;
  });

  let skin: GlbSkin | null = null;
  if (skinned) {
    const s = gltf.skins![0];
    skin = { joints: s.joints, invBind: readAccessor(gltf, bin, s.inverseBindMatrices) };
  }

  const clips: GlbClip[] = (gltf.animations ?? []).map((anim: any) => {
    let duration = 0;
    const channels: GlbChannel[] = [];
    for (const ch of anim.channels) {
      const sampler = anim.samplers[ch.sampler];
      const times = readAccessor(gltf, bin, sampler.input);
      const values = readAccessor(gltf, bin, sampler.output);
      if (times.length) duration = Math.max(duration, times[times.length - 1]);
      channels.push({ node: ch.target.node, path: ch.target.path, times, values });
    }
    return { name: anim.name ?? 'clip', duration, channels };
  });

  return { primitives, materials, nodes, skin, clips, bboxMin, bboxMax };
}
