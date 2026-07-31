# Save 3D Model (Snapshot) — ComfyUI custom node

Alternative to the builtin **SaveGLB** node with an own three.js viewport and PNG snapshot tooling.
Built for gaussian-splat pipelines (e.g. TripoSplat → `SplatToMesh` → this node), works with any GLB mesh.

## Features

- Saves the input mesh / 3D file to the output folder exactly like the builtin SaveGLB
  (same helpers, same filename prefix + counter).
- Own interactive viewport (three.js, OrbitControls) that stretches with the node.
- **8 isometric presets** — 4 yaw quadrants (45°/135°/225°/315°) × view from above/below,
  true isometry: orthographic projection, elevation ±35.264° (arctan 1/√2), auto-framed
  to the model bounding sphere.
- **Perspective** reset (3/4 view).
- **Save PNG** — renders the current view at high resolution (longest side 2048 px) and
  stores it into the ComfyUI output folder with the same prefix/counter as the GLB.
- **BG toggle** — dark or transparent background (PNG keeps alpha).
- **⇩ DL toggle** — additionally download the PNG to the user's device via the browser,
  with the same filename the server assigned.

## Install

Copy the folder into `ComfyUI/custom_nodes/` and restart ComfyUI:

```
custom_nodes/save3d_snapshot/
```

three.js (r147, MIT license) is vendored under `web/lib/` — no runtime CDN dependency.

## Usage

Add **Save 3D Model (Snapshot)** (category `3d`), feed it a mesh (e.g. the `mesh` output
of `SplatToMesh`), run the workflow. The model loads into the viewport; pick an isometric
preset or orbit freely, then hit **Save PNG**.

## Notes / limitations

- Viewport preview supports **glb/gltf** input. Other formats (obj/stl/splat/…) are still
  saved to disk, but not previewed.
- For a mesh batch the first item is previewed (all items are saved).
- The viewport is empty after a page reload until the next workflow run.
- PNG saving endpoint: `POST /save3d_snapshot/save_png` (path-validated inside the
  ComfyUI output directory).
