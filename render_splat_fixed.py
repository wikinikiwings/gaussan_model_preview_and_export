"""Render Splat (fixed) - the builtin RenderSplat with the inside-camera bug patched.

The builtin rasterizer's early-out checks `front = trans * slab_a`, which is ~0 both when
everything is occluded (the legitimate stop) and when a depth slab is merely EMPTY. With
the camera inside a splat (interior scenes such as TripoSplat rooms), the nearest depth
slabs are sparse near-eye floaters that draw almost nothing, two "empty" checkpoints fire
in a row, and the loop breaks before ever reaching the slabs that hold the actual walls -
the render comes back as pure background. The fix tests the transmittance instead, which
is monotone: `trans.max() < 1e-3` genuinely means nothing further can be visible.

Rather than forking the ~250-line rasterizer (which would silently drift from upstream),
this module takes the live source of `_render_gaussian`, applies the one-line fix
textually, and compiles it in the original module's namespace. The node then swaps the
patched function in around a call to the builtin RenderSplat.execute, so every other
behaviour (frame loops, batching, backgrounds, masks, render styles) stays byte-identical
to the builtin - including any future upstream improvements outside the patched lines.

If a ComfyUI update rewrites the patched block, the textual match fails, a warning is
logged once, and the node transparently falls back to the unpatched builtin behaviour.
"""

import inspect
import logging

import comfy_extras.nodes_gaussian_splat as gs
from comfy_api.latest import IO

_BUGGY = """        trans.mul_(1 - slab_a)
        if si % 8 == 7:                    # checkpoint every 8 slabs (a per-slab GPU sync would cost more)
            if float(front.max()) < 1e-3:  # this checkpoint slab is fully occluded by what is in front
                stale += 1
                if stale >= 2:             # two occluded checkpoints running -> the rest are too -> stop
                    break
            else:
                stale = 0"""

_FIXED = """        trans.mul_(1 - slab_a)
        # PATCHED (save3d_snapshot): early-out on exhausted transmittance instead of
        # `front` - front is also ~0 for a merely EMPTY slab, which black-screened
        # inside-the-splat cameras (interior scenes) before the real geometry was reached.
        if si % 8 == 7 and float(trans.max()) < 1e-3:
            break"""


def _build_patched_render():
    try:
        src = inspect.getsource(gs._render_gaussian)
        if src.count(_BUGGY) != 1:
            logging.warning(
                "RenderSplatFixed: the builtin rasterizer no longer matches the known buggy "
                "block (upstream changed?) - falling back to the unpatched builtin. If the "
                "upstream fix landed, this node is now redundant.")
            return None
        namespace = dict(gs.__dict__)
        exec(compile(src.replace(_BUGGY, _FIXED), gs.__file__ + " (patched)", "exec"), namespace)
        logging.info("RenderSplatFixed: inside-camera early-out patch applied")
        return namespace["_render_gaussian"]
    except Exception:  # noqa: BLE001 - a broken patch must never take the node down
        logging.exception("RenderSplatFixed: could not build the patched rasterizer, "
                          "falling back to the unpatched builtin")
        return None


_PATCHED_RENDER = _build_patched_render()


class RenderSplatFixed(gs.RenderSplat):
    @classmethod
    def define_schema(cls):
        schema = gs.RenderSplat.define_schema()
        schema.node_id = "RenderSplatFixed"
        schema.display_name = "Render Splat (fixed)"
        schema.description = (
            "The builtin Render Splat with one bug fixed: cameras placed INSIDE the splat "
            "(interior scenes) no longer come back as a pure-background/black image. "
            "Everything else is byte-identical to the builtin node. "
            + (schema.description or ""))
        schema.search_aliases = list(getattr(schema, "search_aliases", None) or []) + [
            "render splat fixed", "splat interior render"]
        return schema

    @classmethod
    def execute(cls, **kwargs) -> IO.NodeOutput:
        if _PATCHED_RENDER is None:
            return gs.RenderSplat.execute(**kwargs)
        # ComfyUI executes nodes sequentially, so a swap-and-restore around the builtin
        # execute is safe; try/finally guarantees the module is left pristine either way.
        original = gs._render_gaussian
        gs._render_gaussian = _PATCHED_RENDER
        try:
            return gs.RenderSplat.execute(**kwargs)
        finally:
            gs._render_gaussian = original
