# Reporte — Modelos 3D generados con Meshy AI

Pipeline aplicado a cada uno de los 17 personajes: **imagen → mesh + remesh a 30,000
polígonos quad + textura PBR (Meshy-6/latest) → rig automático (esqueleto humanoide)
→ animaciones**. Caminar y correr vienen incluidas gratis en el rig; se agregó además
un ataque específico al arma de cada personaje y una animación de muerte.

Créditos totales consumidos: **~670 de 1140** (balance final: 470).

## Personajes completos (14) — mesh + rig + animaciones

| # | Personaje | Arma | Animación de ataque | Archivos |
|---|---|---|---|---|
| 01 | Blanco - cuchillo | knife | Attack | mesh, rigged, walk, run, attack, dead |
| 02 | Cowboy sombrero negro | sword/machete | Charged_Slash | mesh, rigged, walk, run, attack, dead |
| 03 | Cowboy sombrero marrón | cutlass | Left_Slash | mesh, rigged, walk, run, attack, dead |
| 04 | Pirata garfio | cutlass | Sword_Judgment | mesh, rigged, walk, run, attack, dead |
| 05 | Astronauta | wrench | Attack | mesh, rigged, walk, run, attack, dead |
| 06 | Robot | energy baton | Double_Combo_Attack | mesh, rigged, walk, run, attack, dead |
| 07 | Esqueleto reaper | scythe | Reaping_Swing | mesh, rigged, walk, run, attack, dead |
| 08 | Rey | scepter/mace | Heavy_Hammer_Swing | mesh, rigged, walk, run, attack, dead |
| 09 | Agente (traje/corbata) | gun | Side_Shot | mesh, rigged, walk, run, attack, dead |
| 10 | Golem de hielo | ice sword | Charged_Slash | mesh, rigged, walk, run, attack, dead |
| 11 | Slime verde | spiked mace | Heavy_Hammer_Swing | mesh, rigged, walk, run, attack, dead |
| 14 | Tiburón | serrated katana | Sword_Judgment | mesh, rigged, walk, run, attack, dead |
| 15 | Gamer (auriculares) | neon katana | Double_Combo_Attack | mesh, rigged, walk, run, attack, dead |
| 17 | Golem de diamante | spiked mace | Heavy_Hammer_Swing | mesh, rigged, walk, run, attack, dead |

Cada carpeta de estos 14 personajes trae 6 archivos `.glb`:
`_mesh_textured_quad30k.glb` (mesh base sin rig), `_rigged.glb` (personaje riggeado
en T/A-pose), `_anim_walk.glb`, `_anim_run.glb`, `_anim_attack_<nombre>.glb`,
`_anim_dead_Dead.glb`.

## Personajes sin rig (3) — solo mesh estático texturizado

Meshy solo puede riggear automáticamente cuerpos bípedos con brazos/piernas bien
definidos. Estos 3 fallaron la estimación de pose (`422 Pose estimation failed`)
por su forma de cuerpo, y **no tienen animación** — no fue posible generarla
automáticamente ni manualmente (este entorno no tiene Blender u otra herramienta de
animación 3D para riggear/animar a mano):

| # | Personaje | Motivo probable |
|---|---|---|
| 12 | Diablo (tridente) | Proporciones cabeza/torso muy compactas, mala estimación de articulaciones |
| 13 | Plátano (katana) | Traje curvo de banana oculta la silueta de brazos/piernas |
| 16 | Fantasma (linterna) | No tiene piernas (flota) — no es un cuerpo bípedo |

Cada carpeta trae solo `_mesh_textured_quad30k.glb` (mesh completo, texturizado,
remesheado a 30k quad — listo para usar como prop estático o para intentar un rig
manual en Blender más adelante).

## Descarga

Los archivos se entregaron en 4 zips (agrupados por tamaño) + `summary.json` con el
detalle técnico de cada tarea (créditos, ids, animaciones).
