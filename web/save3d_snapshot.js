import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_ID = "SaveGLBSnapshot";
const EXT_URL = new URL(".", import.meta.url).href; // /extensions/save3d_snapshot/
const SNAPSHOT_MAX_DIM = 2048; // longest side of the saved PNG

// ---------------------------------------------------------------------------
// three.js (UMD r147: last release that ships examples/js global builds)
// ---------------------------------------------------------------------------
let threePromise = null;

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
    });
}

function ensureThree() {
    if (!threePromise) {
        threePromise = (async () => {
            if (!window.THREE) await loadScript(EXT_URL + "lib/three.min.js");
            if (!window.THREE.OrbitControls) await loadScript(EXT_URL + "lib/OrbitControls.js");
            if (!window.THREE.GLTFLoader) await loadScript(EXT_URL + "lib/GLTFLoader.js");
        })();
    }
    return threePromise;
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------
const BTN_CSS = "background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;" +
    "padding:2px 8px;font-size:11px;cursor:pointer;user-select:none;";

class SnapshotViewer {
    constructor(node) {
        this.node = node;
        this.disposed = false;
        this.transparentBG = false;
        this.modelRoot = null;
        this.boundingSphere = null;

        this.root = document.createElement("div");
        this.root.style.cssText =
            "position:relative;width:100%;height:100%;" +
            "background:#141414;border-radius:6px;overflow:hidden;";

        // toolbar -----------------------------------------------------------
        const bar = document.createElement("div");
        bar.style.cssText =
            "position:absolute;top:6px;left:6px;right:6px;z-index:2;display:flex;" +
            "gap:6px;align-items:center;flex-wrap:wrap;pointer-events:none;";
        this.root.appendChild(bar);

        const mkBtn = (label, title, onClick) => {
            const b = document.createElement("button");
            b.textContent = label;
            b.title = title;
            b.style.cssText = BTN_CSS + "pointer-events:auto;";
            b.addEventListener("pointerdown", (e) => e.stopPropagation());
            b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
            bar.appendChild(b);
            return b;
        };

        // 8 isometric presets: 4 yaw quadrants x view from above/below
        this.isoPresets = [
            ["Iso NE \u2191", 45, 1], ["Iso NW \u2191", 135, 1], ["Iso SW \u2191", 225, 1], ["Iso SE \u2191", 315, 1],
            ["Iso NE \u2193", 45, -1], ["Iso NW \u2193", 135, -1], ["Iso SW \u2193", 225, -1], ["Iso SE \u2193", 315, -1],
        ];
        this.isoSelect = document.createElement("select");
        this.isoSelect.title = "Isometric direction: yaw quadrant, \u2191 from above / \u2193 from below " +
            "(elevation 35.26\u00B0, orthographic)";
        this.isoSelect.style.cssText = BTN_CSS + "pointer-events:auto;";
        for (const [label] of this.isoPresets) {
            const o = document.createElement("option");
            o.textContent = label;
            this.isoSelect.appendChild(o);
        }
        this.isoSelect.addEventListener("pointerdown", (e) => e.stopPropagation());
        this.isoSelect.addEventListener("change", () => this.setIsometric());
        bar.appendChild(this.isoSelect);

        mkBtn("Isometric", "Apply the selected isometric preset (re-frames the model)",
            () => this.setIsometric());
        mkBtn("Perspective", "Reset to a perspective 3/4 view", () => this.setPerspective());

        const bgBtn = mkBtn("BG: dark", "Toggle transparent background for the snapshot", () => {
            this.transparentBG = !this.transparentBG;
            bgBtn.textContent = this.transparentBG ? "BG: transparent" : "BG: dark";
            this.applyBackground();
        });

        const saveBtn = mkBtn("\uD83D\uDCF7 Save PNG", "Save the current view as PNG into the output folder",
            () => this.savePNG(saveBtn));

        this.downloadToo = false;
        const dlBtn = mkBtn("\u21E9 DL: off", "Also download the PNG to this device via the browser", () => {
            this.downloadToo = !this.downloadToo;
            dlBtn.textContent = this.downloadToo ? "\u21E9 DL: on" : "\u21E9 DL: off";
        });

        this.status = document.createElement("span");
        this.status.style.cssText =
            "color:#9a9a9a;font-size:10px;pointer-events:none;max-width:100%;" +
            "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        bar.appendChild(this.status);

        this.setStatus("run the workflow to load a model");
    }

    setStatus(text) { this.status.textContent = text; }

    async init() {
        await ensureThree();
        if (this.disposed) return;
        const THREE = window.THREE;

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.outputEncoding = THREE.sRGBEncoding;
        this.renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
        this.root.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.applyBackground();

        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 0.9));
        const dir = new THREE.DirectionalLight(0xffffff, 0.9);
        dir.position.set(3, 6, 4);
        this.scene.add(dir);

        this.perspCam = new THREE.PerspectiveCamera(35, 1, 0.01, 5000);
        this.perspCam.position.set(2.5, 2, 3.5);
        this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -5000, 5000);
        this.camera = this.perspCam;

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;

        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(this.root);
        this.onResize();

        const loop = () => {
            if (this.disposed) return;
            requestAnimationFrame(loop);
            this.controls?.update();
            this.renderer.render(this.scene, this.camera);
        };
        loop();
    }

    applyBackground() {
        if (!this.scene) return;
        this.scene.background = this.transparentBG ? null : new window.THREE.Color(0x141414);
    }

    onResize() {
        if (!this.renderer) return;
        const w = Math.max(1, this.root.clientWidth);
        const h = Math.max(1, this.root.clientHeight);
        this.renderer.setSize(w, h, false);
        this.updateCameraAspect(w / h);
    }

    updateCameraAspect(aspect) {
        this.perspCam.aspect = aspect;
        this.perspCam.updateProjectionMatrix();
        const half = this.orthoHalf ?? 1;
        this.orthoCam.left = -half * aspect;
        this.orthoCam.right = half * aspect;
        this.orthoCam.top = half;
        this.orthoCam.bottom = -half;
        this.orthoCam.updateProjectionMatrix();
    }

    switchCamera(cam) {
        const THREE = window.THREE;
        this.camera = cam;
        const target = this.boundingSphere ? this.boundingSphere.center.clone() : new THREE.Vector3();
        this.controls?.dispose();
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.target.copy(target);
        this.controls.update();
    }

    loadModel(url, fileInfo) {
        if (!window.THREE?.GLTFLoader) { this.setStatus("viewer not ready yet"); return; }
        const lower = (fileInfo?.filename || url).toLowerCase();
        if (!(lower.endsWith(".glb") || lower.endsWith(".gltf"))) {
            this.setStatus(`preview supports glb/gltf only (got ${fileInfo?.filename || "?"})`);
            return;
        }
        this.setStatus("loading " + (fileInfo?.filename || ""));
        new window.THREE.GLTFLoader().load(url, (gltf) => {
            if (this.disposed) return;
            if (this.modelRoot) this.scene.remove(this.modelRoot);
            this.modelRoot = gltf.scene;
            this.modelRoot.traverse((o) => {
                if (o.isMesh && o.material) o.material.side = window.THREE.DoubleSide;
            });
            this.scene.add(this.modelRoot);
            const box = new window.THREE.Box3().setFromObject(this.modelRoot);
            this.boundingSphere = box.getBoundingSphere(new window.THREE.Sphere());
            this.setPerspective();
            this.setStatus(fileInfo?.filename || "");
        }, undefined, (err) => {
            console.error("[save3d_snapshot] load error", err);
            this.setStatus("failed to load model (see console)");
        });
    }

    setPerspective() {
        if (!this.boundingSphere) return;
        const THREE = window.THREE;
        const s = this.boundingSphere;
        const dist = (s.radius / Math.tan(THREE.MathUtils.degToRad(35 / 2))) * 1.2;
        const dir = new THREE.Vector3(1, 0.7, 1.4).normalize();
        this.perspCam.position.copy(s.center).addScaledVector(dir, dist);
        this.perspCam.near = Math.max(dist / 1000, 0.001);
        this.perspCam.far = dist * 100;
        this.perspCam.lookAt(s.center);
        this.switchCamera(this.perspCam);
    }

    setIsometric() {
        if (!this.boundingSphere) { this.setStatus("no model loaded"); return; }
        const THREE = window.THREE;
        const s = this.boundingSphere;
        // true isometry: equal angles to all three axes -> elevation atan(1/sqrt(2)) ~ 35.264deg,
        // yaw at 45/135/225/315deg, orthographic projection
        const [, yawDeg, elevSign] = this.isoPresets[this.isoSelect.selectedIndex] ?? this.isoPresets[0];
        const yaw = THREE.MathUtils.degToRad(yawDeg);
        const elev = Math.atan(1 / Math.SQRT2) * elevSign;
        const dir = new THREE.Vector3(
            Math.cos(elev) * Math.sin(yaw),
            Math.sin(elev),
            Math.cos(elev) * Math.cos(yaw),
        ).normalize();
        this.orthoHalf = s.radius * 1.15;
        const aspect = this.root.clientWidth / Math.max(1, this.root.clientHeight);
        this.updateCameraAspect(aspect);
        this.orthoCam.zoom = 1;
        this.orthoCam.position.copy(s.center).addScaledVector(dir, s.radius * 4);
        this.orthoCam.lookAt(s.center);
        this.orthoCam.updateProjectionMatrix();
        this.switchCamera(this.orthoCam);
    }

    getPrefix() {
        const w = this.node.widgets?.find((x) => x.name === "filename_prefix");
        return (w?.value || "3d/ComfyUI") + "";
    }

    async savePNG(btn) {
        if (!this.renderer || !this.modelRoot) { this.setStatus("no model loaded"); return; }
        const w = this.root.clientWidth, h = this.root.clientHeight;
        const scale = SNAPSHOT_MAX_DIM / Math.max(w, h);
        try {
            btn.disabled = true;
            // hi-res offscreen-ish render: upscale, render synchronously, capture, restore
            this.renderer.setPixelRatio(1);
            this.renderer.setSize(Math.round(w * scale), Math.round(h * scale), false);
            this.renderer.render(this.scene, this.camera);
            const dataURL = this.renderer.domElement.toDataURL("image/png");
            this.renderer.setPixelRatio(window.devicePixelRatio || 1);
            this.renderer.setSize(w, h, false);

            const resp = await api.fetchApi("/save3d_snapshot/save_png", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ image: dataURL, filename_prefix: this.getPrefix() }),
            });
            const out = await resp.json();
            if (!resp.ok) throw new Error(out.error || resp.statusText);
            if (this.downloadToo) {
                const a = document.createElement("a");
                a.href = dataURL;
                a.download = out.filename || "snapshot.png";
                document.body.appendChild(a);
                a.click();
                a.remove();
            }
            this.setStatus("saved: " + (out.subfolder ? out.subfolder + "/" : "") + out.filename
                + (this.downloadToo ? " (+ downloaded)" : ""));
        } catch (e) {
            console.error("[save3d_snapshot] save png failed", e);
            this.setStatus("PNG save failed (see console)");
        } finally {
            btn.disabled = false;
        }
    }

    dispose() {
        this.disposed = true;
        this.resizeObserver?.disconnect();
        this.controls?.dispose();
        this.renderer?.dispose();
    }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "save3d.snapshot",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_ID) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const viewer = new SnapshotViewer(this);
            this._snapshotViewer = viewer;
            const widget = this.addDOMWidget("snapshot_preview", "SNAPSHOT3D", viewer.root, {
                serialize: false,
                // No legacy computeSize here: without it the frontend treats the DOM widget as
                // growable (computeLayoutSize path) and gives it all free node space, exactly
                // like the builtin 3d preview. A computeSize tied to node.size is circular and
                // makes the node snap back to a stale size on click.
                getMinHeight: () => 220,
            });
            // Root cause of the horizontal "snap-back": the frontend's DomWidgets
            // component sizes the element as `widget.width ?? node.width`. If anything in
            // litegraph's legacy widget path ever writes widget.width (it does, on click),
            // that stale value permanently overrides the node width. The builtin 3d preview
            // never gets a width written, which is why it stretches correctly. Neutralize
            // the property so the element always follows node.width:
            Object.defineProperty(widget, "width", {
                get: () => undefined,
                set: () => {},
                configurable: true,
            });
            viewer.init();
            this.setSize([Math.max(this.size[0], 380), Math.max(this.size[1], 460)]);

            // Never allow the node to get narrower than the viewport's practical minimum.
            // setSize() always routes through onResize with the live size array, so
            // clamping here covers every code path that resizes the node.
            const MIN_W = 380;
            const onResizePrev = this.onResize;
            this.onResize = function (size) {
                if (size && size[0] < MIN_W) size[0] = MIN_W;
                onResizePrev?.apply(this, arguments);
            };

            // Debug aid: set window.SAVE3D_DEBUG = true in the browser console to get a
            // stack trace for every programmatic resize of this node (helps pinpoint
            // click-time size snapping).
            const setSizePrev = this.setSize.bind(this);
            this.setSize = (s) => {
                if (window.SAVE3D_DEBUG) console.trace("[save3d_snapshot] setSize", s?.[0], s?.[1]);
                setSizePrev(s);
            };

            const onRemoved = this.onRemoved;
            this.onRemoved = function () {
                viewer.dispose();
                onRemoved?.apply(this, arguments);
            };
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const files = message?.snapshot3d;
            if (files?.length && this._snapshotViewer) {
                const f = files[0];
                if (files.length > 1) {
                    this._snapshotViewer.setStatus(`batch of ${files.length}, previewing #1`);
                }
                const url = api.apiURL(
                    `/view?filename=${encodeURIComponent(f.filename)}` +
                    `&subfolder=${encodeURIComponent(f.subfolder || "")}` +
                    `&type=${encodeURIComponent(f.type || "output")}&rand=${Math.random()}`
                );
                this._snapshotViewer.loadModel(url, f);
            }
        };
    },
});
