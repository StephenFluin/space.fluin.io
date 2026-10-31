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
  'KeyC',
  'Space',
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
  /** Robust interior start point: median position at eye height between floor and ceiling. */
  private inside = new THREE.Vector3();
  private mode: ViewerMode = 'walk';
  private interior = false;
  private speed = 1;
  private colours = true;
  private wireframe = false;
  private cut = 1;
  private frame = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly events: {
      onLock: (locked: boolean) => void;
      onSpeed: (multiplier: number) => void;
    },
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
    this.orbit.enabled = false;

    this.walk = new PointerLockControls(this.camera, canvas);
    this.walk.addEventListener('lock', () => this.events.onLock(true));
    this.walk.addEventListener('unlock', () => this.events.onLock(false));
    canvas.addEventListener('click', this.onCanvasClick);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });

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
    } else if (this.interior) {
      this.camera.position.copy(this.inside);
      this.camera.lookAt(this.inside.x + 1, this.inside.y, this.inside.z);
    } else {
      // Exteriors: start where orbit would, outside and looking at the building, then fly in.
      this.orbitPose();
    }
  }

  /** Interiors start walk mode inside the room; exteriors start outside looking in. */
  setInterior(on: boolean) {
    if (on === this.interior) return;
    this.interior = on;
    if (this.mode === 'walk') this.resetCamera();
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
    this.orbitPose();
  }

  private orbitPose() {
    const size = this.bounds.getSize(new THREE.Vector3()).length() || 1;
    const centre = this.bounds.getCenter(new THREE.Vector3());
    this.camera.position
      .copy(centre)
      .add(new THREE.Vector3(0.6, 0.5, 0.8).multiplyScalar(size * 0.9));
    this.orbit.target.copy(centre);
    this.orbit.update();
    this.camera.lookAt(centre);
  }

  key(e: KeyboardEvent, down: boolean) {
    if (this.mode !== 'walk' || !MOVE_KEYS.has(e.code)) return;
    // Leave Space and friends to focused controls (buttons, sliders) unless the mouse is captured.
    const target = e.target as HTMLElement | null;
    if (!this.walk.isLocked && target?.closest('input, select, textarea, button, a')) return;
    // Ctrl is deliberately unused: Ctrl+W (descend while moving forward) would close the tab.
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.canvas.removeEventListener('click', this.onCanvasClick);
    this.canvas.removeEventListener('wheel', this.onWheel);
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

  /** Scroll adjusts walking speed, as in Unity's and Unreal's fly cameras. */
  private readonly onWheel = (e: WheelEvent) => {
    if (this.mode !== 'walk') return;
    e.preventDefault();
    const next = this.speed * (e.deltaY < 0 ? 1.25 : 0.8);
    this.speed = Math.min(16, Math.max(1 / 16, next));
    this.events.onSpeed(this.speed);
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
    this.findInside();
    const size = this.bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z) * 1.4;
    this.grid.scale.setScalar(span);
    this.updateCut();
  }

  /**
   * Bounding boxes are stretched by stray noise, so their centre can sit outside the room. Use the
   * median of the geometry instead, at 60% of the way from floor (5th percentile) to ceiling (95th).
   */
  private findInside() {
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    const v = new THREE.Vector3();
    this.model?.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const pos = (o.geometry as THREE.BufferGeometry).attributes['position'];
      const step = Math.max(1, Math.floor(pos.count / 20_000));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        xs.push(v.x);
        ys.push(v.y);
        zs.push(v.z);
      }
    });
    if (!xs.length) {
      this.bounds.getCenter(this.inside);
      return;
    }
    const at = (a: number[], q: number) => a.sort((m, n) => m - n)[Math.floor((a.length - 1) * q)];
    const floor = at(ys, 0.05);
    const ceiling = at(ys, 0.95);
    this.inside.set(at(xs, 0.5), floor + (ceiling - floor) * 0.6, at(zs, 0.5));
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
    const speed = Math.max(size.x, size.z) * 0.12 * this.speed * (fast ? 3 : 1) * dt;
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    const forward = k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown');
    const right = k('KeyD') - k('KeyA');
    const turn = k('ArrowRight') - k('ArrowLeft');
    if (forward) this.walk.moveForward(forward * speed);
    if (right) this.walk.moveRight(right * speed);
    if (turn) this.camera.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), -turn * 1.5 * dt);
    const up = k('Space') + k('KeyE') - k('KeyC') - k('KeyQ');
    this.camera.position.y += up * speed;
  }
}
