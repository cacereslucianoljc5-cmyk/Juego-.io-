# ⚔️ Arena.io — juego .io single-player en WebGPU + TypeGPU

Arena de combate cuerpo a cuerpo estilo **.io** (Vampire Survivors × Brawl
Stars × Brotato) para navegador, renderizada 100% con **WebGPU** a través de
**[TypeGPU](https://typegpu.com)** — los shaders están escritos en TypeScript
(`'use gpu'`) y se transpilan a WGSL con `unplugin-typegpu`.

Un único menú minimalista al inicio para elegir personaje; después no hay
HUD ni pausas: solo gameplay y gráficos.

## Controles

| Input | Acción |
|---|---|
| **WASD / flechas** | moverse |
| **Ratón** | apuntar |
| **Clic izquierdo** (mantener = auto) | ataque |
| **Clic derecho** | ataque pesado cargado (giro 360°) |
| **Espacio / Shift** | dash con i-frames y afterimages |
| **1–9, 0** | elegir personaje directo |
| **Tab / E / Q** | ciclar personaje |
| **Rueda** | zoom |

## Los 14 personajes

Modelos riggeados del propio repo (generados con Meshy a partir de
`source_images/`), cada uno con su arma cuerpo a cuerpo, sus animaciones y su
**firma de combate**: Cuchillo (chispas + crits), Machete (quemaduras), Sable
(golpe dorado cada 4 hits), Alfanje (marea que empuja), Llave Inglesa,
Bastón Energético (relámpago en cadena), Guadaña (roba vida al matar), Cetro
Real, Bastón Táctico (backstabs), Lanza de Hielo (congela), Maza Espinada
(baba ralentizante), Hoja Dentada (sangrado), Katana Neón (nova al acumular 8
golpes) y Maza Cristalina (nova de esquirlas en crit).

Los 3 personajes sin rig (diablo, banana, fantasma) aparecen como **estatuas**
decorativas de la arena.

## Enemigos

**El resto del elenco te caza.** Elegís un personaje y los otros 13 aparecen
en oleadas continuas como enemigos, cada uno luchando con su propia arma
(alcance, arco, daño, color y telegraph derivados de su definición) y con su
esqueleto animado completo en GPU: caminan/corren al perseguirte, lanzan su
clip de ataque con anticipación telegrafiada y caen con su animación de
muerte. Con el tiempo aparecen **élites doradas** con más vida. No hay jefes:
la presión viene del número y de la variedad de armas.

## Técnica (todo GPU-first)

- **Animación esquelética en GPU**: los clips se hornean a 30 Hz en un storage
  buffer y un **compute shader** mezcla dos clips por instancia y escribe las
  paletas de huesos; el vertex shader aplica 4 influencias. El CPU solo escribe
  `(clipA, clipB, tA, tB, blend)` por instancia.
- **Partículas por compute**: pool de 32k en ring buffer, emisión y simulación
  (gravedad, drag, turbulencia perlin, rebote, atracción de almas) en GPU,
  render instanciado con atlas procedural y blending premultiplicado (aditivo
  y alfa en un solo draw).
- **Iluminación**: sol + hemisferio + hasta 24 luces puntuales dinámicas
  (los impactos, explosiones y cristales iluminan de verdad), rim fresnel,
  especular toon, **shadow map** 2048 con PCF.
- **Suelo y muro procedurales** en WGSL (perlin de @typegpu/noise): praderas,
  grid .io, emblema central animado, banda de peligro y muro de energía.
- **Post HDR**: bloom de 5 niveles, tonemap ACES, viñeta, pulso de daño,
  distorsión radial de shockwave, aberración cromática y grano.
- **Juice**: hit-stop, impact frames, screen shake por trauma, kicks de
  cámara, knockback, slow-mo en muertes de boss, dissolve con borde
  incandescente, afterimages de dash, números de daño en mundo, telegraphs
  SDF (círculo/sector/línea) y weapon trails con ruido.
- **Rendimiento**: ECS-lite SoA con typed arrays, spatial hash para la horda,
  instancing en todos los draws (~25 draw calls por frame), object pooling
  total (cero allocs en el hot path). ~0.3 ms de CPU por frame.

## Desarrollo

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc + vite build → dist/
npm run assets     # regenera los GLB optimizados desde ../models
```

### Verificación headless

Chromium + swiftshader no soporta presentar al canvas (crashea el device),
así que `?headless=1` renderiza offscreen y `window.__shot()` devuelve un
screenshot por readback:

```bash
npx vite --port 5173 &
node tools/verify.mjs capturas/
```
