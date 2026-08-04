"""Reverse perspective for gaussian splats.

RenderSplat builds its projection analytically from position/orientation/focal length, so
there is no matrix to override the way the mesh viewport does it. Instead of patching the
rasterizer, this node warps the splat cloud itself: splat centres are displaced and their
covariances are transformed by the local Jacobian of the warp, so that an ORTHOGRAPHIC
render from the same camera comes out in reverse perspective.

The warp, in camera space (x right, y up, z depth, positive in front of the camera):

    w(z) = 1 + (m / half_h) * (dist - z)        # shrinks with depth
    x' = x / w(z),  y' = y / w(z),  z' = z      # depth deliberately untouched

Because 1/w grows with depth, parts further from the camera are magnified - the reverse of
ordinary foreshortening - which is what compensates perspective already baked into a
generated model. Leaving z alone keeps the renderer's depth sorting and occlusion exactly
as they were, which is the same trick the mesh viewport uses (there, the z-row of the
projection matrix is solved separately from the w-row for the same reason).
"""

import math

import torch
from comfy_api.latest import IO, Types

# Reused from the builtin splat nodes: camera basis + quaternion/matrix helpers. Same
# approach as reusing save_glb for the GLB writer - no duplicated math, one source of truth.
from comfy_extras.nodes_gaussian_splat import _camera_basis, _mat_to_quat, _quat_to_mat


class SplatReversePerspective(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SplatReversePerspective",
            display_name="Reverse Perspective (Splat)",
            search_aliases=["reverse perspective", "inverse perspective", "unforeshorten",
                            "splat warp", "byzantine perspective"],
            category="3d/splat",
            description="Warps a gaussian splat so that an ORTHOGRAPHIC render from the given camera "
                        "shows reverse perspective: parts further away are magnified, cancelling "
                        "foreshortening baked into the model. Depth is left untouched, so occlusion "
                        "stays correct. Feed the same camera_info to this node and to RenderSplat, "
                        "and keep RenderSplat's camera orthographic.",
            inputs=[
                IO.Splat.Input("splat"),
                IO.Load3DCamera.Input("camera_info"),
                IO.Float.Input("amount", default=0.0, min=0.0, max=60.0, step=1.0,
                               tooltip="Strength in degrees, mirroring the negative half of the "
                                       "viewport's Persp slider. 0 = use the value reported by the "
                                       "viewport in camera_info (no-op when there is none)."),
            ],
            outputs=[IO.Splat.Output(display_name="splat")],
        )

    @classmethod
    def execute(cls, splat, camera_info, amount: float = 0.0) -> IO.NodeOutput:
        if amount <= 0.0:  # 0 = follow the viewport's slider, passed along in camera_info
            amount = float(camera_info.get("reversePerspective", 0.0) or 0.0)
        if amount <= 0.0:
            return IO.NodeOutput(splat)

        pos = splat.positions
        dev, dt = pos.device, pos.dtype
        eye, target, right, up, fwd = _camera_basis(camera_info, dev)
        W = torch.stack([right, up, fwd], 0).to(dt)   # rows = camera axes (world -> camera)
        eye, target = eye.to(dt), target.to(dt)
        cam = (pos - eye) @ W.T
        x, y, z = cam.unbind(-1)

        dist = float((target - eye).norm().clamp_min(1e-6))
        fov = float(camera_info.get("fov", 35.0) or 35.0)
        zoom = float(camera_info.get("zoom", 1.0) or 1.0)
        # World half-extent of the frame at the target plane over the image's smaller axis:
        # RenderSplat uses f = (min(w,h)/2)/tan(fov/2)*zoom and, for orthographic, s = f/dist.
        half_h = dist * math.tan(math.radians(fov) / 2) / max(zoom, 1e-6)

        m = math.tan(math.radians(amount) / 2)
        # Clamp the slope so the pole (w = 0) stays behind the furthest splat: without this,
        # splats near the pole blow up and the ones past it turn inside out.
        z_max = float(z.max().clamp_min(dist)) if z.numel() else dist
        m = min(m, 0.85 * half_h / max(z_max - dist, 1e-6))
        g = m / half_h

        w = (1.0 + g * (dist - z)).clamp_min(0.15)
        inv_w = 1.0 / w
        positions = torch.stack([x * inv_w, y * inv_w, z], -1) @ W + eye

        # Sigma' = J Sigma J^T with the warp's local Jacobian
        #   J = [[1/w, 0, x*g/w^2], [0, 1/w, y*g/w^2], [0, 0, 1]]
        n = pos.shape[0]
        J = torch.zeros(n, 3, 3, device=dev, dtype=dt)
        J[:, 0, 0] = inv_w
        J[:, 1, 1] = inv_w
        J[:, 2, 2] = 1.0
        J[:, 0, 2] = x * g * inv_w.square()
        J[:, 1, 2] = y * g * inv_w.square()

        rg = _quat_to_mat(splat.rotations.reshape(-1, 4))          # (N,3,3) per-splat axes
        s2 = splat.scales.reshape(-1, 3).square()
        cov = (rg * s2[:, None, :]) @ rg.transpose(-1, -2)         # world-space Sigma
        cov = W @ cov @ W.T                                        # -> camera space
        cov = J @ cov @ J.transpose(-1, -2)                        # warp
        cov = W.T @ cov @ W                                        # -> back to world
        cov = 0.5 * (cov + cov.transpose(-1, -2))                  # exactly symmetric for eigh
        lam, V = torch.linalg.eigh(cov)
        V = V * torch.where(torch.linalg.det(V) < 0, -1.0, 1.0)[..., None, None]  # proper rotation
        scales = lam.clamp_min(1e-12).sqrt().reshape(splat.scales.shape)
        rotations = _mat_to_quat(V).reshape(splat.rotations.shape)

        out = Types.SPLAT(positions, scales, rotations, splat.opacities, splat.sh,
                          counts=getattr(splat, "counts", None))
        return IO.NodeOutput(out)
