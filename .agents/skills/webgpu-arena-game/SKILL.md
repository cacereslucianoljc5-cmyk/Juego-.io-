---
name: webgpu-arena-game
description: >-
  Lessons learned building a browser .io-style melee arena game with WebGPU
  + TypeGPU from riggeed Meshy GLB characters: fusing separate animation-clip
  GLBs, auto-detecting weapon swing timing from bone velocity, headless
  WebGPU verification (screenshots without a real GPU/display), progressive
  enemy-spawn balancing, and shipping to Vercel from this sandboxed
  environment. Use whenever the task is "build/extend a WebGPU or TypeGPU
  game", "load/optimize/animate GLB character models", "verify a WebGPU app
  headlessly / take screenshots without a browser window", or "deploy a
  Vite app to Vercel from an agent sandbox". Skip for unrelated web work,
  non-GLB 3D pipelines, or WebGL/Three.js projects (this is WebGPU-specific).
---

# WebGPU .io arena game — lessons from a full build

Built: single-player melee arena (WASD + mouse), WebGPU renderer via
TypeGPU (`'use gpu'` shaders, no hand-written WGSL), 14 riggeable GLB
characters doubling as both playable characters and enemies, GPU compute
skinning, GPU particle system, procedural ground/props, post-processing,
minimal DOM menu overlay. Shipped to Vercel + GitHub Pages. This document
is the postmortem — what was slow or wrong the first time, and the fix to
do it faster next time.

---

## 1. Asset pipeline: fusing Meshy's split-clip GLBs

Meshy (or similar per-clip-export pipelines) hands you one GLB per stage:
`_rigged.glb` (T-pose, garbage `clip0` animation — **always dispose it**,
don't try to reuse it), plus separate `_anim_walk.glb`, `_anim_run.glb`,
`_anim_attack_<Name>.glb`, `_anim_dead_<Name>.glb`, sometimes `_anim_idle`/
`_anim_hit`. A game needs ONE glb per character with all clips merged.

**Recipe that worked** (`@gltf-transform/core` + `functions`):
1. Read the `_rigged.glb` as the base doc, `anim.dispose()` its `clip0`.
2. For each separate anim GLB, read it, then copy animation channels into
   the base doc by **matching node names** (not indices — armature node
   order isn't guaranteed identical across separate Meshy exports), cloning
   accessors into the base doc's buffer. Track max keyframe time as the
   clip's duration.
3. Strip everything non-essential per material (`emissiveTexture`,
   `metallicRoughnessTexture`, `normalTexture`, `occlusionTexture`,
   `KHR_materials_specular`, `KHR_materials_ior`) — you're relighting in
   your own shader, these maps are dead weight.
4. `simplify()` (meshoptimizer) at ~0.4 ratio + `textureCompress()` to WebP
   512 got a 14-character, 610MB raw asset set down to ~16MB with no
   visible quality loss at gameplay camera distance.
5. Write a `src/gen/assets-manifest.ts` from the pipeline run (clip names,
   durations, tri counts, bbox) — avoids hardcoding magic numbers in game
   code and gives you a single place to sanity-check what actually shipped.

**Gotcha**: some characters in a batch may fail auto-rig (non-bipedal
silhouette — no legs, very compact proportions, disguising shape). Don't
block the pipeline on them; route them to a separate "static prop" bucket
(lower poly budget, no skin, no animation) instead of crashing the batch.

---

## 2. Writing your own GLB loader (skip loaders.gl if you need control)

For full control over quantization dequant, WebP textures, and skin data
without runtime deps, a ~250-line hand-rolled GLB parser is entirely
reasonable and faster to debug than fighting a generic loader's assumptions:
- Parse JSON chunk + binary chunk manually (`glTF` magic at offset 0,
  JSON length at offset 12, binary chunk starts at `20 + jsonLen + 8`).
- Dequantize per `KHR_mesh_quantization` component types yourself (the
  accessor's `componentType`/`normalized` flags tell you everything; a
  ~30-line switch over `5120..5126` handles every case seen in practice).
- `EXT_texture_webp`: the texture's `source` lives at
  `tex.extensions.EXT_texture_webp.source`, falling back to `tex.source`.
- For **static** (non-skinned) meshes, bake the node's world matrix
  straight into the vertex positions/normals at load time — one fewer
  matrix multiply per vertex per frame forever, and it lets you batch
  radically different static objects into one instanced draw call by
  mesh+material alone.
- Compute world matrices bottom-up with a memoized per-node resolver
  (`resolve(i) = parent<0 ? local[i] : parent×local[i]`) — trivial and
  avoids assuming array order matches hierarchy order (Meshy exports do
  happen to be parent-before-child, but don't rely on it silently; the
  memoized resolver is correct either way for near-zero extra cost).

---

## 3. GPU skinning: bake to a flat buffer, mix clips in a compute shader

Baking every clip to a fixed frame rate (30Hz here) into one big storage
buffer of `mat4x4f` (already `world × invBind`, i.e. ready-to-use skin
matrices) trades some VRAM for a *huge* simplification: the runtime cost
of "play clip A blended into clip B" becomes a per-instance 4-float state
`(clipA, clipB, tA, tB, blend)`, and a compute shader
(`workgroupSize: [4, 16]` over `(bone, instance)`) does all the sampling
and matrix math. CPU writes 32 bytes per animated instance per frame,
nothing else. This scales to hundreds of independently-animated skinned
enemies at negligible CPU cost.

**Locomotion loop clips need root-motion removal.** If `walk`/`run`/`idle`
clips have translation drift baked into the root bone (typical of mocap or
auto-rig exports), the character will visibly slide/creep during the loop.
Fix at bake time: for clips flagged as looping, clamp the root joint's XZ
translation to its first-frame value for every sampled frame (don't touch
Y — that's often intentional bob).

**Auto-detecting the "real" attack window is worth doing, not guessing.**
The naive approach — hardcode a `[start, end]` fraction of the attack clip
as "the swing" — reliably picks the wrong window for at least a few
characters in any batch of auto-rigged clips, because clip length and
anticipation-to-impact ratio vary per character. This read as "characters
punching/headbutting instead of using their weapon" in playtesting and
took a full pass to properly fix. **Do this from the start instead**:
sample the hand bone's world position per baked frame, compute per-frame
speed, find the peak-speed frame (excluding the first/last ~12% of the
clip to avoid pose-settle noise), then walk outward from the peak while
speed stays above ~22% of peak to get `[start, end]`; the impact/hit-frame
fraction is `(peakFrame - startFrame) / (endFrame - startFrame)`, clamped
to a sane `[0.32, 0.68]` range so it's never at the very edge. Apply a
minimum window width (~22% of clip length) so tiny/instant swings don't
become a single-frame flash. This is ~40 lines and eliminates an entire
class of "combat doesn't read" bug reports.

**Attack readability tuning that mattered in playtesting** (apply these
by default, don't wait for the "it doesn't look right" report):
- Play the **windup/anticipation** portion of the clip during the
  telegraph state, and the **full detected swing window** during the
  actual attack state — don't compress both into the attack state alone,
  it reads as truncated.
- Slow the attack down relative to its authored `attackTime` (×1.3–1.8
  worked well) — mocap/auto-rig swings are often too fast to read at
  arena-game camera distance and zoom.
- Kill any large forward lunge/dash tied to the attack itself; a big body
  lunge reads as "headbutt/charge" and visually drowns out the weapon
  swing regardless of how good the animation is. A small step is fine, a
  2×+ speed dash into the target is not.
- **Give every attacking entity — not just the player — a weapon trail.**
  A skinned swing with no trail is much harder to read than the same swing
  with a colored ribbon following the weapon hand; this was the single
  biggest "why does it feel like they're not using their weapon" fix.
  Anchor the trail to hand-bone world position each frame using the same
  bone-sampling function used for swing detection; a handful of trail
  "slots" (4-5) shared/round-robined across active attackers is enough —
  you don't need one trail per enemy simultaneously.
- Trail visual budget that reads well at a glance: ~0.25-0.3s fade time,
  ~30 ribbon samples, additive blend, a bit of scrolling noise for an
  "energy" feel rather than a flat solid ribbon.

---

## 4. Headless WebGPU verification (no real GPU/display in sandbox)

Chromium + `--use-webgpu-adapter=swiftshader` in headless mode **crashes
the GPU device** (`"A valid external Instance reference no longer exists"`,
surfaces as `device.lost`) the moment you try to **present to a
canvas/configured context**. Confirmed via a matched pair of minimal
repros: an offscreen-only render loop ran 900 clean frames; the identical
loop presenting to a configured canvas lost the device on frame 1, 100%
reproducible. This is a swiftshader/software-rasterizer limitation, not a
bug in your code — don't waste time debugging your own pipeline first.

**Working pattern**: build the app with a `headless` flag that skips
`configureContext`/`getCurrentTexture` entirely and instead exposes a
`capture()` promise plus an explicit `runCapture(encoder)` that renders to
an offscreen `rgba8unorm` texture, `copyTextureToBuffer`s it, and
`mapAsync(GPUMapMode.READ)`s a readback buffer on demand — normal frames
just skip presentation. Wire a `window.__shot()` hook that resolves this
and returns a data URL your test driver can `fs.writeFileSync`.

**`mapAsync` will hang forever if you keep submitting new command buffers
while a previous readback's map is outstanding** — under load (~60fps
submissions), `dst.mapAsync(READ)` after a `queue.submit` never resolved
in testing, even isolated from the rest of the app. Fix: a `busyCapture`
flag that pauses `frame()` from submitting new work while a capture's
`readCapture()` is in flight, cleared in a `.finally()`. This alone turned
"screenshot hook always times out" into "works every time."

**Also do this for realistic throughput**: swiftshader's software raster
can't sustain interactive framerate under a full game's per-frame CPU
cost (physics/AI/instance-buffer writes for hundreds of entities). Gate
actual GPU submission behind `frameNo % N === 0` when in headless mode
(the simulation still steps every tick; only the render submission is
throttled) — otherwise `capture()` requests queue up behind a backlog
that never drains within a reasonable test timeout.

**Minimal verification driver** (works well as a reusable `tools/verify.mjs`):
`playwright-core` launching `/opt/pw-browsers/chromium` (this environment's
preinstalled binary — don't run `playwright install`) with args
`--headless=new --no-sandbox --enable-unsafe-webgpu
--use-webgpu-adapter=swiftshader`, navigate to `?headless=1`, wait for a
`window.__ready` flag (or `window.__bootError` for fast-fail), then drive
input via Playwright's `page.mouse`/`page.keyboard` (these work fine even
headless — `mouse.down/up`, `keyboard.press`, real DOM events) interleaved
with `await page.evaluate('window.__shot()')` calls at the moments you
want to inspect. This is the only reliable way to "see" a WebGPU app in
this sandbox — always verify visually this way before claiming a graphics
change works, screenshots caught multiple regressions (weird rock shapes,
wrong swing timing, over-bright specular) that would have shipped
otherwise. Debug output (`window.__deviceLost`, `console.error` on
`uncapturederror`) on the `GPUDevice` should be wired from the start —
diagnosing the swiftshader-presents-and-dies issue took much longer
without it than it would have with device-lost/uncaptured-error handlers
in place from minute one.

---

## 5. Progressive spawn/difficulty curves

A director that's "correct" per-spec (spawns enemies based on elapsed
time and a budget) can still feel bad if the early-game constant is too
aggressive — first playtest feedback was "way too many enemies
immediately." Formula that read as fair on replay:
```
aliveCap   = min(8 + elapsed * 0.26, 85)        // starts ~8, caps ~85 by ~5min
spawnEvery = max(1.3, 3.0 - elapsed / 130)       // starts ~3s between waves
waveSize   = min(1 + floor(elapsed / 55), 4)     // starts at 1, grows slowly
```
The key property: a low floor at `t=0` (single-digit enemy count, several
seconds between spawns) with a *cap* far enough out that it never feels
exponential/unfair, and all three curves (alive cap, spawn interval, wave
size) ramping independently and slowly rather than one aggressive knob.
When a user says "too aggressive at the start, should ramp up to a limit"
— that's asking for exactly this shape; don't just lower one number,
restructure to have an explicit early floor + late plateau on all the
relevant axes.

---

## 6. Procedural mesh/shader quality bar

- **Low-poly rocks**: a plain icosahedron looks like "a tent," not a rock,
  even flat-shaded. One subdivision pass (12→42 verts) with **per-vertex
  coherent radial displacement** (not per-face random noise, which breaks
  shared-vertex continuity and creates visible seams) plus 1-2 large
  directional "dents" (dot product against a random axis, flatten radius
  where `dot > threshold`) reads as an actual boulder. Squash Y ~0.6× and
  sink the base into the ground plane slightly so it doesn't float.
- **Ground detail**: layer multiple Perlin octaves at different
  frequencies for *different purposes*, not just fractal sum — one octave
  for base color variation, one for dirt-patch masking, one for fine
  texture, one for a completely separate "flowers/pebbles" scatter mask
  gated by `smoothstep` on yet another octave, one for cracks *gated to
  only appear inside dirt patches* (ungated cracks running across grass
  looked wrong — always mask detail layers to the surface type they
  belong on, don't apply globally).

---

## 7. Multi-repo / deploy workflow specifics for this sandbox

- **This environment's Bash permission classifier blocks bulk
  cross-repo file copies** (e.g. `cp -r` from one session-scoped repo into
  another repo's working tree, then `git push`) as a potential
  data-exfiltration pattern, even when the destination is the same user's
  own repo and clearly in-scope for the task. It does **not** block the
  same copy if the user has explicitly authorized that specific
  cross-repo action in the conversation (confirmed via `AskUserQuestion`).
  If a task requires moving generated content into a *different* repo
  than the session started in, get explicit user sign-off on that specific
  move first — don't assume "deploy this" implies "push to any of the
  user's repos I find convenient."
- **Vercel projects imported directly from a repo (via vercel.com/new)
  build any pushed branch automatically**, including a `gh-pages` branch
  that a separate GitHub Actions Pages workflow also maintains — this
  produces a redundant extra Vercel build on every Pages deploy. If both
  Pages and Vercel deploys exist for the same repo, either scope Vercel's
  git integration to `main` only, or note the double-build as an accepted
  cost rather than silently doing extra work to prevent it later.
- **This sandbox's outbound network blocks `vercel.com`/CLI auth**, but
  the Vercel MCP tool set (list_projects/get_project/get_deployment/
  web_fetch_vercel_url/list_deployments) works over the MCP transport
  regardless — use the MCP tools for all Vercel status checks and
  deployment verification instead of shelling out to the `vercel` CLI,
  which will fail to authenticate.
- **After merging a PR whose branch will be reused for the next PR**,
  restart the branch from the merged base (`git fetch origin main &&
  git checkout -B <branch> origin/main`) before making the next round of
  changes, rather than continuing to commit on top of the pre-merge branch
  state and force-pushing — keeps history linear and avoids surprising
  diffs in the next PR.
- **`std.range(n)` inside a TypeGPU `'use gpu'` function requires `n` to be
  compile-time-known.** Passing a value read from a uniform/storage buffer
  (`d.u32(scene.$.someCount)`) throws `"Called comptime function with
  runtime-known values"` at shader resolution time — this is a WGSL-codegen
  constraint, not a bug. Use a plain `for (let i = d.u32(0); i < count;
  i++)` loop instead for any runtime-bounded iteration (light counts,
  particle-request counts, etc.); reserve `std.range`/`tgpu.unroll` for
  genuinely compile-time-fixed counts.

---

## 8. General process notes

- When a user reports "X looks wrong" about something you built but
  haven't visually verified yourself yet (common for anything graphical
  built without a real display), **reproduce it with the headless
  screenshot harness before proposing a fix** — in this project the first
  reported "enemies attack with headbutts" bug turned out to be three
  compounding causes (wrong clip window, no weapon trail, an oversized
  body lunge) that would have taken several guess-and-check round trips
  to find blind; one screenshot of a mid-swing enemy made all three
  obvious at once.
- A minimal DOM-overlay menu (plain CSS + vanilla event listeners, no
  framework) is entirely sufficient for a "pick one of N game
  options up front" screen layered over a WebGPU canvas — don't reach for
  a UI framework for a single one-shot selection screen that disappears
  and never returns; keep it a single self-contained module.
