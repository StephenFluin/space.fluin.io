import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';

export type ViewerMode = 'orbit' | 'walk';

export interface ModelStats {
  triangles: number;
  x: number;
  y: number;
  z: number;
}

const MOVE_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
]);

/**
 * Framework-free three.js scene used by the explorer page: orbit and first-person walk
 * navigation, colour/clay/wireframe display and a horizontal cut-away plane.
 */
export class ModelViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.01, 10_000);
  private readonly orbit: OrbitControls;
  private readonly walk: PointerLockControls;
  private readonly grid = new THREE.GridHelper(1, 20, 0x5a6573, 0x343b46);
  private readonly cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e9);
  private readonly pivot = new THREE.Group();
  private readonly clay = new THREE.MeshStandardMaterial({
    color: 0xc9c4bb,
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  private readonly resize: ResizeObserver;
  private readonly clock = new THREE.Clock();
  private readonly keys = new Set<string>();
  private originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private model?: THREE.Object3D;
  private bounds = new THREE.Box3();
  private mode: ViewerMode = 'orbit';
  private colours = true;
  private wireframe = false;
  private cut = 1;
  private frame = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly events: { onLock: (locked: boolean) => void },
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.clippingPlanes = [this.cutPlane];
    this.scene.background = new THREE.Color(0x1b1f26);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4036, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 2, 1.5);
    this.scene.add(sun, this.grid, this.pivot);

    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.enableDamping = true;
    this.orbit.listenToKeyEvents(canvas);

    this.walk = new PointerLockControls(this.camera, canvas);
    this.walk.addEventListener('lock', () => this.events.onLock(true));
    this.walk.addEventListener('unlock', () => this.events.onLock(false));
    canvas.addEventListener('click', this.onCanvasClick);

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(canvas);
    this.fit();
    this.loop();
  }

  load(url: string, onProgress: (fraction: number) => void): Promise<ModelStats> {
    return new Promise((resolve, reject) => {
      // Official Blender builds Draco-compress the GLB; the decoder is served from /draco/.
      const loader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath('/draco/'));
      loader.load(
        url,
        (gltf) => {
          if (this.model) this.pivot.remove(this.model);
          this.model = gltf.scene;
          this.originals.clear();
          let triangles = 0;
          this.model.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              const geo = o.geometry as THREE.BufferGeometry;
              triangles += (geo.index?.count ?? geo.attributes['position'].count) / 3;
              const mats = Array.isArray(o.material) ? o.material : [o.material];
              for (const m of mats) m.side = THREE.DoubleSide;
              this.originals.set(o, o.material);
            }
          });
          this.pivot.add(this.model);
          this.ground();
          this.applyMaterials();
          this.resetCamera();
          const size = this.bounds.getSize(new THREE.Vector3());
          // GLB is Y-up; report as X (width) × Y (depth) × Z (height) to match the STL.
          resolve({ triangles, x: size.x, y: size.z, z: size.y });
        },
        (e) => e.total && onProgress(e.loaded / e.total),
        reject,
      );
    });
  }

  setMode(mode: ViewerMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.orbit.enabled = mode === 'orbit';
    if (mode === 'orbit') {
      this.walk.unlock();
      this.resetCamera();
    } else {
      // Drop to roughly eye height for a 2.5 m room, scaled to the model.
      const size = this.bounds.getSize(new THREE.Vector3());
      const centre = this.bounds.getCenter(new THREE.Vector3());
      this.camera.position.set(
        centre.x,
        this.bounds.min.y + Math.min(size.y * 0.6, size.y - 0.01),
        centre.z,
      );
      this.camera.lookAt(centre.x + 1, this.camera.position.y, centre.z);
    }
  }

  setColours(on: boolean) {
    this.colours = on;
    this.applyMaterials();
  }

  setWireframe(on: boolean) {
    this.wireframe = on;
    this.applyMaterials();
  }

  setGrid(on: boolean) {
    this.grid.visible = on;
  }

  /** Keep geometry below `fraction` of the model's height. */
  setCut(fraction: number) {
    this.cut = fraction;
    this.updateCut();
  }

  rotate(axis: 'x' | 'z') {
    if (!this.model) return;
    this.pivot.rotateOnWorldAxis(
      axis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1),
      Math.PI / 2,
    );
    this.ground();
    this.resetCamera();
  }

  resetCamera() {
    const size = this.bounds.getSize(new THREE.Vector3()).length() || 1;
    const centre = this.bounds.getCenter(new THREE.Vector3());
    this.camera.near = size / 1000;
    this.camera.far = size * 20;
    this.camera.updateProjectionMatrix();
    if (this.mode === 'walk') {
      this.mode = 'orbit';
      this.setMode('walk');
      return;
    }
    this.camera.position
      .copy(centre)
      .add(new THREE.Vector3(0.6, 0.5, 0.8).multiplyScalar(size * 0.9));
    this.orbit.target.copy(centre);
    this.orbit.update();
  }

  key(e: KeyboardEvent, down: boolean) {
    if (this.mode !== 'walk' || !MOVE_KEYS.has(e.code)) return;
    if ((e.target as HTMLElement | null)?.closest('input, select, textarea')) return;
    e.preventDefault();
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.canvas.removeEventListener('click', this.onCanvasClick);
    this.orbit.dispose();
    this.walk.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      }
    });
    this.clay.dispose();
    this.renderer.dispose();
  }

  private readonly onCanvasClick = () => {
    if (this.mode === 'walk') this.walk.lock();
  };

  /** Centre the model on the origin, sitting on the grid. */
  private ground() {
    if (!this.model) return;
    this.pivot.position.set(0, 0, 0);
    this.pivot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.pivot);
    const centre = box.getCenter(new THREE.Vector3());
    this.pivot.position.set(-centre.x, -box.min.y, -centre.z);
    this.pivot.updateMatrixWorld(true);
    this.bounds.setFromObject(this.pivot);
    const size = this.bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z) * 1.4;
    this.grid.scale.setScalar(span);
    this.updateCut();
  }

  private updateCut() {
    const h = this.bounds.max.y - this.bounds.min.y;
    this.cutPlane.constant = this.cut >= 0.999 ? 1e9 : this.bounds.min.y + h * this.cut;
  }

  private applyMaterials() {
    this.clay.wireframe = this.wireframe;
    for (const [mesh, original] of this.originals) {
      mesh.material = this.colours ? original : this.clay;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        (m as THREE.MeshStandardMaterial).wireframe = this.wireframe;
      }
    }
  }

  private fit() {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.mode === 'walk') this.move(dt);
    else this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  };

  private move(dt: number) {
    if (!this.keys.size) return;
    const size = this.bounds.getSize(new THREE.Vector3());
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = Math.max(size.x, size.z) * 0.12 * (fast ? 3 : 1) * dt;
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    const forward = k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown');
    const right = k('KeyD') - k('KeyA');
    const turn = k('ArrowRight') - k('ArrowLeft');
    if (forward) this.walk.moveForward(forward * speed);
    if (right) this.walk.moveRight(right * speed);
    if (turn) this.camera.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), -turn * 1.5 * dt);
    this.camera.position.y += (k('KeyE') - k('KeyQ')) * speed;
  }
}
