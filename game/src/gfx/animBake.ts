/**
 * Bake de animaciones esqueléticas: muestrea cada clip a 30 Hz y produce
 * matrices de skinning (world × invBind) por (frame, hueso), listas para
 * subirse a un storage buffer y consumirse desde el compute shader de paletas.
 */
import { mat4, quat, vec3 } from 'wgpu-matrix';
import type { GlbClip, GlbModel } from './glb';

export const BAKE_FPS = 30;

export interface BakedClip {
  base: number;   // frame inicial dentro del buffer
  count: number;  // nº de frames
  duration: number;
  loop: boolean;
}

export interface BakedCharacter {
  boneCount: number;
  frames: Float32Array; // totalFrames × boneCount × 16
  clips: Record<string, BakedClip>;
  binds: Float32Array;  // inversa de invBind por hueso (para recuperar world)
  jointName: string[];
  handJoint: number;    // índice de hueso de la mano derecha (para trails)
  handParent: number;   // antebrazo: da la dirección del arma
  rootJoint: number;
}

const LOOPING = new Set(['walk', 'run', 'idle']);

function sampleChannel(times: Float32Array, values: Float32Array, comps: number, t: number, out: Float32Array): void {
  const n = times.length;
  if (n === 1 || t <= times[0]) {
    for (let c = 0; c < comps; c++) out[c] = values[c];
    return;
  }
  if (t >= times[n - 1]) {
    const b = (n - 1) * comps;
    for (let c = 0; c < comps; c++) out[c] = values[b + c];
    return;
  }
  let i = 1;
  while (times[i] < t) i++;
  const t0 = times[i - 1];
  const t1 = times[i];
  const f = (t - t0) / (t1 - t0 || 1);
  const a = (i - 1) * comps;
  const b = i * comps;
  if (comps === 4) {
    // nlerp de cuaterniones (suficiente para keyframes densos)
    let dot = 0;
    for (let c = 0; c < 4; c++) dot += values[a + c] * values[b + c];
    const sgn = dot < 0 ? -1 : 1;
    let len = 0;
    for (let c = 0; c < 4; c++) {
      out[c] = values[a + c] * (1 - f) + values[b + c] * f * sgn;
      len += out[c] * out[c];
    }
    len = Math.sqrt(len) || 1;
    for (let c = 0; c < 4; c++) out[c] /= len;
  } else {
    for (let c = 0; c < comps; c++) out[c] = values[a + c] * (1 - f) + values[b + c] * f;
  }
}

export function bakeCharacter(model: GlbModel): BakedCharacter {
  const skin = model.skin!;
  const nodes = model.nodes;
  const J = skin.joints.length;
  const N = nodes.length;
  const jointSet = new Set(skin.joints);

  // huesos de interés
  const jointName = skin.joints.map((n) => nodes[n].name);
  const findJoint = (pat: RegExp) => jointName.findIndex((n) => pat.test(n));
  let handJoint = findJoint(/right.*hand|hand.*r\b|RightHand/i);
  if (handJoint < 0) handJoint = findJoint(/hand/i);
  if (handJoint < 0) handJoint = 0;
  const handParentNode = nodes[skin.joints[handJoint]].parent;
  let handParent = skin.joints.indexOf(handParentNode);
  if (handParent < 0) handParent = handJoint;
  let rootJoint = skin.joints.findIndex((n) => nodes[n].parent < 0 || !jointSet.has(nodes[n].parent));
  if (rootJoint < 0) rootJoint = 0;
  const rootNode = skin.joints[rootJoint];

  // orden de clips estable
  const clipList = [...model.clips].sort((a, b) => a.name.localeCompare(b.name));
  let totalFrames = 0;
  for (const clip of clipList) totalFrames += Math.max(2, Math.ceil(clip.duration * BAKE_FPS) + 1);

  const frames = new Float32Array(totalFrames * J * 16);
  const clips: Record<string, BakedClip> = {};

  // buffers de trabajo
  const local = new Float32Array(N * 16);
  const world = new Float32Array(N * 16);
  const t3 = new Float32Array(3);
  const r4 = new Float32Array(4);
  const s3 = new Float32Array(3);
  const tmp = new Float32Array(16);

  let base = 0;
  for (const clip of clipList) {
    const count = Math.max(2, Math.ceil(clip.duration * BAKE_FPS) + 1);
    const loop = LOOPING.has(clip.name);
    clips[clip.name] = { base, count, duration: clip.duration, loop };

    // canales por nodo
    const byNode = new Map<number, GlbClip['channels']>();
    for (const ch of clip.channels) {
      let arr = byNode.get(ch.node);
      if (!arr) byNode.set(ch.node, (arr = []));
      arr.push(ch);
    }
    // valor de anclaje para eliminar el desplazamiento raíz XZ en clips de locomoción
    let rootAnchorX = 0;
    let rootAnchorZ = 0;
    const rootTrans = byNode.get(rootNode)?.find((c) => c.path === 'translation');
    if (loop && rootTrans) {
      rootAnchorX = rootTrans.values[0];
      rootAnchorZ = rootTrans.values[2];
    }

    for (let f = 0; f < count; f++) {
      const t = Math.min(f / BAKE_FPS, clip.duration);
      // locales
      for (let n = 0; n < N; n++) {
        const node = nodes[n];
        t3.set(node.t); r4.set(node.r); s3.set(node.s);
        const chs = byNode.get(n);
        if (chs) {
          for (const ch of chs) {
            if (ch.path === 'translation') sampleChannel(ch.times, ch.values, 3, t, t3);
            else if (ch.path === 'rotation') sampleChannel(ch.times, ch.values, 4, t, r4);
            else sampleChannel(ch.times, ch.values, 3, t, s3);
          }
        }
        if (loop && n === rootNode) {
          // fija el XZ de la raíz (clips in-place)
          t3[0] = rootAnchorX;
          t3[2] = rootAnchorZ;
        }
        const m = local.subarray(n * 16, n * 16 + 16);
        mat4.fromQuat(r4, m);
        m[12] = t3[0]; m[13] = t3[1]; m[14] = t3[2];
        mat4.scale(m, s3, m);
      }
      // mundo (los padres siempre tienen índice menor en los exports de Meshy;
      // por seguridad resolvemos con múltiples pasadas si hiciera falta)
      for (let n = 0; n < N; n++) {
        const p = nodes[n].parent;
        const w = world.subarray(n * 16, n * 16 + 16);
        if (p < 0) {
          w.set(local.subarray(n * 16, n * 16 + 16));
        } else {
          mat4.multiply(world.subarray(p * 16, p * 16 + 16), local.subarray(n * 16, n * 16 + 16), w);
        }
      }
      // skinning: world × invBind
      const frameBase = (base + f) * J * 16;
      for (let j = 0; j < J; j++) {
        const nodeIdx = skin.joints[j];
        mat4.multiply(
          world.subarray(nodeIdx * 16, nodeIdx * 16 + 16),
          skin.invBind.subarray(j * 16, j * 16 + 16),
          tmp,
        );
        frames.set(tmp, frameBase + j * 16);
      }
    }
    base += count;
  }

  // binds = inversa de invBind (para recuperar matrices de mundo de huesos en CPU)
  const binds = new Float32Array(J * 16);
  for (let j = 0; j < J; j++) {
    mat4.invert(skin.invBind.subarray(j * 16, j * 16 + 16), binds.subarray(j * 16, j * 16 + 16));
  }

  return { boneCount: J, frames, clips, binds, jointName, handJoint, handParent, rootJoint };
}

/**
 * Analiza el clip de ataque y localiza el swing real del arma: el tramo
 * donde la mano se mueve más rápido. Devuelve la ventana [start, end] y el
 * momento del impacto (pico de velocidad) como fracciones 0..1 del clip.
 * Así cada personaje reproduce exactamente su golpe, no la anticipación.
 */
export function analyzeSwing(baked: BakedCharacter, clipName: string): { start: number; end: number; hitFrac: number } {
  const clip = baked.clips[clipName];
  if (!clip || clip.count < 6) return { start: 0.15, end: 0.7, hitFrac: 0.5 };
  const J = baked.boneCount;
  const j = baked.handJoint;
  const bind = baked.binds.subarray(j * 16, j * 16 + 16);
  // posición de mundo de la mano por frame: (skinMat × bind) → traslación
  const px = new Float32Array(clip.count);
  const py = new Float32Array(clip.count);
  const pz = new Float32Array(clip.count);
  const m = new Float32Array(16);
  for (let f = 0; f < clip.count; f++) {
    const base = (clip.base + f) * J * 16 + j * 16;
    mat4.multiply(baked.frames.subarray(base, base + 16), bind, m);
    px[f] = m[12]; py[f] = m[13]; pz[f] = m[14];
  }
  const speed = new Float32Array(clip.count);
  let peakF = 1;
  for (let f = 1; f < clip.count; f++) {
    speed[f] = Math.hypot(px[f] - px[f - 1], py[f] - py[f - 1], pz[f] - pz[f - 1]);
    // ignora el arranque y el final del clip
    if (f > clip.count * 0.12 && f < clip.count * 0.92 && speed[f] > speed[peakF]) peakF = f;
  }
  const threshold = speed[peakF] * 0.22;
  let startF = peakF;
  while (startF > 1 && speed[startF - 1] > threshold) startF--;
  let endF = peakF;
  while (endF < clip.count - 1 && speed[endF + 1] > threshold) endF++;
  // padding y anchura mínima
  startF = Math.max(0, startF - Math.ceil(clip.count * 0.06));
  endF = Math.min(clip.count - 1, endF + Math.ceil(clip.count * 0.08));
  const minW = clip.count * 0.22;
  if (endF - startF < minW) {
    const c = (startF + endF) / 2;
    startF = Math.max(0, Math.round(c - minW / 2));
    endF = Math.min(clip.count - 1, Math.round(c + minW / 2));
  }
  const start = startF / (clip.count - 1);
  const end = endF / (clip.count - 1);
  const hitFrac = Math.min(0.68, Math.max(0.32, (peakF - startF) / Math.max(endF - startF, 1)));
  return { start, end, hitFrac };
}

const _m0 = new Float32Array(16);
const _m1 = new Float32Array(16);

/**
 * Matriz de MUNDO (espacio del modelo) de un hueso en el instante t de un clip.
 * Se usa en CPU para anclar trails de armas a la mano.
 */
export function sampleBoneWorld(baked: BakedCharacter, clipName: string, t: number, joint: number, out: Float32Array): void {
  const clip = baked.clips[clipName];
  if (!clip) { mat4.identity(out); return; }
  const J = baked.boneCount;
  let ft = (t / clip.duration) * (clip.count - 1);
  if (clip.loop) ft = ((ft % (clip.count - 1)) + (clip.count - 1)) % (clip.count - 1);
  else ft = Math.min(Math.max(ft, 0), clip.count - 1);
  const f0 = Math.floor(ft);
  const f1 = Math.min(f0 + 1, clip.count - 1);
  const fr = ft - f0;
  const a = (clip.base + f0) * J * 16 + joint * 16;
  const b = (clip.base + f1) * J * 16 + joint * 16;
  for (let i = 0; i < 16; i++) _m0[i] = baked.frames[a + i] * (1 - fr) + baked.frames[b + i] * fr;
  // world = skinMat × bind
  mat4.multiply(_m0, baked.binds.subarray(joint * 16, joint * 16 + 16), out);
}
