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
        this.transparentBG = true;
        this.downloadToo = true; // always also download the PNG to the user's device
        this.modelRoot = null;
        this.boundingSphere = null;
        this.everFramed = false; // has a model ever been framed in this session?

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

        // View direction: rotate around the Y axis in 45deg steps (8 positions, wraps
        // around), always with the classic isometric elevation +35.26deg (arctan 1/sqrt2).
        // Whether the projection is orthographic or perspective is decided by the Persp slider.
        this.yawDeg = 45;
        const yawWrap = document.createElement("span");
        yawWrap.title = "View direction: rotate around the vertical axis in 45\u00B0 steps, " +
            "classic isometric elevation 35.26\u00B0. Rotating keeps the current " +
            "pan/scale/foreshortening.";
        yawWrap.style.cssText = BTN_CSS + "pointer-events:auto;display:flex;align-items:center;" +
            "gap:5px;cursor:default;padding:1px 5px;";
        this.yawLabel = document.createElement("span");
        this.yawLabel.textContent = "Yaw 45\u00B0";
        this.yawLabel.style.cssText = "min-width:52px;font-size:10px;color:#bbb;text-align:center;";
        const mkYawBtn = (label, title, delta) => {
            const b = document.createElement("button");
            b.textContent = label;
            b.title = title;
            b.style.cssText = BTN_CSS + "pointer-events:auto;padding:1px 6px;";
            b.addEventListener("pointerdown", (e) => e.stopPropagation());
            b.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.yawDeg = ((this.yawDeg + delta) % 360 + 360) % 360;
                this.yawLabel.textContent = `Yaw ${this.yawDeg}\u00B0`;
                this.applyPreset();
            });
            return b;
        };
        yawWrap.appendChild(mkYawBtn("\u21BA", "Rotate view 45\u00B0 counter-clockwise", -45));
        yawWrap.appendChild(this.yawLabel);
        yawWrap.appendChild(mkYawBtn("\u21BB", "Rotate view 45\u00B0 clockwise", 45));
        bar.appendChild(yawWrap);

        mkBtn("Frame", "Reset the composition: center the model and fit it to the view " +
            "from the current direction", () => this.applyPreset(true));

        // Foreshortening slider: 0deg = orthographic (true isometry), >0deg = perspective
        // with that FOV. Uses dolly-zoom compensation so composition stays put.
        const sliderWrap = document.createElement("label");
        sliderWrap.title = "Perspective foreshortening: 0\u00B0 = orthographic (isometry), " +
            "positive = perspective, negative = REVERSE perspective (far parts render larger " +
            "- compensates foreshortening baked into the model). Framing is kept constant.";
        sliderWrap.style.cssText = BTN_CSS + "pointer-events:auto;display:flex;align-items:center;" +
            "gap:5px;cursor:default;";
        this.perspLabel = document.createElement("span");
        this.perspLabel.textContent = "Persp 0\u00B0";
        this.perspLabel.style.cssText = "min-width:52px;font-size:10px;color:#bbb;";
        this.perspSlider = document.createElement("input");
        this.perspSlider.type = "range";
        this.perspSlider.min = "-60";
        this.perspSlider.max = "60";
        this.perspSlider.step = "1";
        this.perspSlider.value = "0";
        this.perspSlider.style.cssText = "width:90px;";
        this.perspSlider.addEventListener("pointerdown", (e) => e.stopPropagation());
        this.perspSlider.addEventListener("input", () => {
            this.perspLabel.textContent = `Persp ${this.perspSlider.value}\u00B0`;
            this.setPerspectiveAmount();
        });
        const perspReset = document.createElement("button");
        perspReset.textContent = "\u21BA0";
        perspReset.title = "Reset foreshortening to 0\u00B0 (orthographic isometry)";
        perspReset.style.cssText = BTN_CSS + "pointer-events:auto;padding:1px 5px;font-size:10px;";
        perspReset.addEventListener("pointerdown", (e) => e.stopPropagation());
        perspReset.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.perspSlider.value = "0";
            this.perspLabel.textContent = "Persp 0\u00B0";
            this.setPerspectiveAmount();
        });
        sliderWrap.appendChild(this.perspLabel);
        sliderWrap.appendChild(this.perspSlider);
        sliderWrap.appendChild(perspReset);
        bar.appendChild(sliderWrap);

        const bgBtn = mkBtn("BG: transparent", "Toggle transparent background for the snapshot", () => {
            this.transparentBG = !this.transparentBG;
            bgBtn.textContent = this.transparentBG ? "BG: transparent" : "BG: dark";
            this.applyBackground();
        });

        const saveBtn = mkBtn("\uD83D\uDCF7 Save PNG", "Save the current view as PNG into the output folder " +
            "and download it to this device", () => this.savePNG(saveBtn));

        mkBtn("Open \u2197", "Open the current view as PNG in a new browser tab (nothing is saved)",
            () => this.openInTab());

        mkBtn("\u21E9 GLB", "Download the model file to this device (the model itself lives in the " +
            "server's temp folder unless save_model is on)", () => this.downloadModel());

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

        this.initGizmo();
        // Capture phase on the container: this runs before OrbitControls' own handler on the
        // canvas, so grabbing a gizmo ring does not also start an orbit drag.
        this.root.addEventListener("pointerdown", (e) => this.onGizmoPointerDown(e), true);

        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(this.root);
        this.onResize();

        const loop = () => {
            if (this.disposed) return;
            requestAnimationFrame(loop);
            if (!this.gizmoDrag) this.controls?.update();   // frozen while a ring is dragged
            // OrbitControls and aspect updates rebuild the ortho projection matrix,
            // wiping the custom reverse-perspective row - reapply it every frame.
            if (this.reverseParams) this.applyReversePerspective();
            this.renderer.render(this.scene, this.camera);
            this.renderGizmo();
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

    switchCamera(cam, target) {
        const THREE = window.THREE;
        const t = target ?? (this.boundingSphere ? this.boundingSphere.center.clone() : new THREE.Vector3());
        if (this.camera !== cam || !this.controls) {
            this.camera = cam;
            this.controls?.dispose();
            this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
            this.controls.enableDamping = true;
            // Report the camera after every manual orbit/zoom/pan so the node's
            // camera_info output always matches what the user sees.
            this.controls.addEventListener("end", () => this.updateCameraState());
        }
        this.controls.target.copy(t);
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
        this.modelUrl = url;
        this.modelFilename = fileInfo?.filename || "model.glb";
        new window.THREE.GLTFLoader().load(url, (gltf) => {
            if (this.disposed) return;
            if (this.modelRoot) this.scene.remove(this.modelRoot);
            this.modelRoot = gltf.scene;
            this.modelRoot.traverse((o) => {
                if (o.isMesh && o.material) o.material.side = window.THREE.DoubleSide;
            });
            this.scene.add(this.modelRoot);
            const box = new window.THREE.Box3().setFromObject(this.modelRoot);
            const prev = this.boundingSphere;
            this.boundingSphere = box.getBoundingSphere(new window.THREE.Sphere());
            // Keep the user's shot across re-runs. Only reframe when there is nothing to
            // preserve: first model of the session (unless the workflow carried a camera)
            // or a model whose bounds differ enough that the old framing would miss it.
            if (!this.everFramed && this.restoreFromWidget()) {
                this.setStatus("restored framing from the workflow");
            } else if (this.controls && prev && this.boundsComparable(prev, this.boundingSphere)) {
                this.setPerspectiveAmount(); // re-place the camera, same direction/target/scale
            } else {
                this.applyPreset(true);
            }
            this.everFramed = true;
            this.setStatus(fileInfo?.filename || "");
        }, undefined, (err) => {
            console.error("[save3d_snapshot] load error", err);
            this.setStatus("failed to load model (see console)");
        });
    }

    // Current perspective foreshortening in degrees of vertical FOV (0 = orthographic).
    get perspFov() {
        return parseFloat(this.perspSlider?.value || "0");
    }

    // Half of the vertical extent of the view at the target, in world units.
    // This is the invariant that dolly-zoom preserves when the FOV changes.
    currentHalfHeight() {
        const THREE = window.THREE;
        const target = this.controls?.target ?? new THREE.Vector3();
        if (this.camera === this.orthoCam) {
            return (this.orthoHalf ?? 1) / (this.orthoCam.zoom || 1);
        }
        const dist = this.camera.position.distanceTo(target);
        return Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov / 2)) * dist;
    }

    // Place a camera looking along -dir at target so that the view spans halfH world
    // units vertically. Projection is chosen by the Persp slider: 0deg -> orthographic
    // (true isometry when dir is an iso preset), >0deg -> perspective with that FOV,
    // camera distance compensated (dolly zoom) so the composition does not change.
    placeCamera(dir, target, halfH) {
        const THREE = window.THREE;
        const fovDeg = this.perspFov;
        const aspect = this.root.clientWidth / Math.max(1, this.root.clientHeight);
        const radius = this.boundingSphere?.radius ?? halfH;
        if (Math.abs(fovDeg) <= 0.001) {
            this.reverseParams = null;
            this.orthoHalf = halfH;
            this.orthoCam.zoom = 1;
            const dist = Math.max(radius, halfH) * 4;
            this.orthoCam.position.copy(target).addScaledVector(dir, dist);
            this.orthoCam.lookAt(target);
            this.updateCameraAspect(aspect);
            this.switchCamera(this.orthoCam, target);
        } else if (fovDeg > 0) {
            this.reverseParams = null;
            const dist = halfH / Math.tan(THREE.MathUtils.degToRad(fovDeg / 2));
            this.perspCam.fov = fovDeg;
            this.perspCam.near = Math.max(dist / 1000, 0.001);
            this.perspCam.far = dist * 4 + radius * 20;
            this.perspCam.position.copy(target).addScaledVector(dir, dist);
            this.perspCam.lookAt(target);
            this.updateCameraAspect(aspect);
            this.switchCamera(this.perspCam, target);
        } else {
            // Reverse perspective: orthographic camera placement + a custom projection
            // whose frustum CONTRACTS with depth, so far parts render larger. Same
            // half-height invariant at the target plane as the other modes.
            this.reverseParams = { fovAbs: -fovDeg };
            this.orthoHalf = halfH;
            this.orthoCam.zoom = 1;
            const dist = Math.max(radius, halfH) * 4;
            this.orthoCam.position.copy(target).addScaledVector(dir, dist);
            this.orthoCam.lookAt(target);
            this.updateCameraAspect(aspect);
            this.switchCamera(this.orthoCam, target);
            this.applyReversePerspective();
        }
        this.updateCameraState();
    }

    // ---- rotation gizmo -------------------------------------------------------------
    // A sphere of three ribbons in the corner of the viewport: drag a ring to rotate the
    // camera around that world axis. Purely navigational - the model is never touched, so
    // the exported camera_info stays truthful. Rotating around the view axis is roll, which
    // is held in camera.up: OrbitControls captures its orbit axis once at construction but
    // ends update() with lookAt(), which honours camera.up, so the roll survives.
    initGizmo() {
        const THREE = window.THREE;
        this.gizmoScene = new THREE.Scene();
        this.gizmoCam = new THREE.OrthographicCamera(-1.35, 1.35, 1.35, -1.35, 0.1, 100);
        this.gizmoDrag = null;
        this.raycaster = new THREE.Raycaster();

        // Opaque-ish core so the far halves of the ribbons are hidden - that is what makes
        // it read as a sphere rather than three flat circles.
        this.gizmoScene.add(new THREE.Mesh(
            new THREE.SphereGeometry(0.93, 24, 18),
            new THREE.MeshBasicMaterial({ color: 0x202020, transparent: true, opacity: 0.55 })));

        const ring = (axis, color, orient) => {
            const m = new THREE.Mesh(
                new THREE.TorusGeometry(1, 0.055, 8, 96),
                new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
            orient(m);                       // a torus lies in XY, i.e. its axis is +Z
            m.userData.axis = axis;
            this.gizmoScene.add(m);
            return m;
        };
        this.gizmoRings = [
            ring(new THREE.Vector3(1, 0, 0), 0xff5f6d, (m) => { m.rotation.y = Math.PI / 2; }),
            ring(new THREE.Vector3(0, 1, 0), 0x8fdc5a, (m) => { m.rotation.x = Math.PI / 2; }),
            ring(new THREE.Vector3(0, 0, 1), 0x5aa9ff, () => {}),
        ];
    }

    // Square region in the bottom-right corner, in CSS pixels (y measured from the bottom,
    // matching WebGLRenderer.setViewport).
    gizmoRect() {
        const w = this.root.clientWidth, h = this.root.clientHeight;
        const size = Math.max(58, Math.min(104, Math.floor(Math.min(w, h) * 0.22)));
        return { x: w - size - 10, y: 10, size };
    }

    syncGizmoCamera() {
        if (!this.gizmoCam || !this.camera) return;
        const target = this.controls?.target ?? new window.THREE.Vector3();
        const dir = this.camera.position.clone().sub(target);
        if (dir.lengthSq() < 1e-12) dir.set(0, 0, 1);
        this.gizmoCam.position.copy(dir.normalize().multiplyScalar(5));
        this.gizmoCam.up.copy(this.camera.up);
        this.gizmoCam.lookAt(0, 0, 0);
    }

    renderGizmo() {
        if (!this.gizmoScene) return;
        const r = this.gizmoRect();
        this.syncGizmoCamera();
        this.renderer.autoClear = false;
        this.renderer.setViewport(r.x, r.y, r.size, r.size);
        this.renderer.setScissor(r.x, r.y, r.size, r.size);
        this.renderer.setScissorTest(true);
        this.renderer.clearDepth();               // gizmo depth-sorts against itself only
        this.renderer.render(this.gizmoScene, this.gizmoCam);
        this.renderer.setScissorTest(false);
        const w = this.root.clientWidth, h = this.root.clientHeight;
        this.renderer.setViewport(0, 0, w, h);    // restore, or the next frame draws cropped
        this.renderer.setScissor(0, 0, w, h);
        this.renderer.autoClear = true;
    }

    // Pointer -> normalized coordinates inside the gizmo region, or null if outside.
    gizmoNDC(e) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        const r = this.gizmoRect();
        const gx = (e.clientX - rect.left) - r.x;
        const gy = (rect.height - (e.clientY - rect.top)) - r.y;
        if (gx < 0 || gy < 0 || gx > r.size || gy > r.size) return null;
        return new window.THREE.Vector2((gx / r.size) * 2 - 1, (gy / r.size) * 2 - 1);
    }

    onGizmoPointerDown(e) {
        if (!this.gizmoRings || e.button !== 0 || this.gizmoDrag) return;
        const ndc = this.gizmoNDC(e);
        if (!ndc) return;
        this.syncGizmoCamera();
        this.raycaster.setFromCamera(ndc, this.gizmoCam);
        const hit = this.raycaster.intersectObjects(this.gizmoRings, false)[0];
        if (!hit) return;
        e.preventDefault();
        e.stopPropagation();                      // keep OrbitControls out of this drag

        const THREE = window.THREE;
        const axis = hit.object.userData.axis.clone();
        // Settle the controls and clear any leftover inertia before sampling the start pose:
        // with damping on, residual sphericalDelta keeps decaying for frames afterwards and
        // would add azimuth/polar drift on top of our single-axis rotation.
        if (this.controls) {
            this.controls.enableDamping = false;
            this.controls.update();
            this.controls.enableDamping = true;
            this.controls.enabled = false;
        }
        // Dim the other ribbons so it is visible that only this axis is live.
        for (const r of this.gizmoRings) r.material.opacity = r === hit.object ? 1.0 : 0.22;
        this.gizmoAxisName = { "1,0,0": "X", "0,1,0": "Y", "0,0,1": "Z" }[axis.toArray().join(",")] || "";

        // Screen-space tangent of the ring at the grab point, so dragging along the ribbon
        // rotates the way it looks like it should whatever the current orientation is.
        const p = hit.point.clone();
        const tan = axis.clone().cross(p);
        const a = p.clone().project(this.gizmoCam);
        const b = p.clone().add(tan.normalize().multiplyScalar(0.2)).project(this.gizmoCam);
        const t2 = new THREE.Vector2(b.x - a.x, -(b.y - a.y));   // NDC y is up, screen y is down
        if (t2.lengthSq() < 1e-9) t2.set(1, 0);
        t2.normalize();

        this.gizmoDrag = {
            axis, t2,
            startX: e.clientX, startY: e.clientY,
            startPos: this.camera.position.clone(),
            startUp: this.camera.up.clone(),
            target: (this.controls?.target ?? new THREE.Vector3()).clone(),
            move: (ev) => this.onGizmoPointerMove(ev),
            up: (ev) => this.onGizmoPointerUp(ev),
        };
        window.addEventListener("pointermove", this.gizmoDrag.move);
        window.addEventListener("pointerup", this.gizmoDrag.up);
        window.addEventListener("pointercancel", this.gizmoDrag.up);
    }

    onGizmoPointerMove(e) {
        const d = this.gizmoDrag;
        if (!d) return;
        const THREE = window.THREE;
        const angle = ((e.clientX - d.startX) * d.t2.x + (e.clientY - d.startY) * d.t2.y) * 0.012;
        const q = new THREE.Quaternion().setFromAxisAngle(d.axis, angle);
        // Rigid rotation of the whole camera about the single world axis: position and up get
        // the same quaternion, and nothing else touches the camera until the drag ends.
        this.camera.position.copy(d.target).add(d.startPos.clone().sub(d.target).applyQuaternion(q));
        this.camera.up.copy(d.startUp).applyQuaternion(q);
        this.camera.lookAt(d.target);
        const deg = THREE.MathUtils.radToDeg(angle);
        this.setStatus(`rotate ${this.gizmoAxisName}: ${deg >= 0 ? "+" : ""}${deg.toFixed(0)}\u00B0`);
    }

    onGizmoPointerUp() {
        const d = this.gizmoDrag;
        if (!d) return;
        window.removeEventListener("pointermove", d.move);
        window.removeEventListener("pointerup", d.up);
        window.removeEventListener("pointercancel", d.up);
        this.gizmoDrag = null;
        for (const r of this.gizmoRings || []) r.material.opacity = 0.9;
        if (this.controls) {
            // Resync the controls' internal spherical state to the pose we just built,
            // with damping off so no inertia is applied on the way back in.
            this.controls.enableDamping = false;
            this.controls.update();
            this.controls.enableDamping = true;
            this.controls.enabled = true;
        }
        this.updateCameraState();
    }

    // ---- camera placement -----------------------------------------------------------
    // Two models are "the same shot" if the old framing still contains the new one:
    // centers within a radius of each other and a scale ratio inside 0.5x..2x.
    boundsComparable(a, b) {
        const ra = Math.max(a.radius, 1e-6);
        const rb = Math.max(b.radius, 1e-6);
        const ratio = rb / ra;
        return a.center.distanceTo(b.center) <= Math.max(ra, rb) && ratio > 0.5 && ratio < 2;
    }

    // Rebuild the view from the serialized `camera_state`, so a framing set up before a
    // page reload (or saved in the workflow JSON) is restored on the next run instead of
    // being reset. Returns false when there is nothing usable to restore.
    restoreFromWidget() {
        const w = this.node.widgets?.find((x) => x.name === "camera_state");
        if (!w?.value) return false;
        try {
            const THREE = window.THREE;
            const s = JSON.parse(w.value);
            if (!s?.position || !s?.target) return false;
            const pos = new THREE.Vector3(s.position.x, s.position.y, s.position.z);
            const target = new THREE.Vector3(s.target.x, s.target.y, s.target.z);
            const dir = pos.clone().sub(target);
            const dist = dir.length();
            if (!(dist > 1e-6)) return false;
            dir.divideScalar(dist);
            // Inverse of the export: distance was normalized to halfH / tan(fov/2).
            const fovExported = Number(s.fov) || 35;
            const halfH = Math.tan(THREE.MathUtils.degToRad(fovExported / 2)) * dist;
            if (!(halfH > 1e-6)) return false;
            const yawDeg = Number(s.viewer?.yawDeg);
            if (Number.isFinite(yawDeg)) {
                this.yawDeg = ((yawDeg % 360) + 360) % 360;
                this.yawLabel.textContent = `Yaw ${this.yawDeg}\u00B0`;
            }
            const persp = Number(s.viewer?.persp);
            const fallbackPersp = s.cameraType === "perspective" ? fovExported : 0;
            const value = Math.max(-60, Math.min(60, Number.isFinite(persp) ? persp : fallbackPersp));
            this.perspSlider.value = String(value);
            this.perspLabel.textContent = `Persp ${value}\u00B0`;
            this.placeCamera(dir, target, halfH);
            return true;
        } catch (e) {
            console.warn("[save3d_snapshot] could not restore camera_state", e);
            return false;
        }
    }

    // Serialize the current view into the hidden `camera_state` widget, which the Python
    // side turns into the node's camera_info output (for RenderSplat and friends).
    // Coordinates are three.js world space - exactly what camera_info expects, so no
    // conversion is needed here. The exported distance is normalized to the framing
    // invariant (halfHeight / tan(fov/2)) so the server reproduces this exact frame.
    // Note: RenderSplat knows perspective and orthographic only, so a negative
    // (reverse-perspective) slider value is exported as orthographic.
    updateCameraState() {
        const w = this.node.widgets?.find((x) => x.name === "camera_state");
        if (!w || !this.camera || !this.controls) return;
        const THREE = window.THREE;
        const target = this.controls.target.clone();
        const dir = this.camera.position.clone().sub(target);
        if (dir.lengthSq() < 1e-12) dir.set(1, 1, 1);
        dir.normalize();
        const persp = this.perspFov > 0.001;
        const fov = persp ? this.perspFov : 35;
        const dist = this.currentHalfHeight() / Math.tan(THREE.MathUtils.degToRad(fov / 2));
        const pos = target.clone().addScaledVector(dir, dist);
        const q = this.camera.quaternion;
        const xyz = (v) => ({ x: v.x, y: v.y, z: v.z });
        w.value = JSON.stringify({
            position: xyz(pos),
            target: xyz(target),
            quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
            fov,
            cameraType: persp ? "perspective" : "orthographic",
            zoom: 1,
            // Strength of the reverse perspective (negative slider), consumed by the
            // SplatReversePerspective node; RenderSplat ignores this key.
            reversePerspective: this.perspFov < 0 ? -this.perspFov : 0,
            // Viewer-only extras (ignored by the Python side) so the exact toolbar state
            // can be restored, including negative (reverse-perspective) values.
            viewer: { yawDeg: this.yawDeg, persp: this.perspFov },
        });
    }

    // Overwrite the ortho camera's projection so that scale grows linearly with depth
    // (w' = a*z + b): a generalized projective matrix normalized at the target plane.
    // Both the w-row AND the z-row must be rebuilt together: keeping the ortho z-row
    // while dividing by a depth-varying w flips the sign of d(z_ndc)/d(depth), which
    // inverts the depth test and renders the model "inside out". The z-row below is
    // solved so that z_ndc maps nearD -> -1, farD -> +1 monotonically, and the slope
    // clamp keeps w > 0 across [nearD, farD] (no pole inside the clip range).
    applyReversePerspective() {
        const p = this.reverseParams;
        if (!p || !this.renderer) return;
        const THREE = window.THREE;
        const cam = this.orthoCam;
        cam.updateProjectionMatrix(); // fresh ortho x/y rows (aspect + wheel zoom)
        const halfH = (this.orthoHalf ?? 1) / (cam.zoom || 1);
        const target = this.controls?.target ?? new THREE.Vector3();
        const D = cam.position.distanceTo(target);
        const r = this.boundingSphere?.radius ?? halfH;
        const nearD = Math.max(D - 1.5 * r, D * 0.05);
        const farD = D + 1.5 * r;
        let m = Math.tan(THREE.MathUtils.degToRad(p.fovAbs / 2));
        // Reverse perspective: w must DECREASE with depth (far parts divided by a
        // smaller w -> rendered larger). The pole (w = 0) then sits BEHIND the model;
        // clamp the slope so it stays beyond farD. (With a growing w this branch
        // degenerates into ordinary forward perspective - the symmetric-slider bug.)
        m = Math.min(m, 0.85 * halfH / (farD - D)); // w(farD) >= 0.15
        const wN = 1 + (m / halfH) * (D - nearD);
        const wF = 1 - (m / halfH) * (farD - D);
        const alpha = -(wN + wF) / (farD - nearD);
        const beta = -wN + alpha * nearD;
        const e = cam.projectionMatrix.elements; // column-major
        e[10] = alpha; // z row: z_clip = alpha * z_cam + beta
        e[14] = beta;
        e[3] = 0;      // w row: w = a * z_cam + b, decreasing with depth
        e[7] = 0;
        e[11] = m / halfH;
        e[15] = (halfH + D * m) / halfH;
        cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }

    // Re-orient the camera to the yaw-slider direction (45deg detents around Y,
    // fixed isometric elevation +35.264deg), projection per the Persp slider.
    // reframe=false (yaw dragging): carry the current composition over - keep the
    // orbit target (pan) and the view scale, only the direction changes.
    // reframe=true (Frame button / model load): reset composition - center on the
    // model and fit it to the view.
    applyPreset(reframe = false) {
        if (!this.boundingSphere) { this.setStatus("no model loaded"); return; }
        const THREE = window.THREE;
        const s = this.boundingSphere;
        const yaw = THREE.MathUtils.degToRad(this.yawDeg ?? 45);
        const elev = Math.atan(1 / Math.SQRT2);
        const dir = new THREE.Vector3(
            Math.cos(elev) * Math.sin(yaw),
            Math.sin(elev),
            Math.cos(elev) * Math.cos(yaw),
        ).normalize();
        if (reframe || !this.controls) {
            // A full reset also clears any roll picked up from the gizmo.
            this.perspCam.up.set(0, 1, 0);
            this.orthoCam.up.set(0, 1, 0);
            this.placeCamera(dir, s.center.clone(), s.radius * 1.15);
        } else {
            this.placeCamera(dir, this.controls.target.clone(), this.currentHalfHeight());
        }
    }

    // Live foreshortening change: keep the current view direction, target and framing,
    // only swap the projection (slider input handler).
    setPerspectiveAmount() {
        if (!this.controls || !this.camera) return;
        const target = this.controls.target.clone();
        const dir = this.camera.position.clone().sub(target);
        if (dir.lengthSq() < 1e-12) dir.set(1, 1, 1);
        dir.normalize();
        this.placeCamera(dir, target, this.currentHalfHeight());
    }

    getPrefix() {
        const w = this.node.widgets?.find((x) => x.name === "filename_prefix");
        return (w?.value || "3d/ComfyUI") + "";
    }

    // Fetch the model file the viewport is showing and hand it to the browser as a
    // download, so a copy can be kept locally without the server holding onto it.
    async downloadModel() {
        if (!this.modelUrl) { this.setStatus("no model loaded"); return; }
        try {
            const resp = await fetch(this.modelUrl);
            if (!resp.ok) throw new Error(resp.statusText);
            const url = URL.createObjectURL(await resp.blob());
            const a = document.createElement("a");
            a.href = url;
            // Drop the temp-run token from the visible filename.
            a.download = this.modelFilename.replace(/_temp_[a-z]{5}/, "");
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            this.setStatus("downloaded " + a.download);
        } catch (e) {
            console.error("[save3d_snapshot] model download failed", e);
            this.setStatus("model download failed (see console)");
        }
    }

    // Render the current view at high resolution (longest side SNAPSHOT_MAX_DIM) and
    // return it as a PNG data URL. Renders synchronously right before capture, so the
    // WebGL buffer is guaranteed fresh; viewport size/pixel ratio are restored after.
    capturePNGDataURL() {
        const w = this.root.clientWidth, h = this.root.clientHeight;
        const scale = SNAPSHOT_MAX_DIM / Math.max(w, h);
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(Math.round(w * scale), Math.round(h * scale), false);
        if (this.reverseParams) this.applyReversePerspective();
        this.renderer.render(this.scene, this.camera);
        const dataURL = this.renderer.domElement.toDataURL("image/png");
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.setSize(w, h, false);
        return dataURL;
    }

    // Open the current view in a new tab without saving anything. Browsers refuse
    // top-level data: URLs, so the PNG goes through a blob URL; everything runs
    // synchronously inside the click handler to stay clear of popup blockers.
    openInTab() {
        if (!this.renderer || !this.modelRoot) { this.setStatus("no model loaded"); return; }
        try {
            const dataURL = this.capturePNGDataURL();
            const b64 = dataURL.split(",", 2)[1];
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
            const win = window.open(url, "_blank");
            if (!win) {
                this.setStatus("popup blocked - allow popups for this site");
            } else {
                this.setStatus("opened in a new tab (not saved)");
            }
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch (e) {
            console.error("[save3d_snapshot] open in tab failed", e);
            this.setStatus("open failed (see console)");
        }
    }

    async savePNG(btn) {
        if (!this.renderer || !this.modelRoot) { this.setStatus("no model loaded"); return; }
        try {
            btn.disabled = true;
            const dataURL = this.capturePNGDataURL();

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
        this.onGizmoPointerUp();
        this.gizmoScene?.traverse((o) => {
            o.geometry?.dispose();
            o.material?.dispose();
        });
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

            // `camera_state` is machinery, not a user control: the viewport writes the
            // current camera into it and Python turns it into the camera_info output.
            // Hide it from the node body (type "hidden" stops it being drawn, the zero
            // computeSize stops it reserving a row) while keeping it serialized, so the
            // framing survives page reloads and travels with the workflow JSON.
            const camWidget = this.widgets?.find((w) => w.name === "camera_state");
            if (camWidget) {
                camWidget.type = "hidden";
                camWidget.hidden = true;
                camWidget.computeSize = () => [0, -4];
            }

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
