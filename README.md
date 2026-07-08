# Juego .io — Arena WebGPU + assets 3D

> 🎮 **El juego vive en [`game/`](game/)**: arena .io single-player de combate
> cuerpo a cuerpo renderizada con WebGPU + TypeGPU, usando los 14 personajes
> riggeados de este repo como jugables, los 3 sin rig como estatuas y los
> modelos Clash de `Juego-clash-` como enemigos. Controles y detalles técnicos
> en [game/README.md](game/README.md).

# Assets 3D — Personajes con armas (Meshy AI)

Modelos 3D generados a partir de las imágenes en `source_images/` usando la API
de [Meshy AI](https://www.meshy.ai/). Pipeline: **imagen → mesh + remesh a
30,000 polígonos quad + textura PBR (Meshy-6/latest) → rig automático
(esqueleto humanoide) → animaciones**.

Ver `REPORTE.md` para el detalle completo (arma y animación de cada
personaje, créditos consumidos, y los 3 personajes que no se pudieron
riggear por su forma de cuerpo).

## Estructura

- `models/<slug>/` — un GLB crudo (sin optimizar) por etapa, por personaje:
  - `*_mesh_textured_quad30k.glb` — mesh base texturizado, sin rig
  - `*_rigged.glb` — personaje riggeado (T/A-pose)
  - `*_anim_walk.glb`, `*_anim_run.glb` — incluidas gratis por el rig
  - `*_anim_attack_<nombre>.glb` — ataque específico al arma del personaje
  - `*_anim_dead_Dead.glb` — animación de muerte
- `source_images/` — las 17 imágenes originales usadas como input
- `summary.json` — detalle técnico por personaje (ids de tarea, créditos, estados)
- `meshy_pipeline.py` — script usado para generar todo (requiere `MESHY_API_KEY`)

## Nota sobre tamaño

Estos son los GLB **crudos** tal como los devuelve Meshy (610 MB en total,
polígonos sin decimar más allá del remesh a 30k y texturas a resolución
completa). Si se van a usar en un juego web (como `Juego123`), conviene
optimizarlos antes con `gltf-transform` (simplificación de malla, texturas
WebP, cuantización) — así se hizo con los modelos que ya están en ese repo.
