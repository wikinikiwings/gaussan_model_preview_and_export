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
import os

from typing_extensions import override

import folder_paths
import numpy as np
from aiohttp import web
from comfy.cli_args import args
from comfy_api.latest import ComfyExtension, IO, Types
from comfy_extras.nodes_save_3d import get_mesh_batch_item, save_glb
from PIL import Image
from server import PromptServer

WEB_DIRECTORY = "./web"


class SaveGLBSnapshot(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SaveGLBSnapshot",
            display_name="Save 3D Model (Snapshot)",
            search_aliases=["save glb snapshot", "isometric png", "3d snapshot"],
            category="3d",
            description="Saves the mesh as GLB (like SaveGLB) and shows it in a custom viewport "
                        "with an isometric camera preset and a 'Save PNG' snapshot button. "
                        "PNG snapshots are written to the output folder using the same filename prefix.",
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
            ],
            hidden=[IO.Hidden.prompt, IO.Hidden.extra_pnginfo],
        )

    @classmethod
    def execute(cls, mesh: Types.MESH | Types.File3D, filename_prefix: str) -> IO.NodeOutput:
        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory())
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
            results.append({"filename": f, "subfolder": subfolder, "type": "output"})
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
                results.append({"filename": f, "subfolder": subfolder, "type": "output"})
                counter += 1
        # Custom ui key so the builtin 3d preview does not attach; our JS widget consumes it.
        return IO.NodeOutput(ui={"snapshot3d": results})


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
        return [SaveGLBSnapshot]


async def comfy_entrypoint() -> Save3DSnapshotExtension:
    return Save3DSnapshotExtension()
