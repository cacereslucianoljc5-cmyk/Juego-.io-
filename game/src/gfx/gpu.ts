/**
 * Contexto GPU central: root de TypeGPU, uniforme de escena, luces dinámicas,
 * targets HDR/depth/shadow, samplers y utilidades de subida de geometría.
 */
import tgpu, { d } from 'typegpu';
import type { TgpuRoot, TgpuUniform } from 'typegpu';
import type { MeshData } from './meshes';

/** Uniforme global de escena. Solo floats para poder volcarlo de un Float32Array. */
export const SceneStruct = d.struct({
  viewProj: d.mat4x4f,
  shadowVP: d.mat4x4f,
  camPosTime: d.vec4f,      // xyz cámara, w tiempo
  camRightAspect: d.vec4f,  // xyz right, w aspecto
  camUpShockR: d.vec4f,     // xyz up, w radio de shockwave (post)
  camFwdShockAmp: d.vec4f,  // xyz fwd, w amplitud de shockwave
  sunDirHurt: d.vec4f,      // xyz dir hacia el sol, w pulso de daño 0..1
  sunColorLights: d.vec4f,  // rgb sol, w nº de luces
  ambientSky: d.vec4f,      // rgb ambiente cielo, w pulso del muro
  ambientGround: d.vec4f,   // rgb ambiente suelo, w fade de muerte 0..1
  playerGlow: d.vec4f,      // xyz posición del jugador, w aura
});

export const LightStruct = d.struct({
  posRange: d.vec4f,       // xyz posición, w radio
  colorIntensity: d.vec4f, // rgb color, w intensidad
});
export const MAX_LIGHTS = 24;
export const LightsArray = d.arrayOf(LightStruct, MAX_LIGHTS);

/** Instancia común para mallas estáticas y skinned. */
export const InstanceStruct = d.struct({
  model: d.mat4x4f,
  tint: d.vec4f, // rgb tinte multiplicativo, w saturación de emisivo del tinte
  fx: d.vec4f,   // x flash blanco, y dissolve 0..1, z boost emisivo, w modo fantasma
});
export const INSTANCE_FLOATS = 24;

// Layouts de vértice compactos (sin padding WGSL)
export const staticVertexLayout = tgpu.vertexLayout(
  (n: number) => d.disarrayOf(d.unstruct({ pos: d.float32x3, nrm: d.float32x3, uv: d.float32x2 }), n),
);
export const skinVertexLayout = tgpu.vertexLayout(
  (n: number) => d.disarrayOf(d.unstruct({
    pos: d.float32x3, nrm: d.float32x3, uv: d.float32x2, joints: d.uint8x4, weights: d.unorm8x4,
  }), n),
);

export const SHADOW_SIZE = 2048;
export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';
export const SHADOW_FORMAT: GPUTextureFormat = 'depth32float';

export interface GpuMesh {
  vertexBuffer: any;
  indexBuffer: any;
  indexCount: number;
}

export class Gfx {
  root!: TgpuRoot;
  device!: GPUDevice;
  context!: ReturnType<TgpuRoot['configureContext']>;
  canvas!: HTMLCanvasElement;
  canvasFormat!: GPUTextureFormat;

  scene!: TgpuUniform<typeof SceneStruct>;
  lights!: TgpuUniform<typeof LightsArray>;
  sceneRaw = new Float32Array(16 * 2 + 4 * 9);
  lightsRaw = new Float32Array(MAX_LIGHTS * 8);

  // vistas nombradas dentro de sceneRaw
  viewProj = this.sceneRaw.subarray(0, 16);
  shadowVP = this.sceneRaw.subarray(16, 32);
  camPosTime = this.sceneRaw.subarray(32, 36);
  camRightAspect = this.sceneRaw.subarray(36, 40);
  camUpShockR = this.sceneRaw.subarray(40, 44);
  camFwdShockAmp = this.sceneRaw.subarray(44, 48);
  sunDirHurt = this.sceneRaw.subarray(48, 52);
  sunColorLights = this.sceneRaw.subarray(52, 56);
  ambientSky = this.sceneRaw.subarray(56, 60);
  ambientGround = this.sceneRaw.subarray(60, 64);
  playerGlow = this.sceneRaw.subarray(64, 68);

  linearSampler!: ReturnType<TgpuRoot['createSampler']>;
  clampSampler!: ReturnType<TgpuRoot['createSampler']>;
  nearestSampler!: ReturnType<TgpuRoot['createSampler']>;
  shadowSampler!: ReturnType<TgpuRoot['createComparisonSampler']>;

  hdrTex: any = null;
  depthTex: any = null;
  shadowTex: any = null;
  hdrRenderView: any = null;
  hdrSampleView: any = null;
  depthRenderView: any = null;
  shadowRenderView: any = null;
  shadowSampleView: any = null;

  width = 0;
  height = 0;

  /** true → nunca presenta al canvas (verificación headless: swiftshader crashea al presentar) */
  headless = false;

  static async create(canvas: HTMLCanvasElement, headless = false): Promise<Gfx> {
    const g = new Gfx();
    g.canvas = canvas;
    g.headless = headless;
    g.root = await tgpu.init({
      device: {
        optionalFeatures: ['float32-filterable'],
      },
    });
    g.device = g.root.device;
    g.device.lost.then((info) => {
      console.error('DEVICE LOST:', info.reason, info.message);
      (window as any).__deviceLost = `${info.reason}: ${info.message}`;
    });
    g.device.addEventListener('uncapturederror', (ev) => {
      console.error('GPU ERROR:', (ev as GPUUncapturedErrorEvent).error.message);
    });
    g.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    if (!headless) {
      g.context = g.root.configureContext({ canvas, alphaMode: 'opaque' });
    }

    g.scene = g.root.createUniform(SceneStruct);
    g.lights = g.root.createUniform(LightsArray);

    g.linearSampler = g.root.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 4,
    });
    g.clampSampler = g.root.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });
    g.nearestSampler = g.root.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
    g.shadowSampler = g.root.createComparisonSampler({
      compare: 'less', magFilter: 'linear', minFilter: 'linear',
    });

    // shadow map fijo
    g.shadowTex = g.root.createTexture({ size: [SHADOW_SIZE, SHADOW_SIZE], format: SHADOW_FORMAT }).$usage('render', 'sampled');
    g.shadowRenderView = g.shadowTex.createView('render');
    g.shadowSampleView = g.shadowTex.createView(d.textureDepth2d());

    g.ensureSize();
    return g;
  }

  /** Redimensiona los targets si el canvas cambió. Devuelve true si hubo cambio. */
  ensureSize(): boolean {
    const w = Math.max(8, Math.floor(this.canvas.clientWidth * (window.devicePixelRatio || 1)));
    const h = Math.max(8, Math.floor(this.canvas.clientHeight * (window.devicePixelRatio || 1)));
    if (w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.hdrTex?.destroy();
    this.depthTex?.destroy();
    this.hdrTex = this.root.createTexture({ size: [w, h], format: HDR_FORMAT }).$usage('render', 'sampled');
    this.depthTex = this.root.createTexture({ size: [w, h], format: DEPTH_FORMAT }).$usage('render', 'sampled');
    this.hdrRenderView = this.hdrTex.createView('render');
    this.hdrSampleView = this.hdrTex.createView(d.texture2d(d.f32));
    this.depthRenderView = this.depthTex.createView('render');
    return true;
  }

  uploadScene(): void {
    (this.scene as any).write(this.sceneRaw);
    (this.lights as any).write(this.lightsRaw);
  }

  /** Sube una malla estática (stride 32B: pos+nrm+uv). */
  uploadMesh(mesh: MeshData): GpuMesh {
    const n = mesh.verts.length / 8;
    const vertexBuffer = this.root
      .createBuffer(staticVertexLayout.schemaForCount(n))
      .$usage('vertex') as any;
    vertexBuffer.write(mesh.verts);
    const indexBuffer = this.root
      .createBuffer(d.arrayOf(d.u32, mesh.indices.length))
      .$usage('index') as any;
    indexBuffer.write(mesh.indices);
    return { vertexBuffer, indexBuffer, indexCount: mesh.indices.length };
  }

  /** Sube geometría skinned empaquetada (stride 40B) desde arrays sueltos. */
  uploadSkinnedMesh(
    positions: Float32Array, normals: Float32Array, uvs: Float32Array,
    joints: Uint8Array, weights: Float32Array, indices: Uint32Array,
  ): GpuMesh {
    const n = positions.length / 3;
    const bytes = new ArrayBuffer(n * 40);
    const dv = new DataView(bytes);
    for (let i = 0; i < n; i++) {
      const o = i * 40;
      dv.setFloat32(o, positions[i * 3], true);
      dv.setFloat32(o + 4, positions[i * 3 + 1], true);
      dv.setFloat32(o + 8, positions[i * 3 + 2], true);
      dv.setFloat32(o + 12, normals[i * 3], true);
      dv.setFloat32(o + 16, normals[i * 3 + 1], true);
      dv.setFloat32(o + 20, normals[i * 3 + 2], true);
      dv.setFloat32(o + 24, uvs[i * 2], true);
      dv.setFloat32(o + 28, uvs[i * 2 + 1], true);
      dv.setUint8(o + 32, joints[i * 4]);
      dv.setUint8(o + 33, joints[i * 4 + 1]);
      dv.setUint8(o + 34, joints[i * 4 + 2]);
      dv.setUint8(o + 35, joints[i * 4 + 3]);
      dv.setUint8(o + 36, Math.round(weights[i * 4] * 255));
      dv.setUint8(o + 37, Math.round(weights[i * 4 + 1] * 255));
      dv.setUint8(o + 38, Math.round(weights[i * 4 + 2] * 255));
      dv.setUint8(o + 39, Math.round(weights[i * 4 + 3] * 255));
    }
    const vertexBuffer = this.root
      .createBuffer(skinVertexLayout.schemaForCount(n))
      .$usage('vertex') as any;
    vertexBuffer.write(bytes);
    const indexBuffer = this.root
      .createBuffer(d.arrayOf(d.u32, indices.length))
      .$usage('index') as any;
    indexBuffer.write(indices);
    return { vertexBuffer, indexBuffer, indexCount: indices.length };
  }

  /** Textura sRGB con mips a partir de un ImageBitmap (o blanco 1×1 si es null). */
  async uploadTexture(image: ImageBitmap | HTMLCanvasElement | null, srgb = true): Promise<any> {
    if (!image) {
      const tex = this.root.createTexture({ size: [1, 1], format: 'rgba8unorm' }).$usage('sampled', 'render');
      await (tex as any).write(new Uint8Array([255, 255, 255, 255]) as any);
      return tex;
    }
    const w = image.width;
    const h = image.height;
    const mips = Math.floor(Math.log2(Math.max(w, h))) + 1;
    const tex = this.root.createTexture({
      size: [w, h],
      format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
      mipLevelCount: mips,
    }).$usage('sampled', 'render');
    await (tex as any).write(image);
    (tex as any).generateMipmaps();
    return tex;
  }
}
