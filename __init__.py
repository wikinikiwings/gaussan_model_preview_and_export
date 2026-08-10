"""Save 3D Model (Snapshot) - alternative to the builtin SaveGLB node.

Adds an own three.js viewport widget with:
  * an "Isometric" camera preset button (true orthographic isometry),
  * a "Save PNG" button that snapshots the viewport and stores the PNG
    into the ComfyUI output folder next to the saved GLB (same prefix/counter).

The GLB saving logic is reused from comfy_extras.nodes_save_3d (SaveGLB).
"""

import base64
import json
import logging
import math
import os
import random

from typing_extensions import override

import folder_paths
import numpy as np
from aiohttp import web
from comfy.cli_args import args
from comfy_api.latest import ComfyExtension, IO, Types
from comfy_extras.nodes_save_3d import get_mesh_batch_item, save_glb
from PIL import Image
from server import PromptServer

from .render_splat_fixed import RenderSplatFixed
from .reverse_perspective import warp_splat_reverse_perspective

WEB_DIRECTORY = "./web"

ISO_ELEV_DEG = 35.264389682754654  # atan(1/sqrt(2)): classic isometric elevation
DEFAULT_FOV = 35.0


def _xyz(d, default=(0.0, 0.0, 0.0)):
    if not isinstance(d, dict):
        d = {}
    return {"x": float(d.get("x", default[0])),
            "y": float(d.get("y", default[1])),
            "z": float(d.get("z", default[2]))}


def _fallback_camera_info(mesh):
    """Isometric camera framing the mesh, for runs where the viewport never reported one
    (API / headless). Same convention as the JS viewport: yaw 45 deg, elevation
    atan(1/sqrt2), orthographic, fitted to the bounding sphere. No quaternion is emitted -
    RenderSplat derives a roll-free basis from position/target in that case.
    """
    center = [0.0, 0.0, 0.0]
    radius = 1.0
    verts = getattr(mesh, "vertices", None)
    try:
        if verts is not None and verts.numel():
            v = verts.reshape(-1, 3).float()
            lo, hi = v.amin(dim=0), v.amax(dim=0)
            c = (lo + hi) / 2
            center = [float(c[0]), float(c[1]), float(c[2])]
            radius = max(float((hi - lo).norm() / 2), 1e-6)
    except Exception:  # noqa: BLE001 - bounds are a convenience, never fatal
        logging.debug("SaveGLBSnapshot: could not derive mesh bounds for the default camera")
    half_h = radius * 1.15
    # Same eye-outside-the-model safety as the viewport export: distance is free for an
    # orthographic camera as long as zoom compensates (halfExtent = dist*tan(fov/2)/zoom).
    dist = max(half_h / math.tan(math.radians(DEFAULT_FOV / 2)), radius * 4)
    zoom = dist * math.tan(math.radians(DEFAULT_FOV / 2)) / max(half_h, 1e-9)
    yaw, elev = math.radians(45.0), math.radians(ISO_ELEV_DEG)
    d = [math.cos(elev) * math.sin(yaw), math.sin(elev), math.cos(elev) * math.cos(yaw)]
    return {
        "position": {"x": center[0] + d[0] * dist,
                     "y": center[1] + d[1] * dist,
                     "z": center[2] + d[2] * dist},
        "target": {"x": center[0], "y": center[1], "z": center[2]},
        "fov": DEFAULT_FOV, "cameraType": "orthographic", "zoom": zoom,
    }


def _camera_info_from_state(camera_state: str, mesh):
    """Convert the viewport's reported camera (JSON from the JS widget) into a camera_info
    dict for RenderSplat. Coordinates need no conversion: camera_info is in the viewer's
    three.js world space (right-handed, Y-up) and RenderSplat maps it to the splat frame
    itself. The viewport keeps the framing invariant, so `position` already sits at
    distance halfHeight / tan(fov/2) from the target.
    """
    if camera_state:
        try:
            s = json.loads(camera_state)
            info = {
                "position": _xyz(s.get("position")),
                "target": _xyz(s.get("target")),
                "fov": float(s.get("fov", DEFAULT_FOV)),
                "cameraType": ("orthographic" if str(s.get("cameraType")) == "orthographic"
                               else "perspective"),
                "zoom": float(s.get("zoom") or 1.0),
            }
            # Non-standard extra, ignored by RenderSplat: the strength of the viewport's
            # reverse perspective, so SplatReversePerspective can follow the slider.
            reverse = float(s.get("reversePerspective") or 0.0)
            if reverse > 0.0:
                info["reversePerspective"] = reverse
            q = s.get("quaternion")
            if isinstance(q, dict):
                info["quaternion"] = {"x": float(q.get("x", 0.0)), "y": float(q.get("y", 0.0)),
                                      "z": float(q.get("z", 0.0)), "w": float(q.get("w", 1.0))}
            logging.info("SaveGLBSnapshot camera_info: %s", json.dumps(info))
            return info
        except Exception:  # noqa: BLE001
            logging.exception("SaveGLBSnapshot: unusable camera_state, using the default isometric camera")
    return _fallback_camera_info(mesh)


SPLAT_OUTPUT_SLOT = 1  # outputs are [camera_info, splat]


def _splat_output_is_consumed(prompt, unique_id) -> bool:
    """True if any node in the prompt takes its input from this node's splat output.
    Links in a prompt look like {"inputs": {"splat": [source_node_id, source_slot]}}.
    """
    if not prompt or unique_id is None:
        return False
    me = str(unique_id)
    try:
        for node in prompt.values():
            for link in (node.get("inputs") or {}).values():
                if (isinstance(link, (list, tuple)) and len(link) == 2
                        and str(link[0]) == me and int(link[1]) == SPLAT_OUTPUT_SLOT):
                    return True
    except Exception:  # noqa: BLE001 - a diagnostic must never break execution
        logging.debug("SaveGLBSnapshot: could not inspect the prompt for splat consumers")
    return False


class SaveGLBSnapshot(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SaveGLBSnapshot",
            display_name="Preview 3D + Snapshot",
            search_aliases=["preview 3d snapshot", "save glb snapshot", "isometric png", "3d snapshot"],
            category="3d",
            description="Shows the mesh in a viewport with isometric presets, a perspective/reverse-perspective "
                        "slider and a PNG snapshot button. The model itself goes to the temp folder by default "
                        "(nothing accumulates on disk; use the viewport's GLB button to keep a copy locally) - "
                        "switch save_model on to write it to the output folder like SaveGLB does.",
            is_output_node=True,
            inputs=[
                IO.MultiType.Input(
                    IO.Mesh.Input("mesh"),
                    types=[
                        IO.File3DGLB,
                        IO.File3DGLTF,
                        IO.File3DOBJ,
                        IO.File3DFBX,
                        IO.File3DSTL,
                        IO.File3DUSDZ,
                        IO.File3DPLY,
                        IO.File3DSPLAT,
                        IO.File3DSPZ,
                        IO.File3DKSPLAT,
                        IO.File3DSplatAny,
                        IO.File3DPointCloudAny,
                        IO.File3DAny,
                    ],
                    tooltip="Mesh or 3D file to save",
                ),
                IO.String.Input("filename_prefix", default="3d/ComfyUI"),
                IO.Boolean.Input("save_model", default=False,
                                 tooltip="Off: the GLB is only written to the temp folder, which ComfyUI "
                                         "clears - the viewport still shows it, and its GLB button downloads "
                                         "a copy to your device. On: the GLB is written to the output folder "
                                         "like SaveGLB. PNG snapshots always go to the output folder."),
                IO.String.Input("camera_state", default="",
                                tooltip="Camera of the node's viewport, filled in automatically by its UI "
                                        "(hidden). Drives the camera_info output; when empty a default "
                                        "isometric camera fitted to the mesh is used."),
                IO.Splat.Input("splat", optional=True,
                               tooltip="Optional: the splat this mesh was reconstructed from. It is passed "
                                       "through to the splat output, warped for reverse perspective while "
                                       "the viewport's Persp slider sits in the negative half (no camera "
                                       "parameter can express that, so the geometry is warped instead). "
                                       "Render it with the same camera_info, kept orthographic."),
            ],
            outputs=[IO.Load3DCamera.Output(display_name="camera_info"),
                     IO.Splat.Output(display_name="splat")],
            hidden=[IO.Hidden.prompt, IO.Hidden.extra_pnginfo, IO.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, mesh: Types.MESH | Types.File3D, filename_prefix: str, save_model: bool = False,
                camera_state: str = "", splat=None) -> IO.NodeOutput:
        # Preview by default: the model goes to temp (cleared by ComfyUI) so runs do not pile
        # up on disk, which matters on ephemeral pods. A random token keeps concurrent/
        # repeated runs from colliding there, the same trick PreviewImage uses.
        if save_model:
            base_dir, file_type = folder_paths.get_output_directory(), "output"
        else:
            base_dir, file_type = folder_paths.get_temp_directory(), "temp"
            filename_prefix += "_temp_" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz")
                                                  for _ in range(5))
        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(
            filename_prefix, base_dir)
        results = []

        metadata = {}
        if not args.disable_metadata:
            if cls.hidden.prompt is not None:
                metadata["prompt"] = json.dumps(cls.hidden.prompt)
            if cls.hidden.extra_pnginfo is not None:
                for x in cls.hidden.extra_pnginfo:
                    metadata[x] = json.dumps(cls.hidden.extra_pnginfo[x])

        if isinstance(mesh, Types.File3D):
            ext = mesh.format or "glb"
            f = f"{filename}_{counter:05}_.{ext}"
            mesh.save_to(os.path.join(full_output_folder, f))
            results.append({"filename": f, "subfolder": subfolder, "type": file_type})
            counter += 1
        else:
            texture_b = getattr(mesh, "texture", None)
            texture_np = None
            if texture_b is not None:
                texture_np = (texture_b.clamp(0.0, 1.0).cpu().numpy() * 255).astype(np.uint8)
                assert texture_np.ndim == 4 and texture_np.shape[-1] == 3, (
                    f"texture must be (B, H, W, 3) RGB, got shape {tuple(texture_np.shape)}"
                )
            for i in range(mesh.vertices.shape[0]):
                vertices_i, faces_i, v_colors, uvs_i = get_mesh_batch_item(mesh, i)
                if vertices_i.shape[0] == 0 or faces_i.shape[0] == 0:
                    logging.warning(f"SaveGLBSnapshot: skipping empty mesh at batch index {i}")
                    continue
                tex_img = Image.fromarray(texture_np[i], mode="RGB") if texture_np is not None else None
                f = f"{filename}_{counter:05}_.glb"
                save_glb(vertices_i, faces_i, os.path.join(full_output_folder, f), metadata,
                         uvs=uvs_i,
                         vertex_colors=v_colors,
                         texture_image=tex_img,
                         unlit=getattr(mesh, "unlit", False))
                results.append({"filename": f, "subfolder": subfolder, "type": file_type})
                counter += 1
        cam_info = _camera_info_from_state(camera_state, mesh)
        # Reverse perspective cannot be expressed through camera parameters, so when the
        # viewport's slider is negative the splat geometry itself is warped instead. Only
        # done when a splat is actually wired in and the slider asks for it - the warp is
        # an eigh over every gaussian, not something to run on every save.
        if splat is None:
            # Nothing to pass through. If something downstream consumes the splat output it
            # would fail on a None with a confusing traceback, so say what is wrong here.
            if _splat_output_is_consumed(cls.hidden.prompt, cls.hidden.unique_id):
                raise ValueError(
                    "The 'splat' output of Save 3D Model (Snapshot) is connected, but nothing is "
                    "wired into its 'splat' input. Connect the splat this mesh was reconstructed "
                    "from (the same one feeding SplatToMesh) to the node's 'splat' input.")
            splat_out = None
        else:
            splat_out = warp_splat_reverse_perspective(
                splat, cam_info, float(cam_info.get("reversePerspective", 0.0) or 0.0))
        # Custom ui key so the builtin 3d preview does not attach; our JS widget consumes it.
        return IO.NodeOutput(cam_info, splat_out, ui={"snapshot3d": results})


@PromptServer.instance.routes.post("/save3d_snapshot/save_png")
async def save3d_snapshot_save_png(request):
    """Receive a base64 PNG data-URL from the viewport widget and store it in the output dir."""
    try:
        data = await request.json()
        image_data = data.get("image", "")
        prefix = data.get("filename_prefix") or "3d/ComfyUI"
        if "," in image_data:
            image_data = image_data.split(",", 1)[1]
        raw = base64.b64decode(image_data)
        if raw[:8] != b"\x89PNG\r\n\x1a\n":
            return web.json_response({"error": "not a PNG"}, status=400)
        # get_save_image_path validates the path stays inside the output directory
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            prefix, folder_paths.get_output_directory())
        f = f"{filename}_{counter:05}_.png"
        with open(os.path.join(full_output_folder, f), "wb") as fp:
            fp.write(raw)
        logging.info(f"SaveGLBSnapshot: wrote PNG snapshot {os.path.join(subfolder, f)}")
        return web.json_response({"filename": f, "subfolder": subfolder, "type": "output"})
    except Exception as e:  # noqa: BLE001
        logging.exception("SaveGLBSnapshot: failed to save PNG")
        return web.json_response({"error": str(e)}, status=500)


class Save3DSnapshotExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[IO.ComfyNode]]:
        return [SaveGLBSnapshot, RenderSplatFixed]


async def comfy_entrypoint() -> Save3DSnapshotExtension:
    return Save3DSnapshotExtension()
