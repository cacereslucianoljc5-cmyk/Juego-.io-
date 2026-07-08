/**
 * Orquestador del frame:
 *   compute (paletas de huesos, partículas) → shadow pass → main pass HDR
 *   (suelo → decals → estáticos → skinned → fantasmas → muro → trails →
 *   partículas → sprites) → bloom → composite (+ captura opcional).
 */
import { SHADOW_SIZE } from './gpu';
import type { Gfx } from './gpu';
import { makeShading } from './shading';
import { createStaticPipelines, type StaticBatch, type StaticPipelines } from './staticPipeline';
import { createSkinnedPipelines, type SkinnedPipelines, type SkinnedType } from './skinnedPipeline';
import { createGroundPipelines, type GroundPipelines } from './groundPipeline';
import { createParticleSystem, type ParticleSystem } from './particlesPipeline';
import { createDecalSystem, type DecalSystem } from './decalsPipeline';
import { createSpriteSystem, type SpriteSystem } from './spritesPipeline';
import { createTrailSystem, type TrailSystem } from './trailsPipeline';
import { createPost, type Post } from './post';
import { groundMesh, wallMesh } from './meshes';

export class Renderer {
  gfx: Gfx;
  statics: StaticPipelines;
  skinned: SkinnedPipelines;
  ground: GroundPipelines;
  particles: ParticleSystem;
  decals: DecalSystem;
  sprites: SpriteSystem;
  trails: TrailSystem;
  post: Post;

  staticBatches: StaticBatch[] = [];
  skinnedTypes: SkinnedType[] = [];

  private hdrView!: GPUTextureView;
  private depthView!: GPUTextureView;
  private shadowView!: GPUTextureView;
  private captureResolve: ((data: ImageData) => void) | null = null;

  constructor(gfx: Gfx, atlasView: any) {
    this.gfx = gfx;
    const shading = makeShading(gfx);
    this.statics = createStaticPipelines(gfx, shading);
    this.skinned = createSkinnedPipelines(gfx, shading);
    this.ground = createGroundPipelines(gfx, shading, gfx.uploadMesh(groundMesh()), gfx.uploadMesh(wallMesh()));
    this.particles = createParticleSystem(gfx, atlasView);
    this.decals = createDecalSystem(gfx);
    this.sprites = createSpriteSystem(gfx, atlasView);
    this.trails = createTrailSystem(gfx);
    this.post = createPost(gfx);
    this.shadowView = gfx.root.unwrap(gfx.shadowRenderView) as unknown as GPUTextureView;
    this.onResize();
  }

  onResize(): void {
    this.hdrView = this.gfx.root.unwrap(this.gfx.hdrRenderView) as unknown as GPUTextureView;
    this.depthView = this.gfx.root.unwrap(this.gfx.depthRenderView) as unknown as GPUTextureView;
    this.post.resize();
  }

  /** Pide una captura del siguiente frame (para verificación headless). */
  capture(): Promise<ImageData> {
    return new Promise((resolve) => {
      this.captureResolve = resolve;
    });
  }

  frame(dt: number, time: number): void {
    const gfx = this.gfx;
    const flags = (globalThis as any).__renderFlags ?? {};
    gfx.uploadScene();
    for (const b of this.staticBatches) this.statics.uploadBatch(b);
    for (const t of this.skinnedTypes) this.skinned.upload(t);
    this.decals.upload();
    this.sprites.upload();
    this.trails.upload();

    const encoder = gfx.device.createCommandEncoder();

    // compute
    if (!flags.noPalettes) this.skinned.computePalettes(encoder, this.skinnedTypes);
    if (!flags.noParticles) this.particles.compute(encoder, dt, time);

    // shadow pass
    if (!flags.noShadow) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: this.shadowView,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      pass.setViewport(0, 0, SHADOW_SIZE, SHADOW_SIZE, 0, 1);
      this.statics.drawShadow(pass, this.staticBatches);
      this.skinned.drawShadow(pass, this.skinnedTypes);
      pass.end();
    }

    // main pass HDR
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.hdrView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0.012, g: 0.014, b: 0.028, a: 1 },
        }],
        depthStencilAttachment: {
          view: this.depthView,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      if (!flags.noGround) this.ground.drawGround(pass);
      if (!flags.noDecals) this.decals.draw(pass);
      if (!flags.noStatics) this.statics.drawMain(pass, this.staticBatches);
      if (!flags.noSkinned) {
        this.skinned.drawMain(pass, this.skinnedTypes);
        this.skinned.drawGhosts(pass, this.skinnedTypes);
      }
      if (!flags.noWall) this.ground.drawWall(pass);
      if (!flags.noTrails) this.trails.draw(pass);
      if (!flags.noParticles) this.particles.draw(pass);
      if (!flags.noSprites) this.sprites.draw(pass);
      pass.end();
    }

    // bloom + composite
    this.post.run(encoder);
    const wantsCapture = this.captureResolve !== null;
    if (wantsCapture) {
      this.post.runCapture(encoder);
    }
    gfx.device.queue.submit([encoder.finish()]);

    if (wantsCapture) {
      const resolve = this.captureResolve!;
      this.captureResolve = null;
      this.post.readCapture().then(resolve);
    }
  }
}
