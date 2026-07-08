/**
 * Pipeline de mallas estáticas instanciadas: enemigos (animación puppet en la
 * matriz de instancia), props y estatuas. Con flash, dissolve, tinte y boost
 * emisivo por instancia. Incluye variante depth-only para el shadow map.
 */
import tgpu, { d, std } from 'typegpu';
import {
  DEPTH_FORMAT, HDR_FORMAT, InstanceStruct, SHADOW_FORMAT, staticVertexLayout,
} from './gpu';
import type { Gfx, GpuMesh } from './gpu';
import type { Shading } from './shading';

export const staticObjLayout = tgpu.bindGroupLayout({
  instances: { storage: d.arrayOf(InstanceStruct) },
  albedo: { texture: d.texture2d(d.f32) },
});

export interface StaticBatch {
  mesh: GpuMesh;
  bindGroup: any;
  instanceBuffer: any;
  raw: Float32Array;
  count: number;
  capacity: number;
  castsShadow: boolean;
  /** marca para subir el mirror CPU al buffer GPU en el próximo frame */
  dirty: boolean;
}

export interface StaticPipelines {
  createBatch(mesh: GpuMesh, albedoView: any, capacity: number, castsShadow?: boolean): StaticBatch;
  /** parte extra de un modelo multi-primitiva: comparte instancias con `owner` */
  createBatchPart(mesh: GpuMesh, albedoView: any, owner: StaticBatch): StaticBatch;
  uploadBatch(b: StaticBatch): void;
  drawMain(pass: GPURenderPassEncoder, batches: StaticBatch[]): void;
  drawShadow(pass: GPURenderPassEncoder, batches: StaticBatch[]): void;
}

export function createStaticPipelines(gfx: Gfx, shading: Shading): StaticPipelines {
  const scene = gfx.scene;
  const samp = gfx.linearSampler;

  const vert = tgpu.vertexFn({
    in: {
      pos: d.vec3f, nrm: d.vec3f, uv: d.vec2f,
      iid: d.builtin.instanceIndex,
    },
    out: {
      position: d.builtin.position,
      wpos: d.vec3f, nrm: d.vec3f, uv: d.vec2f,
      lpos: d.vec3f, tint: d.vec4f, fx: d.vec4f,
    },
  })((input) => {
    'use gpu';
    const inst = staticObjLayout.$.instances[input.iid];
    const wp = std.mul(inst.model, d.vec4f(input.pos, 1));
    const wn = std.mul(inst.model, d.vec4f(input.nrm, 0));
    return {
      position: std.mul(scene.$.viewProj, wp),
      wpos: wp.xyz,
      nrm: wn.xyz,
      uv: input.uv,
      lpos: input.pos,
      tint: inst.tint,
      fx: inst.fx,
    };
  });

  const frag = tgpu.fragmentFn({
    in: { wpos: d.vec3f, nrm: d.vec3f, uv: d.vec2f, lpos: d.vec3f, tint: d.vec4f, fx: d.vec4f },
    out: d.vec4f,
  })((input) => {
    'use gpu';
    const texel = std.textureSample(staticObjLayout.$.albedo, samp.$, input.uv);
    return shading.surface(texel, input.tint, input.fx, input.lpos, input.nrm, input.wpos);
  });

  const mainPipeline = gfx.root.createRenderPipeline({
    attribs: { ...(staticVertexLayout as any).attrib },
    vertex: vert,
    fragment: frag,
    targets: { format: HDR_FORMAT },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
  });

  // sombra: solo profundidad
  const shadowVert = tgpu.vertexFn({
    in: { pos: d.vec3f, iid: d.builtin.instanceIndex },
    out: { position: d.builtin.position },
  })((input) => {
    'use gpu';
    const inst = staticObjLayout.$.instances[input.iid];
    const wp = std.mul(inst.model, d.vec4f(input.pos, 1));
    return { position: std.mul(scene.$.shadowVP, wp) };
  });

  const shadowPipeline = gfx.root.createRenderPipeline({
    attribs: { pos: (staticVertexLayout as any).attrib.pos },
    vertex: shadowVert,
    primitive: { topology: 'triangle-list', cullMode: 'front' },
    depthStencil: { format: SHADOW_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
  } as any);

  const createBatch = (mesh: GpuMesh, albedoView: any, capacity: number, castsShadow = true): StaticBatch => {
    const instanceBuffer = (gfx.root
      .createBuffer(d.arrayOf(InstanceStruct, capacity)) as any)
      .$usage('storage');
    const bindGroup = gfx.root.createBindGroup(staticObjLayout, {
      instances: instanceBuffer,
      albedo: albedoView,
    });
    return {
      mesh, bindGroup, instanceBuffer,
      raw: new Float32Array(capacity * 24),
      count: 0, capacity, castsShadow, dirty: false,
    };
  };

  const createBatchPart = (mesh: GpuMesh, albedoView: any, owner: StaticBatch): StaticBatch => {
    const bindGroup = gfx.root.createBindGroup(staticObjLayout, {
      instances: owner.instanceBuffer,
      albedo: albedoView,
    });
    return {
      mesh, bindGroup,
      instanceBuffer: owner.instanceBuffer,
      raw: owner.raw,
      count: 0, capacity: owner.capacity, castsShadow: owner.castsShadow,
      dirty: false, // el owner gestiona la subida
    };
  };

  const uploadBatch = (b: StaticBatch): void => {
    if (b.dirty && b.count > 0) {
      b.instanceBuffer.write(b.raw.subarray(0, b.count * 24));
      b.dirty = false;
    }
  };

  const drawMain = (pass: GPURenderPassEncoder, batches: StaticBatch[]): void => {
    for (const b of batches) {
      if (b.count === 0) continue;
      mainPipeline
        .with(pass)
        .with(b.bindGroup)
        .with(staticVertexLayout as any, b.mesh.vertexBuffer)
        .withIndexBuffer(b.mesh.indexBuffer)
        .drawIndexed(b.mesh.indexCount, b.count);
    }
  };

  const drawShadow = (pass: GPURenderPassEncoder, batches: StaticBatch[]): void => {
    for (const b of batches) {
      if (b.count === 0 || !b.castsShadow) continue;
      (shadowPipeline as any)
        .with(pass)
        .with(b.bindGroup)
        .with(staticVertexLayout as any, b.mesh.vertexBuffer)
        .withIndexBuffer(b.mesh.indexBuffer)
        .drawIndexed(b.mesh.indexCount, b.count);
    }
  };

  return { createBatch, createBatchPart, uploadBatch, drawMain, drawShadow };
}

/** Escribe una instancia en el mirror CPU (24 floats). Devuelve el offset. */
export function writeInstance(
  raw: Float32Array, idx: number, model: Float32Array,
  r: number, g: number, b: number, emissiveSat: number,
  flash: number, dissolve: number, emissiveBoost: number, ghost: number,
): void {
  const o = idx * 24;
  raw.set(model, o);
  raw[o + 16] = r; raw[o + 17] = g; raw[o + 18] = b; raw[o + 19] = emissiveSat;
  raw[o + 20] = flash; raw[o + 21] = dissolve; raw[o + 22] = emissiveBoost; raw[o + 23] = ghost;
}
