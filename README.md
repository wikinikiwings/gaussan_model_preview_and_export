# Preview 3D + Snapshot — ComfyUI custom node

An alternative to the builtin **SaveGLB** node: an interactive three.js viewport with true
isometric presets, a continuous perspective ↔ reverse-perspective control, and one-click PNG
snapshots. Built for gaussian-splat pipelines (TripoSplat → `SplatToMesh` → this node), but it
works with any GLB mesh.

It also exports its camera as `camera_info`, so the shot you frame by hand can drive
server-side rendering (`RenderSplat`) — including reverse perspective, which is applied by
warping the splat geometry, since no camera parameter can express it.

---

## Why

The builtin SaveGLB preview cannot be aimed: there is no way to snap to a clean isometric
angle, no control over foreshortening, and no way to get a still image out of it. On top of
that, every run writes a GLB to `output`, which piles up — a real nuisance on ephemeral pods.

This node fixes all of that, and adds one thing the builtin viewport can't do at all: negative
foreshortening (reverse perspective), which is useful when a generated model already has
perspective baked into its geometry and you want to straighten it out.

---

## Install

```
ComfyUI/custom_nodes/save3d_snapshot/
```

Copy the folder in and restart ComfyUI. No pip dependencies: three.js (r147, MIT) is vendored
under `web/lib/`, so there is no runtime CDN access.

Requires a ComfyUI recent enough to provide `comfy_api.latest` schemas, `comfy_extras.nodes_save_3d`
and `comfy_extras.nodes_gaussian_splat` — the node reuses their helpers instead of duplicating
the GLB writer and the splat math.

---

## Quick start

1. Add **Preview 3D + Snapshot** (category `3d`).
2. Wire a mesh into `mesh` — e.g. the `mesh` output of `SplatToMesh`.
3. Run the workflow. The model appears in the viewport, framed from the current direction.
4. Aim it: `⟲ / ⟳` for the direction, mouse to orbit/pan/zoom, the **Persp** slider for
   foreshortening.
5. **Save PNG**.

Re-running the workflow keeps your shot. The framing is also stored in the workflow, so it
survives a page reload.

---

## Node reference

### Inputs

| Input | Type | Notes |
|---|---|---|
| `mesh` | Mesh / File3D | Mesh, or any 3D file (glb, gltf, obj, fbx, stl, usdz, ply, splat, spz, ksplat…). Only **glb/gltf** can be previewed; other formats are still written to disk. |
| `filename_prefix` | string | Same semantics as SaveGLB. Also used for PNG snapshots, so they share the prefix and counter. |
| `save_model` | boolean | **Off (default)**: the model goes to the `temp` folder, which ComfyUI clears — nothing accumulates. **On**: written to `output` exactly like SaveGLB. |
| `splat` | Splat *(optional)* | The splat this mesh was reconstructed from. Passed through to the `splat` output, warped when reverse perspective is active. |
| `camera_state` | string *(hidden)* | Machinery: the viewport writes its camera here. Serialized, so the shot travels with the workflow JSON. |

### Outputs

| Output | Type | Notes |
|---|---|---|
| `camera_info` | Load3DCamera | The viewport's camera, ready for `RenderSplat`. On headless/API runs (no UI ever opened) it falls back to an isometric camera fitted to the mesh, so the node still works without a browser. |
| `splat` | Splat | The input splat, warped for reverse perspective while the Persp slider is negative; passed through untouched otherwise. `None` if no splat is wired in. |

### Toolbar

| Control | What it does |
|---|---|
| `⟲ Yaw N° ⟳` | Rotates the view around the vertical axis in 45° steps (8 positions, wraps). Elevation is always the classic isometric 35.264° (arctan 1/√2). Rotating **keeps** the current pan, scale and foreshortening. |
| `Frame` | Resets the composition: centres the model and fits it to the view. |
| `Persp −60…+60°` | Foreshortening. **0°** = orthographic (true isometry), **positive** = perspective with that FOV, **negative** = reverse perspective (far parts render larger). Live: applies to the current view, not just presets. |
| `⟲0` | Snaps the slider back to exactly 0°. |
| `BG` | Transparent (default — the PNG keeps its alpha) or dark background. |
| `📷 Save PNG` | Renders the current view at high resolution (longest side 2048 px), writes it to `output` with the same prefix/counter as the model, and downloads a copy to your device. |
| `Open ↗` | Opens the same high-res PNG in a new browser tab. Nothing is saved anywhere. |
| `⇩ GLB` | Downloads the model file to your device, so you can keep a copy without the server storing one. |

---

## Recipes

### 1. Isometric still of the mesh

```
SplatToMesh ──mesh──▶ Preview 3D + Snapshot
```

Aim, then **Save PNG**. Persp at `0°` gives a mathematically true isometry: orthographic
projection, elevation 35.264°, one of the 8 yaw quadrants.

### 2. Clean splat render from the same angle

Mesh reconstruction bakes hidden and semi-transparent gaussians into vertex colours, which
shows up as dirty blotches. Rendering the **splat** instead avoids this entirely — depth
sorting hides what should be hidden:

```
TripoSplat ──splat──┬─────────────────────▶ RenderSplat ──image──▶ SaveImage
                    │                            ▲
                    └──▶ SplatToMesh ──mesh──▶ Preview 3D + Snapshot
                                                 └──camera_info───┘
```

Frame the shot on the mesh, and `RenderSplat` reproduces exactly that camera on the GPU, at any
resolution, with no browser involved — so this path also works through the API.

### 3. Reverse perspective on a splat

Set the Persp slider negative, and route the splat **through** the node:

```
TripoSplat ──splat──▶ Preview 3D + Snapshot ──splat──▶ RenderSplat  (camera: orthographic)
                              └───────────────camera_info──────────────┘
```

The strength follows the slider automatically. Keep `RenderSplat`'s camera **orthographic** —
the warp already contains the projection.

---

## How it works

**Framing invariant.** Every camera move preserves one quantity: the half-height of the view in
world units at the target plane. That is what makes the Persp slider a dolly zoom (direction,
target and composition stay put while only foreshortening changes), what lets a yaw change
carry the composition over, and what lets the exported camera reproduce the same frame
server-side — the exported distance is normalized to `halfHeight / tan(fov/2)`.

**Reverse perspective, in the viewport.** A camera cannot do this, so the projection matrix is
patched: the `w` row is rebuilt so scale grows with depth. The `z` row has to be solved
together with it — keeping the orthographic `z` row while dividing by a depth-varying `w` flips
the sign of the depth derivative and renders the model inside out. The slope is clamped so the
projection's pole stays outside the clip range.

**Reverse perspective, on splats.** `RenderSplat` builds its projection analytically from
position/orientation/focal length, so there is no matrix to patch and no FOV value that could
express it. The geometry is warped instead, in camera space:

```
w(z) = 1 + (m / half_h) · (dist − z)          # shrinks with depth
x' = x / w(z),   y' = y / w(z),   z' = z      # depth deliberately untouched
```

Splat centres are displaced by this map and every covariance is transformed by its local
Jacobian, then re-extracted into scale + quaternion via `eigh`. Leaving `z` alone keeps the
renderer's depth sorting and occlusion exactly as they were.

**Coordinates.** No conversion happens in this node: `camera_info` is defined in the viewer's
three.js world space (right-handed, Y-up), and `RenderSplat` maps it into the splat frame
itself. The orbit convention matches the builtin `CreateCameraInfo` formula exactly
(`position = target + (cos p·sin y, sin p, cos p·cos y)·d`).

---

## Gotchas

- **Aspect.** `RenderSplat` derives its focal length from the **smaller** image axis, while the
  viewport's invariant is vertical. Framing therefore matches exactly when
  `width ≥ height`; portrait renders need an aspect correction.
- **Preview formats.** The viewport renders glb/gltf. Other formats are saved but not shown.
- **Batches.** All meshes in a batch are written; the first one is previewed.
- **Empty until a run.** The viewport has nothing to show until the workflow executes; the
  camera is restored from the workflow, the geometry is not.
- **Reverse perspective is mesh + splat only.** It is not expressible in `camera_info`, so a
  negative slider value is exported as `orthographic`. Rendering a *mesh* server-side would not
  see it either.
- **`temp` is ephemeral.** With `save_model` off, the model is gone after ComfyUI clears temp.
  Use `⇩ GLB`, or turn `save_model` on.

---

## Deployment notes (RunPod and similar)

All 3D rendering happens in the **client's browser** via WebGL — the pod needs no display, no
EGL, and no GPU time for the viewport. three.js is vendored, so the pod needs no internet
access to serve it. Model loading uses the standard `/view` route, and the JS is served from the
standard `/extensions` route, so both work over the RunPod HTTP proxy like the rest of the UI.

Two things to keep in mind:

- The node registers `POST /save3d_snapshot/save_png`. It is same-origin with the UI, but if
  anything in front of ComfyUI whitelists routes, that path has to be allowed — otherwise every
  button works except **Save PNG**.
- The pod's filesystem is ephemeral. PNG snapshots are downloaded to your device as well as
  written to `output`, so a copy always survives; models need `⇩ GLB` or a mounted volume.

For baked images, cloning this repository into `custom_nodes/` in the Dockerfile is enough — the
node has no build step and no pip dependencies.

---

## Development

`_selftest_reverse.py` (git-ignored) checks the reverse-perspective warp against the analytic
formula on a synthetic splat batch: magnification per depth, depth preservation, shape
preservation, finiteness.

```
python custom_nodes/save3d_snapshot/_selftest_reverse.py
```

Run it with the interpreter ComfyUI itself uses — it imports torch and the builtin splat
helpers.
