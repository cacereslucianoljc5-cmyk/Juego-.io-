# Cómo cambiar los modelos 3D

Guía práctica para reemplazar o añadir personajes/estatuas sin tocar el
código del motor. Nada de esto borra ni modifica lógica de juego — solo
cambia qué mallas/texturas/clips consume.

## Dónde vive cada cosa

```
models/<slug>/                     ← GLB crudos (fuente, sin optimizar; NO se suben al bundle)
  <slug>_rigged.glb                   T-pose riggeado (base: mesh + esqueleto)
  <slug>_anim_walk.glb                clip de caminar
  <slug>_anim_run.glb                 clip de correr
  <slug>_anim_attack_<Nombre>.glb     clip de ataque (el nombre del archivo no importa)
  <slug>_anim_dead_<Nombre>.glb       clip de muerte
  <slug>_anim_idle_<Nombre>.glb       clip de idle (opcional)
  <slug>_anim_hit_<Nombre>.glb        clip de reacción al golpe (opcional, no usado hoy)
  <slug>_mesh_textured_quad30k.glb    mesh sin rig (para las 3 estatuas)

game/tools/prepare-assets.mjs      ← script que fusiona/optimiza todo lo de arriba
game/public/assets/chars/<slug>.glb   ← salida: 1 GLB por personaje, listo para el juego
game/public/assets/props/<slug>.glb   ← salida: 1 GLB por estatua
game/src/gen/assets-manifest.ts    ← metadata generada (clips, tris, altura) — no editar a mano
game/src/game/defs.ts              ← CHARACTERS[]: arma, stats y estilo de cada slug jugable
```

## Reemplazar el modelo de un personaje existente

1. Sustituye los archivos en `models/<slug>/` por los tuyos, **manteniendo
   los mismos nombres de archivo** (o ajusta los patrones en
   `prepare-assets.mjs` si cambian). El único requisito duro:
   - `<slug>_rigged.glb` debe tener un esqueleto (`skin`) con nombres de
     hueso reconocibles como mano/antebrazo — el motor detecta la mano
     derecha buscando `/right.*hand|hand.*r\b|RightHand/i` y si no
     encuentra nada cae a `/hand/i` (ver `game/src/gfx/animBake.ts:76-81`).
     Si tu rig usa otra convención de nombres, edita ese patrón.
   - Cada clip de animación (`_anim_walk`, `_anim_attack`, etc.) debe
     **compartir los mismos nombres de nodo del esqueleto** que
     `_rigged.glb` — la fusión de clips los empareja por nombre, no por
     índice (`copyAnimation()` en `prepare-assets.mjs`).
2. Corre el pipeline:
   ```bash
   cd game
   npm run assets      # = node tools/prepare-assets.mjs
   ```
   Esto regenera `public/assets/chars/<slug>.glb` y
   `src/gen/assets-manifest.ts` para **todos** los slugs listados en
   `CHARACTERS`/`STATUES` dentro de `prepare-assets.mjs` (arriba del
   archivo). Tarda unos segundos por personaje.
3. Prueba: `npm run dev` y elige ese personaje en el menú, o pulsa su
   tecla en juego (1-9/0). El motor detecta solo la duración de cada clip
   y **la ventana real del golpe** (analiza la velocidad del hueso de la
   mano — ver la skill `webgpu-arena-game` para el detalle); no hace
   falta ajustar nada más a mano salvo que el golpe se vea raro, en cuyo
   caso el ajuste fino está en `CharacterDef.animWindow` /
   `Player.attackClipName` de `src/game/player.ts` como último recurso.

## Añadir un personaje nuevo (slug nuevo)

1. Crea `models/<nuevo_slug>/` con los mismos archivos que un personaje
   existente (ver arriba).
2. Añade el slug al array `CHARACTERS` (si es jugable/enemigo) o
   `STATUES` (si es solo decorativo, sin rig) en
   **`game/tools/prepare-assets.mjs`** — es el pipeline el que decide qué
   carpetas procesar, no el juego.
3. Corre `npm run assets`.
4. Si es jugable, añade su entrada en **`game/src/game/defs.ts`**
   (`CHARACTERS[]`): nombre mostrado, velocidad, escala, arma (alcance,
   arco, daño, color del trail, `signature` — el efecto especial de
   combate) y `animWindow` (fallback si la autodetección falla). Copia
   una entrada existente como plantilla; los campos están comentados ahí
   mismo. El personaje aparece automáticamente en el menú y como posible
   enemigo — no hay que tocar el menú (`src/game/menu.ts`) ni el
   spawner (`src/game/enemies.ts`), ambos leen `CHARACTERS` en vivo.

## Cambiar una estatua (los 3 personajes sin rig)

Mismo proceso, pero usan `<slug>_mesh_textured_quad30k.glb` (sin
esqueleto) y se listan en `STATUES` dentro de `prepare-assets.mjs`. Se
colocan automáticamente en la arena por `game/src/game/world.ts` — si
cambias cuántas hay, ajusta el array `STATUES` de ese archivo también
(posiciones fijas, no generadas desde el manifest).

## Notas de rendimiento

- `optimize()` en `prepare-assets.mjs` controla la calidad de salida:
  `ratio` (0-1, cuánta malla se conserva tras `simplify()`), `texSize`
  (resolución WebP) y `quality` (compresión WebP). Los valores actuales
  (`ratio: 0.42, texSize: 512` para personajes; `0.28, 384` para
  estatuas) dan ~1-1.3 MB por personaje. Si tu modelo es mucho más
  detallado o pesado, baja `ratio`/`texSize` antes de commitear — el
  bundle entero se descarga en el navegador del jugador.
- El script **descarta** `emissiveTexture`, `metallicRoughnessTexture`,
  `normalTexture` y `occlusionTexture` de todos los materiales
  (`stripExtraMaps()`) — el motor ilumina con su propio shader
  (`src/gfx/shading.ts`) y esos mapas no se usan. Solo se conserva
  `baseColorTexture`. Si tu material depende de un normal map para verse
  bien, tendrás que adaptar el shader, no solo el asset.

## Qué NO tocar sin querer

- `src/gen/assets-manifest.ts` se sobreescribe en cada `npm run assets`
  — cualquier edición manual se pierde.
- Los GLB en `public/assets/` son la salida del pipeline, no la fuente;
  no los edites a mano, edita `models/` y vuelve a correr el script.
