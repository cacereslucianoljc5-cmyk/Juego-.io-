/**
 * Personajes skinned instanciados con animación 100% en GPU:
 *  - clips bakeados (30 Hz) como matrices de skinning en un storage buffer
 *  - compute shader que mezcla dos clips por instancia → paleta de huesos
 *  - vertex shader que aplica la paleta (4 influencias por vértice)
 * Variantes: principal (HDR), depth-only (sombra) y fantasma aditivo (dash).
 */
import tgpu, { d, std } from 'typegpu';
import {
  DEPTH_FORMAT, HDR_FORMAT, InstanceStruct, SHADOW_FORMAT, skinVertexLayout,
} from './gpu';
import type { Gfx, GpuMesh } from './gpu';
import type { Shading } from './shading';
import type { BakedCharacter } from './animBake';

export const AnimState = d.struct({
  clipsAB: d.vec4u,    // clipA, clipB, -, -
  timesBlend: d.vec4f, // tA, tB, blend, -
});

const TypeInfo = d.struct({ counts: d.vec4u }); // boneCount, instanceCount, -, -

export const paletteLayout = tgpu.bindGroupLayout({
  baked: { storage: d.arrayOf(d.mat4x4f) },
  clipTable: { storage: d.arrayOf(d.vec4u) },
  states: { storage: d.arrayOf(AnimState) },
  info: { uniform: TypeInfo },
  palette: { storage: d.arrayOf(d.mat4x4f), access: 'mutable' },
});

export const skinnedObjLayout = tgpu.bindGroupLayout({
  instances: { storage: d.arrayOf(InstanceStruct) },
  palette: { storage: d.arrayOf(d.mat4x4f) },
  info: { uniform: TypeInfo },
  albedo: { texture: d.texture2d(d.f32) },
});

export interface SkinnedType {
  mesh: GpuMesh;
  boneCount: number;
  capacity: number;
  count: number;
  ghostCount: number; // instancias extra al final del buffer, dibujadas en pase fantasma
  raw: Float32Array;
  statesBytes: ArrayBuffer;
  statesU32: Uint32Array;
  statesF32: Float32Array;
  instanceBuffer: any;
  statesBuffer: any;
  infoBuffer: any;
  paletteBG: any;
  renderBG: any;
  clipIndex: Record<string, number>;
}

export interface SkinnedPipelines {
  createType(mesh: GpuMesh, baked: BakedCharacter, albedoView: any, capacity: number): SkinnedType;
  upload(t: SkinnedType): void;
  computePalettes(encoder: GPUCommandEncoder, types: SkinnedType[]): void;
  drawMain(pass: GPURenderPassEncoder, types: SkinnedType[]): void;
  drawShadow(pass: GPURenderPassEncoder, types: SkinnedType[]): void;
  drawGhosts(pass: GPURenderPassEncoder, types: SkinnedType[]): void;
}

export function createSkinnedPipelines(gfx: Gfx, shading: Shading): SkinnedPipelines {
  const scene = gfx.scene;
  const samp = gfx.linearSampler;

  // ---- compute de paletas: (x=hueso, y=instancia) ----
  const sampleClip = (clipIdx: number, time: number, bone: number, boneCount: number): d.m4x4f => {
    'use gpu';
    const clip = paletteLayout.$.clipTable[clipIdx];
    const maxF = clip.y - 1;
    const ft = std.clamp(time * 30.0, 0, d.f32(maxF));
    const f0 = d.u32(std.floor(ft));
    let f1 = f0 + 1;
    if (f1 > maxF) {
      f1 = std.select(maxF, d.u32(0), clip.z === 1);
    }
    const fr = ft - std.floor(ft);
    const a = paletteLayout.$.baked[(clip.x + f0) * boneCount + bone];
    const b = paletteLayout.$.baked[(clip.x + f1) * boneCount + bone];
    return a * (1 - fr) + b * fr;
  };

  const paletteCompute = tgpu.computeFn({
    workgroupSize: [4, 16],
    in: { gid: d.builtin.globalInvocationId },
  })((input) => {
    'use gpu';
    const bone = input.gid.x;
    const inst = input.gid.y;
    const bc = paletteLayout.$.info.counts.x;
    if (bone >= bc || inst >= paletteLayout.$.info.counts.y) {
      return;
    }
    const st = paletteLayout.$.states[inst];
    const mA = sampleClip(st.clipsAB.x, st.timesBlend.x, bone, bc);
    const blend = st.timesBlend.z;
    if (blend > 0.001) {
      const mB = sampleClip(st.clipsAB.y, st.timesBlend.y, bone, bc);
      paletteLayout.$.palette[inst * bc + bone] = mA * (1 - blend) + mB * blend;
    } else {
      // (× 1 produce un valor efímero asignable, evita la regla de referencias)
      paletteLayout.$.palette[inst * bc + bone] = mA * 1;
    }
  });

  const palettePipeline = gfx.root.createComputePipeline({ compute: paletteCompute });

  // ---- vertex compartido (skinning) ----
  const skinVert = tgpu.vertexFn({
    in: {
      pos: d.vec3f, nrm: d.vec3f, uv: d.vec2f, joints: d.vec4u, weights: d.vec4f,
      iid: d.builtin.instanceIndex,
    },
    out: {
      position: d.builtin.position,
      wpos: d.vec3f, nrm: d.vec3f, uv: d.vec2f,
      lpos: d.vec3f, tint: d.vec4f, fx: d.vec4f,
    },
  })((input) => {
    'use gpu';
    const bc = skinnedObjLayout.$.info.counts.x;
    const base = input.iid * bc;
    const m0 = skinnedObjLayout.$.palette[base + input.joints.x];
    const m1 = skinnedObjLayout.$.palette[base + input.joints.y];
    const m2 = skinnedObjLayout.$.palette[base + input.joints.z];
    const m3 = skinnedObjLayout.$.palette[base + input.joints.w];
    const p4 = d.vec4f(input.pos, 1);
    const n4 = d.vec4f(input.nrm, 0);
    const skinnedPos = std.mul(m0, p4) * input.weights.x + std.mul(m1, p4) * input.weights.y
      + std.mul(m2, p4) * input.weights.z + std.mul(m3, p4) * input.weights.w;
    const skinnedNrm = std.mul(m0, n4) * input.weights.x + std.mul(m1, n4) * input.weights.y
      + std.mul(m2, n4) * input.weights.z + std.mul(m3, n4) * input.weights.w;
    const inst = skinnedObjLayout.$.instances[input.iid];
    const wp = std.mul(inst.model, d.vec4f(skinnedPos.xyz, 1));
    const wn = std.mul(inst.model, d.vec4f(skinnedNrm.xyz, 0));
    return {
      position: std.mul(scene.$.viewProj, wp),
      wpos: wp.xyz,
      nrm: wn.xyz,
      uv: input.uv,
      lpos: skinnedPos.xyz,
      tint: inst.tint,
      fx: inst.fx,
    };
  });

  const frag = tgpu.fragmentFn({
    in: { wpos: d.vec3f, nrm: d.vec3f, uv: d.vec2f, lpos: d.vec3f, tint: d.vec4f, fx: d.vec4f },
    out: d.vec4f,
  })((input) => {
    'use gpu';
    const texel = std.textureSample(skinnedObjLayout.$.albedo, samp.$, input.uv);
    return shading.surface(texel, input.tint, input.fx, input.lpos, input.nrm, input.wpos);
  });

  const mainPipeline = gfx.root.createRenderPipeline({
    attribs: { ...(skinVertexLayout as any).attrib },
    vertex: skinVert,
    fragment: frag,
    targets: { format: HDR_FORMAT },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
  });

  // ---- fantasma aditivo (afterimages del dash / espectros) ----
  const ghostFrag = tgpu.fragmentFn({
    in: { wpos: d.vec3f, nrm: d.vec3f, uv: d.vec2f, lpos: d.vec3f, tint: d.vec4f, fx: d.vec4f },
    out: d.vec4f,
  })((input) => {
    'use gpu';
    const n = std.normalize(input.nrm);
    const v = std.normalize(scene.$.camPosTime.xyz - input.wpos);
    const f = shading.fresnel(n, v, 2.0);
    const glow = input.tint.rgb * ((f * 1.6 + 0.25) * input.fx.z * input.fx.w);
    return d.vec4f(glow, 0);
  });

  const ghostPipeline = gfx.root.createRenderPipeline({
    attribs: { ...(skinVertexLayout as any).attrib },
    vertex: skinVert,
    fragment: ghostFrag,
    targets: {
      format: HDR_FORMAT,
      blend: {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      },
    },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less' },
  });

  // ---- sombra ----
  const shadowVert = tgpu.vertexFn({
    in: { pos: d.vec3f, joints: d.vec4u, weights: d.vec4f, iid: d.builtin.instanceIndex },
    out: { position: d.builtin.position },
  })((input) => {
    'use gpu';
    const bc = skinnedObjLayout.$.info.counts.x;
    const base = input.iid * bc;
    const p4 = d.vec4f(input.pos, 1);
    const skinnedPos = std.mul(skinnedObjLayout.$.palette[base + input.joints.x], p4) * input.weights.x
      + std.mul(skinnedObjLayout.$.palette[base + input.joints.y], p4) * input.weights.y
      + std.mul(skinnedObjLayout.$.palette[base + input.joints.z], p4) * input.weights.z
      + std.mul(skinnedObjLayout.$.palette[base + input.joints.w], p4) * input.weights.w;
    const inst = skinnedObjLayout.$.instances[input.iid];
    const wp = std.mul(inst.model, d.vec4f(skinnedPos.xyz, 1));
    return { position: std.mul(scene.$.shadowVP, wp) };
  });

  const shadowPipeline = gfx.root.createRenderPipeline({
    attribs: {
      pos: (skinVertexLayout as any).attrib.pos,
      joints: (skinVertexLayout as any).attrib.joints,
      weights: (skinVertexLayout as any).attrib.weights,
    },
    vertex: shadowVert,
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: { format: SHADOW_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
  } as any);

  const createType = (mesh: GpuMesh, baked: BakedCharacter, albedoView: any, capacity: number): SkinnedType => {
    const clipNames = Object.keys(baked.clips).sort();
    const clipIndex: Record<string, number> = {};
    const clipRaw = new Uint32Array(clipNames.length * 4);
    clipNames.forEach((name, i) => {
      clipIndex[name] = i;
      const c = baked.clips[name];
      clipRaw[i * 4] = c.base;
      clipRaw[i * 4 + 1] = c.count;
      clipRaw[i * 4 + 2] = c.loop ? 1 : 0;
    });
    const root = gfx.root as any;
    const bakedBuffer = root.createBuffer(d.arrayOf(d.mat4x4f, baked.frames.length / 16)).$usage('storage');
    bakedBuffer.write(baked.frames);
    const clipTableBuffer = root.createBuffer(d.arrayOf(d.vec4u, clipNames.length)).$usage('storage');
    clipTableBuffer.write(clipRaw);
    const statesBuffer = root.createBuffer(d.arrayOf(AnimState, capacity)).$usage('storage');
    const paletteBuffer = root.createBuffer(d.arrayOf(d.mat4x4f, capacity * baked.boneCount)).$usage('storage');
    const infoBuffer = root.createBuffer(TypeInfo).$usage('uniform');
    const instanceBuffer = root.createBuffer(d.arrayOf(InstanceStruct, capacity)).$usage('storage');

    const paletteBG = gfx.root.createBindGroup(paletteLayout, {
      baked: bakedBuffer, clipTable: clipTableBuffer, states: statesBuffer,
      info: infoBuffer, palette: paletteBuffer,
    });
    const renderBG = gfx.root.createBindGroup(skinnedObjLayout, {
      instances: instanceBuffer, palette: paletteBuffer, info: infoBuffer, albedo: albedoView,
    });

    const statesBytes = new ArrayBuffer(capacity * 32);
    return {
      mesh, boneCount: baked.boneCount, capacity, count: 0, ghostCount: 0,
      raw: new Float32Array(capacity * 24),
      statesBytes,
      statesU32: new Uint32Array(statesBytes),
      statesF32: new Float32Array(statesBytes),
      instanceBuffer, statesBuffer, infoBuffer, paletteBG, renderBG, clipIndex,
    };
  };

  const upload = (t: SkinnedType): void => {
    const total = t.count + t.ghostCount;
    if (total === 0) return;
    t.instanceBuffer.write(t.raw.subarray(0, total * 24));
    t.statesBuffer.write(new Uint8Array(t.statesBytes, 0, total * 32));
    t.infoBuffer.write(new Uint32Array([t.boneCount, total, 0, 0]));
  };

  const computePalettes = (encoder: GPUCommandEncoder, types: SkinnedType[]): void => {
    for (const t of types) {
      const total = t.count + t.ghostCount;
      if (total === 0) continue;
      palettePipeline
        .with(encoder)
        .with(t.paletteBG)
        .dispatchWorkgroups(Math.ceil(t.boneCount / 4), Math.ceil(total / 16));
    }
  };

  const drawMain = (pass: GPURenderPassEncoder, types: SkinnedType[]): void => {
    for (const t of types) {
      if (t.count === 0) continue;
      mainPipeline
        .with(pass)
        .with(t.renderBG)
        .with(skinVertexLayout as any, t.mesh.vertexBuffer)
        .withIndexBuffer(t.mesh.indexBuffer)
        .drawIndexed(t.mesh.indexCount, t.count);
    }
  };

  const drawShadow = (pass: GPURenderPassEncoder, types: SkinnedType[]): void => {
    for (const t of types) {
      if (t.count === 0) continue;
      (shadowPipeline as any)
        .with(pass)
        .with(t.renderBG)
        .with(skinVertexLayout as any, t.mesh.vertexBuffer)
        .withIndexBuffer(t.mesh.indexBuffer)
        .drawIndexed(t.mesh.indexCount, t.count);
    }
  };

  const drawGhosts = (pass: GPURenderPassEncoder, types: SkinnedType[]): void => {
    for (const t of types) {
      if (t.ghostCount === 0) continue;
      ghostPipeline
        .with(pass)
        .with(t.renderBG)
        .with(skinVertexLayout as any, t.mesh.vertexBuffer)
        .withIndexBuffer(t.mesh.indexBuffer)
        .drawIndexed(t.mesh.indexCount, t.ghostCount, 0, 0, t.count);
    }
  };

  return { createType, upload, computePalettes, drawMain, drawShadow, drawGhosts };
}

/** Escribe el estado de animación de una instancia (slot de 32 bytes). */
export function writeAnimState(
  t: SkinnedType, idx: number,
  clipA: number, clipB: number, tA: number, tB: number, blend: number,
): void {
  const o = idx * 8;
  t.statesU32[o] = clipA;
  t.statesU32[o + 1] = clipB;
  t.statesF32[o + 4] = tA;
  t.statesF32[o + 5] = tB;
  t.statesF32[o + 6] = blend;
}
