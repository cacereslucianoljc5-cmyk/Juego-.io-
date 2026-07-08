/**
 * Post-procesado HDR:
 *  - bloom: extracción de brillos + cadena down/upsample (5 niveles)
 *  - composite: tonemap ACES, viñeta, pulso de daño, distorsión radial de
 *    shockwave, aberración cromática y grano sutil
 *  - captura a rgba8 + readback para screenshots de verificación
 */
import tgpu, { d, std } from 'typegpu';
import { randf } from '@typegpu/noise';
import { HDR_FORMAT } from './gpu';
import type { Gfx } from './gpu';

const BLOOM_LEVELS = 5;

const srcLayout = tgpu.bindGroupLayout({
  src: { texture: d.texture2d(d.f32) },
});
const compositeLayout = tgpu.bindGroupLayout({
  hdr: { texture: d.texture2d(d.f32) },
  bloom: { texture: d.texture2d(d.f32) },
});

export interface Post {
  resize(): void;
  run(encoder: GPUCommandEncoder): void;
  runCapture(encoder: GPUCommandEncoder): void;
  readCapture(): Promise<ImageData>;
}

export function createPost(gfx: Gfx): Post {
  const scene = gfx.scene;
  const samp = gfx.clampSampler;
  const root = gfx.root as any;

  const fullscreen = tgpu.vertexFn({
    in: { vid: d.builtin.vertexIndex },
    out: { position: d.builtin.position, uv: d.vec2f },
  })((input) => {
    'use gpu';
    const x = std.select(d.f32(0), d.f32(2), input.vid === 1);
    const y = std.select(d.f32(0), d.f32(2), input.vid === 2);
    return {
      position: d.vec4f(x * 2 - 1, 1 - y * 2, 0, 1),
      uv: d.vec2f(x, y),
    };
  });

  // ---- bright pass ----
  const brightFrag = tgpu.fragmentFn({
    in: { uv: d.vec2f },
    out: d.vec4f,
  })((input) => {
    'use gpu';
    const c = std.textureSampleLevel(srcLayout.$.src, samp.$, input.uv, 0);
    const luma = std.dot(c.rgb, d.vec3f(0.2126, 0.7152, 0.0722));
    const knee = std.smoothstep(0.85, 1.7, luma);
    return d.vec4f(c.rgb * knee, 1);
  });

  // ---- downsample (box 4 taps + centro) ----
  const downFrag = tgpu.fragmentFn({
    in: { uv: d.vec2f },
    out: d.vec4f,
  })((input) => {
    'use gpu';
    const ts = d.vec2f(1) / d.vec2f(std.textureDimensions(srcLayout.$.src));
    let acc = std.textureSampleLevel(srcLayout.$.src, samp.$, input.uv, 0).rgb * 0.5;
    acc += std.textureSampleLevel(srcLayout.$.src, samp.$, input.uv + ts * d.vec2f(-1, -1), 0).rgb * 0.125;
    acc += std.textureSampleLevel(srcLayout.$.src, samp.$, input.uv + ts * d.vec2f(1, -1), 0).rgb * 0.125;
    acc += std.textureSampleLevel(srcLayout.$.src, samp.$, input.uv + ts * d.vec2f(-1, 1), 0).rgb * 0.125;
    acc += std.textureSampleLevel(srcLayout.$.src, samp.$, input.uv + ts * d.vec2f(1, 1), 0).rgb * 0.125;
    return d.vec4f(acc, 1);
  });

  // ---- upsample tent (aditivo sobre el nivel superior) ----
  const upFrag = tgpu.fragmentFn({
    in: { uv: d.vec2f },
    out: d.vec4f,
  })((input) => {
    'use gpu';
    const ts = d.vec2f(1) / d.vec2f(std.textureDimensions(srcLayout.$.src));
    let acc = std.textureSampleLevel(srcLayout.$.src, samp.$, input.uv, 0).rgb * 0.25;
    acc += std.textureSampleLevel(srcLayout.$.src, samp.$, input.uv + ts * d.vec2f(-1, 0), 0).rgb * 0.125;
    acc += std.textureSampleLevel(srcLayout.$.src, samp.$, input.uv + ts * d.vec2f(1, 0), 0).rgb * 0.125;
    acc += std.textureSampleLevel(srcLayout.$.src, samp.$, input.uv + ts * d.vec2f(0, -1), 0).rgb * 0.125;
    acc += std.textureSampleLevel(srcLayout.$.src, samp.$, input.uv + ts * d.vec2f(0, 1), 0).rgb * 0.125;
    acc += std.textureSampleLevel(srcLayout.$.src, samp.$, input.uv + ts * d.vec2f(-1, -1), 0).rgb * 0.0625;
    acc += std.textureSampleLevel(srcLayout.$.src, samp.$, input.uv + ts * d.vec2f(1, -1), 0).rgb * 0.0625;
    acc += std.textureSampleLevel(srcLayout.$.src, samp.$, input.uv + ts * d.vec2f(-1, 1), 0).rgb * 0.0625;
    acc += std.textureSampleLevel(srcLayout.$.src, samp.$, input.uv + ts * d.vec2f(1, 1), 0).rgb * 0.0625;
    return d.vec4f(acc, 1);
  });

  // ---- composite ----
  const aces = (x: d.v3f): d.v3f => {
    'use gpu';
    const a = x * (x * 2.51 + d.vec3f(0.03));
    const b = x * (x * 2.43 + d.vec3f(0.59)) + d.vec3f(0.14);
    return std.clamp(a / b, d.vec3f(0), d.vec3f(1));
  };

  const compositeFrag = tgpu.fragmentFn({
    in: { uv: d.vec2f },
    out: d.vec4f,
  })((input) => {
    'use gpu';
    const time = scene.$.camPosTime.w;
    const hurt = scene.$.sunDirHurt.w;
    const shockR = scene.$.camUpShockR.w;
    const shockAmp = scene.$.camFwdShockAmp.w;
    const deathFade = scene.$.ambientGround.w;

    // distorsión radial de shockwave (centrada en pantalla)
    let uv = d.vec2f(input.uv);
    const fromC = uv - d.vec2f(0.5);
    const distC = std.length(fromC);
    if (shockAmp > 0.001) {
      const wave = std.exp(-std.pow((distC - shockR) * 9, 2)) * shockAmp;
      uv += (fromC / std.max(distC, 0.001)) * wave * 0.05;
    }

    // aberración cromática radial
    const caAmt = (0.0009 + hurt * 0.0035 + shockAmp * 0.006) * distC * 2.4;
    const dir = fromC * caAmt * 2;
    const r = std.textureSampleLevel(compositeLayout.$.hdr, samp.$, uv + dir, 0).r;
    const g = std.textureSampleLevel(compositeLayout.$.hdr, samp.$, uv, 0).g;
    const b = std.textureSampleLevel(compositeLayout.$.hdr, samp.$, uv - dir, 0).b;
    let hdr = d.vec3f(r, g, b);
    const bloom = std.textureSampleLevel(compositeLayout.$.bloom, samp.$, uv, 0).rgb;
    hdr += bloom * 0.85;

    // tonemap + gradeo
    let col = aces(hdr * 1.05);
    const lum = std.dot(col, d.vec3f(0.2126, 0.7152, 0.0722));
    col = std.mix(d.vec3f(lum), col, 1.12); // saturación
    // viñeta
    const vig = 1 - std.smoothstep(0.55, 1.42, distC * 2);
    col = col * (0.32 + vig * 0.68);
    // pulso de daño: anillo rojo del borde
    const hurtRing = std.smoothstep(0.5, 1.05, distC * 2) * hurt;
    col = std.mix(col, d.vec3f(0.75, 0.05, 0.05), hurtRing * 0.55);
    // fade de muerte: desaturación + oscurecido parcial
    col = std.mix(col, d.vec3f(lum) * 0.55, deathFade * 0.8);
    // grano sutil
    randf.seed2(input.uv * 991.7 + d.vec2f(std.fract(time * 13.7), std.fract(time * 7.9)));
    col += d.vec3f(randf.sample() - 0.5) * 0.016;
    return d.vec4f(col, 1);
  });

  const brightPipeline = gfx.root.createRenderPipeline({
    vertex: fullscreen, fragment: brightFrag, targets: { format: HDR_FORMAT },
  });
  const downPipeline = gfx.root.createRenderPipeline({
    vertex: fullscreen, fragment: downFrag, targets: { format: HDR_FORMAT },
  });
  const upPipeline = gfx.root.createRenderPipeline({
    vertex: fullscreen, fragment: upFrag,
    targets: {
      format: HDR_FORMAT,
      blend: {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      },
    },
  });
  const compositePipeline = gfx.root.createRenderPipeline({
    vertex: fullscreen, fragment: compositeFrag, targets: { format: gfx.canvasFormat },
  });
  const capturePipeline = gfx.root.createRenderPipeline({
    vertex: fullscreen, fragment: compositeFrag, targets: { format: 'rgba8unorm' },
  });

  // ---- recursos dependientes del tamaño ----
  let bloomTex: any[] = [];
  let bloomRenderViews: GPUTextureView[] = [];
  let bloomBGs: any[] = []; // bind group que LEE el nivel i
  let hdrBG: any = null;
  let compositeBG: any = null;
  let captureTex: GPUTexture | null = null;
  let captureBuf: GPUBuffer | null = null;
  let capW = 0;
  let capH = 0;

  const resize = (): void => {
    for (const t of bloomTex) t.destroy();
    bloomTex = [];
    bloomRenderViews = [];
    bloomBGs = [];
    let w = Math.max(1, gfx.width >> 1);
    let h = Math.max(1, gfx.height >> 1);
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const t = root.createTexture({ size: [w, h], format: HDR_FORMAT }).$usage('render', 'sampled');
      bloomTex.push(t);
      bloomRenderViews.push(root.unwrap(t.createView('render')));
      bloomBGs.push(gfx.root.createBindGroup(srcLayout, { src: t.createView(d.texture2d(d.f32)) }));
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    hdrBG = gfx.root.createBindGroup(srcLayout, { src: gfx.hdrSampleView });
    compositeBG = gfx.root.createBindGroup(compositeLayout, {
      hdr: gfx.hdrSampleView,
      bloom: bloomTex[0].createView(d.texture2d(d.f32)),
    });
    captureTex?.destroy();
    captureBuf?.destroy();
    capW = gfx.width;
    capH = gfx.height;
    captureTex = gfx.device.createTexture({
      size: [capW, capH],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const bytesPerRow = Math.ceil((capW * 4) / 256) * 256;
    captureBuf = gfx.device.createBuffer({
      size: bytesPerRow * capH,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  };

  const runBloom = (encoder: GPUCommandEncoder): void => {
    const passDesc = (view: GPUTextureView, load: GPULoadOp): GPURenderPassDescriptor => ({
      colorAttachments: [{ view, loadOp: load, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    // bright → bloom[0]
    {
      const pass = encoder.beginRenderPass(passDesc(bloomRenderViews[0], 'clear'));
      brightPipeline.with(pass).with(hdrBG).draw(3);
      pass.end();
    }
    // downsample
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      const pass = encoder.beginRenderPass(passDesc(bloomRenderViews[i], 'clear'));
      downPipeline.with(pass).with(bloomBGs[i - 1]).draw(3);
      pass.end();
    }
    // upsample aditivo
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      const pass = encoder.beginRenderPass(passDesc(bloomRenderViews[i - 1], 'load'));
      upPipeline.with(pass).with(bloomBGs[i]).draw(3);
      pass.end();
    }
  };

  return {
    resize,
    run(encoder: GPUCommandEncoder) {
      runBloom(encoder);
      if (gfx.headless) return; // en headless solo se compone bajo demanda vía runCapture
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: gfx.context.getCurrentTexture().createView(),
          loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      compositePipeline.with(pass).with(compositeBG).draw(3);
      pass.end();
    },
    runCapture(encoder: GPUCommandEncoder) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: captureTex!.createView(),
          loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      capturePipeline.with(pass).with(compositeBG).draw(3);
      pass.end();
      const bytesPerRow = Math.ceil((capW * 4) / 256) * 256;
      encoder.copyTextureToBuffer(
        { texture: captureTex! },
        { buffer: captureBuf!, bytesPerRow },
        [capW, capH],
      );
    },
    async readCapture(): Promise<ImageData> {
      await captureBuf!.mapAsync(GPUMapMode.READ);
      const bytesPerRow = Math.ceil((capW * 4) / 256) * 256;
      const src = new Uint8Array(captureBuf!.getMappedRange());
      const out = new ImageData(capW, capH);
      for (let y = 0; y < capH; y++) {
        out.data.set(src.subarray(y * bytesPerRow, y * bytesPerRow + capW * 4), y * capW * 4);
      }
      captureBuf!.unmap();
      // alpha opaco
      for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
      return out;
    },
  };
}
