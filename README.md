# Save 3D Model (Snapshot) — ComfyUI custom node

Alternative to the builtin **SaveGLB** node with an own three.js viewport and PNG snapshot tooling.
Built for gaussian-splat pipelines (e.g. TripoSplat → `SplatToMesh` → this node), works with any GLB mesh.

## Features

- Saves the input mesh / 3D file to the output folder exactly like the builtin SaveGLB
  (same helpers, same filename prefix + counter).
- Own interactive viewport (three.js, OrbitControls) that stretches with the node.
- **8 view-direction presets** — 4 yaw quadrants (45°/135°/225°/315°) × view from above/below,
  elevation ±35.264° (arctan 1/√2), auto-framed to the model bounding sphere.
- **Perspective foreshortening slider (0–60°)** — 0° is a true orthographic isometry,
  higher values switch to a perspective projection with that FOV. Works live on the
  current view with dolly-zoom compensation, so direction, target and framing stay put
  while only the foreshortening changes.
- **Save PNG** — renders the current view at high resolution (longest side 2048 px),
  stores it into the ComfyUI output folder with the same prefix/counter as the GLB and
  downloads a copy to the user's device with the same filename.
- **BG toggle** — transparent (default, PNG keeps alpha) or dark background.
- **`camera_info` output** — the viewport reports its camera (three.js world space, distance
  normalized to the framing invariant) into a hidden serialized widget, so the shot survives
  page reloads, travels with the workflow JSON and can drive server-side rendering. Headless
  runs fall back to an isometric camera fitted to the mesh.

## Reverse perspective for the splat

The node has an optional `splat` input and a matching `splat` output. Reverse perspective
cannot be expressed through camera parameters — `RenderSplat` derives its projection
analytically from position/orientation/focal length — so while the Persp slider sits in the
negative half the node warps the splat geometry instead: centres are displaced by
`x' = x / w(z)`, `w(z) = 1 + (m / half_h) * (dist - z)`, and every covariance is transformed
by the local Jacobian of that warp (re-extracted into scale + quaternion via `eigh`). Depth
is deliberately left untouched, so the renderer's sorting and occlusion stay correct.

Wiring: `splat` → this node's `splat` input, then its `splat` output → `RenderSplat`, with the
node's `camera_info` feeding `RenderSplat` as well and that camera kept **orthographic**. The
warp only runs when a splat is wired in and the slider asks for it. With the slider at 0 or
positive the splat passes through untouched — an ordinary perspective FOV is something the
splat renderer handles natively.

## Install

Copy the folder into `ComfyUI/custom_nodes/` and restart ComfyUI:

```
custom_nodes/save3d_snapshot/
```

three.js (r147, MIT license) is vendored under `web/lib/` — no runtime CDN dependency.

## Usage

Add **Save 3D Model (Snapshot)** (category `3d`), feed it a mesh (e.g. the `mesh` output
of `SplatToMesh`), run the workflow. The model loads into the viewport already framed
from the selected direction preset; orbit freely, dial in the foreshortening, then hit
**Save PNG**.

## Notes / limitations

- Viewport preview supports **glb/gltf** input. Other formats (obj/stl/splat/…) are still
  saved to disk, but not previewed.
- For a mesh batch the first item is previewed (all items are saved).
- The viewport is empty after a page reload until the next workflow run.
- PNG saving endpoint: `POST /save3d_snapshot/save_png` (path-validated inside the
  ComfyUI output directory).
