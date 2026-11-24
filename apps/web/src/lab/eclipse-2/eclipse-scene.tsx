import { type RefObject, useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

import {
  LENS_FRAGMENT,
  LENS_VERTEX,
  RIM_CHUNK,
  RIM_HEADER,
  SKY_FRAGMENT,
  SKY_VERTEX,
} from "./eclipse-shaders";
import { CUT } from "./timeline";

export type EclipseStatus = "live" | "failed";

const MODEL_DIAMETER = 2;

const SLOT_UNITS = 2.08;

const CAMERA_REST_Z = 6;

const MAX_PIXEL_RATIO = 2;

const MAX_RENDER_PIXELS = 3_200_000;

const ACTIVE_FRAME_MS = 1000 / 60;

const CALM_FRAME_MS = 1000 / 30;

const POINTER_CALM_MS = 2500;

const BEAD_ANGLE = Math.PI / 4;

const HOLE_RADIUS = 0.4;

const SUN_EDGE = 0.965;

const POINTER_TILT = 0.09;

type Shot = {
  z: number;
  x: number;
  rotation: [number, number, number];
  drift: [number, number, number];
  sun: number;
  sunDrift: number;
};

const SHOT_A: Shot = {
  z: 8.6,
  x: 0.35,
  rotation: [-0.32, 1.12, 0.46],
  drift: [0.02, -0.16, 0.03],
  sun: 0.62,
  sunDrift: -0.08,
};

const SHOT_B: Shot = {
  z: 7.3,
  x: -0.28,
  rotation: [0.24, -0.86, -0.32],
  drift: [-0.02, 0.18, 0.02],
  sun: 0.36,
  sunDrift: -0.06,
};

const SHOT_C_ROTATION: [number, number, number] = [-0.16, 0.58, 0.24];

const SHOT_C_SUN = 0.24;

const SHOT_C_Z = 6.9;

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

const progress = (elapsed: number, delay: number, duration: number) =>
  clamp01((elapsed - delay) / duration);

const mix = (from: number, to: number, amount: number) =>
  from + (to - from) * amount;

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

const easeOutQuint = (t: number) => 1 - (1 - t) ** 5;

const bell = (value: number, at: number, width: number) =>
  Math.exp(-(((value - at) / width) ** 2));

const STUDIO_PANELS = [
  { w: 16, h: 16, color: [6, 3.6, 1.8], at: [0, 0, -9] },
  { w: 10, h: 2.4, color: [1.3, 1.35, 1.5], at: [0, 7, 5] },
  { w: 2, h: 9, color: [2.4, 1.3, 0.6], at: [8, 1, 1] },
  { w: 1.6, h: 7, color: [0.5, 0.7, 1.1], at: [-8, -1, 3] },
  { w: 12, h: 1.4, color: [0.9, 0.45, 0.2], at: [0, -6, 4] },
] as const;

function disposeMaterial(material: THREE.Material) {
  const standard = material as THREE.MeshPhysicalMaterial;
  standard.map?.dispose();
  standard.normalMap?.dispose();
  standard.roughnessMap?.dispose();
  standard.metalnessMap?.dispose();
  standard.emissiveMap?.dispose();
  standard.clearcoatMap?.dispose();
  material.dispose();
}

function disposeObject(object: THREE.Object3D) {
  const seen = new Set<THREE.Material>();
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();

    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];

    for (const material of materials) {
      if (!material || seen.has(material)) continue;
      seen.add(material);
      disposeMaterial(material);
    }
  });
}

function createEnvironment(renderer: THREE.WebGLRenderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const studio = new THREE.Scene();
  studio.background = new THREE.Color(0x020203);

  for (const panel of STUDIO_PANELS) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(panel.w, panel.h),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(panel.color[0], panel.color[1], panel.color[2]),
        side: THREE.DoubleSide,
      }),
    );

    mesh.position.set(panel.at[0], panel.at[1], panel.at[2]);
    mesh.lookAt(0, 0, 0);
    studio.add(mesh);
  }

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(5.5, 0.9, 16, 64),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 6, 3.4) }),
  );

  ring.position.set(0, 0, -6);
  studio.add(ring);

  const texture = pmrem.fromScene(studio, 0.035).texture;
  disposeObject(studio);
  pmrem.dispose();

  return texture;
}

function weldedNeighbours(geometry: THREE.BufferGeometry) {
  const position = geometry.attributes.position;
  const count = position.count;
  const canonical = new Int32Array(count);
  const byKey = new Map<number, number>();
  const span = 20001;

  for (let i = 0; i < count; i++) {
    const key =
      (Math.round(position.getX(i) * 1e4) + 10000) * span * span +
      (Math.round(position.getY(i) * 1e4) + 10000) * span +
      (Math.round(position.getZ(i) * 1e4) + 10000);

    const found = byKey.get(key);

    if (found === undefined) {
      byKey.set(key, i);
      canonical[i] = i;
    } else {
      canonical[i] = found;
    }
  }

  const index = geometry.index;
  const corners = index ? index.count : count;
  const corner = (i: number) => canonical[index ? index.getX(i) : i];
  const degree = new Int32Array(count + 1);

  for (let i = 0; i < corners; i += 3) {
    degree[corner(i)] += 2;
    degree[corner(i + 1)] += 2;
    degree[corner(i + 2)] += 2;
  }

  const offsets = new Int32Array(count + 1);

  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i] + degree[i];

  const fill = offsets.slice(0, count);
  const links = new Int32Array(offsets[count]);

  for (let i = 0; i < corners; i += 3) {
    const a = corner(i);
    const b = corner(i + 1);
    const c = corner(i + 2);
    links[fill[a]++] = b;
    links[fill[a]++] = c;
    links[fill[b]++] = a;
    links[fill[b]++] = c;
    links[fill[c]++] = a;
    links[fill[c]++] = b;
  }

  return { canonical, offsets, links };
}

type Welded = ReturnType<typeof weldedNeighbours>;

function relaxAttribute(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  { canonical, offsets, links }: Welded,
  passes: number[],
  normalize: boolean,
) {
  const count = attribute.count;
  let values = new Float32Array(count * 3);
  let next = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    values[i * 3] = attribute.getX(i);
    values[i * 3 + 1] = attribute.getY(i);
    values[i * 3 + 2] = attribute.getZ(i);
  }

  for (const weight of passes) {
    next.set(values);

    for (let vertex = 0; vertex < count; vertex++) {
      const from = offsets[vertex];
      const to = offsets[vertex + 1];

      if (to === from) continue;
      let x = 0;
      let y = 0;
      let z = 0;

      for (let k = from; k < to; k++) {
        const other = links[k] * 3;
        x += values[other];
        y += values[other + 1];
        z += values[other + 2];
      }

      const size = to - from;
      const base = vertex * 3;
      let nx = values[base] + (x / size - values[base]) * weight;
      let ny = values[base + 1] + (y / size - values[base + 1]) * weight;
      let nz = values[base + 2] + (z / size - values[base + 2]) * weight;

      if (normalize) {
        const length = Math.hypot(nx, ny, nz) || 1;
        nx /= length;
        ny /= length;
        nz /= length;
      }

      next[base] = nx;
      next[base + 1] = ny;
      next[base + 2] = nz;
    }

    [values, next] = [next, values];
  }

  for (let i = 0; i < count; i++) {
    const source = canonical[i] * 3;
    attribute.setXYZ(i, values[source], values[source + 1], values[source + 2]);
  }

  attribute.needsUpdate = true;
}

const TAUBIN_PASSES = Array.from({ length: 10 }, (_, i) =>
  i % 2 === 0 ? 0.5 : -0.53,
);

const NORMAL_PASSES = Array.from({ length: 6 }, () => 0.8);

function smoothSurface(geometry: THREE.BufferGeometry) {
  const welded = weldedNeighbours(geometry);
  relaxAttribute(geometry.attributes.position, welded, TAUBIN_PASSES, false);
  geometry.computeVertexNormals();
  relaxAttribute(geometry.attributes.normal, welded, NORMAL_PASSES, true);
}

function prepareModel(model: THREE.Object3D, material: THREE.Material) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const scale = MODEL_DIAMETER / Math.max(size.x, size.y);

  model.scale.setScalar(scale);
  model.position.sub(center.multiplyScalar(scale));

  const pivot = new THREE.Group();
  pivot.add(model);

  const replaced = new Set<THREE.Material>();
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geometry = child.geometry;
    smoothSurface(geometry);
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;

    if (!bounds) return;
    const extent = bounds.getSize(new THREE.Vector3());
    const position = geometry.attributes.position;
    const uvs = new Float32Array(position.count * 2);
    const uvScale = 0.8;
    const uvOffset = (1 - uvScale) / 2;

    for (let i = 0; i < position.count; i++) {
      uvs[i * 2] =
        ((position.getX(i) - bounds.min.x) / extent.x) * uvScale + uvOffset;
      uvs[i * 2 + 1] =
        ((position.getY(i) - bounds.min.y) / extent.y) * uvScale + uvOffset;
    }

    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));

    const existing = Array.isArray(child.material)
      ? child.material
      : [child.material];

    for (const old of existing) {
      if (!old || replaced.has(old)) continue;
      replaced.add(old);
      disposeMaterial(old);
    }

    child.material = material;
  });

  return pivot;
}

function canCreateWebGL() {
  try {
    const probe = document.createElement("canvas");

    return Boolean(probe.getContext("webgl2") ?? probe.getContext("webgl"));
  } catch {
    return false;
  }
}

export default function EclipseScene({
  slotRef,
  onStatus,
  clockRef,
}: {
  slotRef: RefObject<HTMLElement | null>;
  onStatus: (status: EclipseStatus) => void;
  clockRef: RefObject<number | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  useEffect(() => {
    const container = containerRef.current;
    const slot = slotRef.current;

    if (!container || !slot) return;

    if (!canCreateWebGL()) {
      statusRef.current("failed");

      return;
    }

    let renderer: THREE.WebGLRenderer;

    try {
      renderer = new THREE.WebGLRenderer({
        antialias: false,
        stencil: false,
        powerPreference: "high-performance",
      });
    } catch {
      statusRef.current("failed");

      return;
    }

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let disposed = false;
    let animationId = 0;
    let onScreen = true;
    let dirty = true;
    let layoutDirty = true;
    let layoutPixelRatio = 0;
    let lastFrameAt = 0;
    let lastPointerAt = Number.NEGATIVE_INFINITY;
    let pivot: THREE.Group | null = null;
    let announced = false;
    let width = 1;
    let height = 1;
    let pixelRatio = 1;

    renderer.setClearColor(0x000000, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.domElement.setAttribute("aria-hidden", "true");
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 0, SHOT_A.z);

    const envTexture = createEnvironment(renderer);
    scene.environment = envTexture;
    scene.environmentIntensity = 1;

    const backLightA = new THREE.DirectionalLight(0xffc68a, 7);
    backLightA.position.set(4, 4, -5);
    scene.add(backLightA);
    const backLightB = new THREE.DirectionalLight(0xff8a4a, 3.5);
    backLightB.position.set(-5, -3, -4);
    scene.add(backLightB);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.55);
    fill.position.set(-2, 3, 6);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0xffffff, 0.04));

    const skyUniforms = {
      uRes: { value: new THREE.Vector2(1, 1) },
      uCenter: { value: new THREE.Vector2(0, 0) },
      uRadius: { value: 100 },
      uTime: { value: 0 },
      uCorona: { value: 0 },
      uSun: { value: 1 },
      uSunShift: { value: new THREE.Vector2(0, 0) },
      uHoleMask: { value: 1 },
      uHole: { value: HOLE_RADIUS },
      uSunEdge: { value: SUN_EDGE },
    };

    const sky = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: skyUniforms,
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        depthTest: false,
        depthWrite: false,
      }),
    );

    sky.frustumCulled = false;
    sky.renderOrder = -1;
    scene.add(sky);

    const rimUniforms = {
      uRimColor: { value: new THREE.Color(1.0, 0.62, 0.3) },
      uRimStrength: { value: 0 },
      uBeadDir: {
        value: new THREE.Vector2(Math.cos(BEAD_ANGLE), Math.sin(BEAD_ANGLE)),
      },
    };

    const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 4,
    });

    const composer = new EffectComposer(renderer, renderTarget);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.08, 1.35);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const lens = new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          uRes: { value: new THREE.Vector2(1, 1) },
          uBead: { value: new THREE.Vector2(-1000, -1000) },
          uDisc: { value: new THREE.Vector2(-1000, -1000) },
          uDiscRadius: { value: 1 },
          uCrush: { value: 0 },
          uFlare: { value: 0 },
          uTime: { value: 0 },
          uGrain: { value: 0.035 },
        },
        vertexShader: LENS_VERTEX,
        fragmentShader: LENS_FRAGMENT,
      }),
    );

    composer.addPass(lens);

    const pointerTarget = { x: 0, y: 0 };
    const pointer = { x: 0, y: 0 };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointerTarget.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointerTarget.y = (event.clientY / window.innerHeight) * 2 - 1;
      lastPointerAt = performance.now();
    };

    if (!reducedMotion) {
      window.addEventListener("pointermove", handlePointerMove);
    }

    const visibility = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;

      if (onScreen) dirty = true;
    });

    visibility.observe(container);

    const markLayoutDirty = () => {
      layoutDirty = true;
    };

    const resizes = new ResizeObserver(markLayoutDirty);
    resizes.observe(container);
    resizes.observe(slot);
    window.addEventListener("resize", markLayoutDirty);

    const syncLayout = () => {
      const bounds = container.getBoundingClientRect();
      const slotBounds = slot.getBoundingClientRect();
      width = Math.round(bounds.width);
      height = Math.round(bounds.height);

      if (width === 0 || height === 0 || slotBounds.height === 0) return false;

      pixelRatio = Math.max(
        1,
        Math.min(
          window.devicePixelRatio,
          MAX_PIXEL_RATIO,
          Math.sqrt(MAX_RENDER_PIXELS / (width * height)),
        ),
      );

      const centerX = slotBounds.left + slotBounds.width / 2 - bounds.left;
      const centerY = slotBounds.top + slotBounds.height / 2 - bounds.top;
      const halfWidth = Math.max(centerX, width - centerX);
      const halfHeight = Math.max(centerY, height - centerY);
      const unitsPerPixel = SLOT_UNITS / slotBounds.height;
      const fullHeightUnits = halfHeight * 2 * unitsPerPixel;

      camera.aspect = halfWidth / halfHeight;
      camera.fov = THREE.MathUtils.radToDeg(
        2 * Math.atan(fullHeightUnits / 2 / CAMERA_REST_Z),
      );
      camera.setViewOffset(
        halfWidth * 2,
        halfHeight * 2,
        halfWidth - centerX,
        halfHeight - centerY,
        width,
        height,
      );

      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height);
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      bloom.resolution.set(width * pixelRatio, height * pixelRatio);
      skyUniforms.uRes.value.set(width * pixelRatio, height * pixelRatio);
      lens.uniforms.uRes.value.set(width * pixelRatio, height * pixelRatio);
      layoutPixelRatio = window.devicePixelRatio;
      dirty = true;

      return true;
    };

    const projected = new THREE.Vector3();
    const edgePoint = new THREE.Vector3();

    const toPixels = (point: THREE.Vector3) => {
      projected.copy(point).project(camera);

      return {
        x: (projected.x * 0.5 + 0.5) * width * pixelRatio,
        y: (projected.y * 0.5 + 0.5) * height * pixelRatio,
      };
    };

    const frame = (now: number) => {
      animationId = requestAnimationFrame(frame);

      if (!onScreen || !pivot) return;

      if (layoutDirty || window.devicePixelRatio !== layoutPixelRatio) {
        if (!syncLayout()) return;
        layoutDirty = false;
      }

      if (reducedMotion && !dirty) return;

      const clock = clockRef.current;

      const elapsed = reducedMotion
        ? Number.POSITIVE_INFINITY
        : clock === null
          ? 0
          : (now - clock) / 1000;

      const calm =
        elapsed > CUT.settle && now - lastPointerAt > POINTER_CALM_MS;

      const frameMs = calm ? CALM_FRAME_MS : ACTIVE_FRAME_MS;

      if (!dirty && now - lastFrameAt < frameMs - 2) return;

      const step = Math.min(now - lastFrameAt, 100);
      lastFrameAt = now;
      dirty = false;

      const seconds = reducedMotion ? 12 : now / 1000;
      const idle = easeInOutCubic(progress(elapsed, CUT.totality - 0.2, 1.8));

      const follow = 1 - 0.94 ** (step / ACTIVE_FRAME_MS);
      pointer.x += (pointerTarget.x - pointer.x) * follow;
      pointer.y += (pointerTarget.y - pointer.y) * follow;

      let cameraZ: number;
      let cameraX: number;
      let rotation: [number, number, number];
      let sunShift: number;

      if (elapsed < CUT.card2 || elapsed < CUT.card3) {
        const shot = elapsed < CUT.card2 ? SHOT_A : SHOT_B;
        const local = elapsed - (elapsed < CUT.card2 ? CUT.shotA : CUT.shotB);
        cameraZ = shot.z - local * 0.25;
        cameraX = shot.x;
        rotation = [
          shot.rotation[0] + shot.drift[0] * local,
          shot.rotation[1] + shot.drift[1] * local,
          shot.rotation[2] + shot.drift[2] * local,
        ];
        sunShift = shot.sun + shot.sunDrift * local;
      } else {
        const approach = progress(
          elapsed,
          CUT.shotC - 0.4,
          CUT.totality - CUT.shotC + 0.4,
        );

        const turn = easeInOutCubic(
          progress(elapsed, CUT.shotC - 0.3, CUT.totality - CUT.shotC + 0.55),
        );

        cameraZ = mix(
          SHOT_C_Z,
          CAMERA_REST_Z,
          easeOutQuint(
            progress(elapsed, CUT.shotC - 0.3, CUT.totality - CUT.shotC + 1.1),
          ),
        );
        cameraX = 0;
        rotation = [
          mix(SHOT_C_ROTATION[0], 0, turn),
          mix(SHOT_C_ROTATION[1], 0, turn),
          mix(SHOT_C_ROTATION[2], 0, turn),
        ];
        sunShift = SHOT_C_SUN * (1 - approach) ** 0.9;
      }

      camera.position.set(
        cameraX + pointer.x * 0.12 * idle,
        -pointer.y * 0.08 * idle,
        cameraZ,
      );
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();

      pivot.rotation.set(
        rotation[0] +
          (pointer.y * POINTER_TILT + Math.sin(seconds * 0.27) * 0.03) * idle,
        rotation[1] +
          (pointer.x * POINTER_TILT + Math.sin(seconds * 0.19) * 0.04) * idle,
        rotation[2] + Math.sin(seconds * 0.11) * 0.05 * idle,
      );

      const corona = Math.max(
        0.1,
        easeOutCubic(progress(elapsed, CUT.diamond, 0.75)),
      );

      const diamond =
        progress(elapsed, CUT.shotC + 0.2, CUT.diamond - CUT.shotC - 0.2) ** 2;

      const flare =
        elapsed < CUT.diamond
          ? diamond * 2.3
          : mix(2.3, 1, easeOutCubic(progress(elapsed, CUT.diamond, 1.1)));

      const strike = bell(elapsed, CUT.totality + 0.06, 0.16);

      rimUniforms.uRimStrength.value = mix(1.2, 2.2, corona);
      scene.environmentIntensity = mix(0.22, 0.3, corona);

      pivot.updateMatrixWorld();
      const center = toPixels(edgePoint.set(0, 0, 0));
      const right = toPixels(edgePoint.set(1, 0, 0));
      const radius = Math.hypot(right.x - center.x, right.y - center.y);

      skyUniforms.uCenter.value.set(center.x, center.y);
      skyUniforms.uRadius.value = radius * 1.01;
      skyUniforms.uTime.value = seconds;
      skyUniforms.uCorona.value = corona;
      skyUniforms.uSunShift.value.set(
        Math.cos(BEAD_ANGLE) * sunShift,
        Math.sin(BEAD_ANGLE) * sunShift,
      );
      skyUniforms.uHoleMask.value = progress(elapsed, CUT.shotC, 0.6);
      skyUniforms.uSun.value = mix(
        0.55,
        1,
        progress(elapsed, CUT.shotC, CUT.diamond - CUT.shotC),
      );
      bloom.strength = 0.3 + strike * 0.9;
      lens.uniforms.uBead.value.set(
        center.x + Math.cos(BEAD_ANGLE) * radius * 0.99,
        center.y + Math.sin(BEAD_ANGLE) * radius * 0.99,
      );
      lens.uniforms.uDisc.value.set(center.x, center.y);
      lens.uniforms.uDiscRadius.value = radius;
      lens.uniforms.uCrush.value = progress(elapsed, CUT.shotC, 0.8);
      lens.uniforms.uFlare.value = flare;
      lens.uniforms.uTime.value = seconds;

      composer.render();

      if (!announced) {
        announced = true;
        container.dataset.live = "true";
        statusRef.current("live");
      }
    };

    const fail = (error: unknown) => {
      if (disposed) return;
      console.warn("Omnyo eclipse fell back to the poster", error);
      container.dataset.live = "false";
      statusRef.current("failed");
    };

    renderer.domElement.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      fail("context lost");
    });

    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

    Promise.all([
      new THREE.TextureLoader().loadAsync("/logo.png"),
      new GLTFLoader().loadAsync("/model.glb"),
    ])
      .then(([texture, gltf]) => {
        if (disposed) {
          texture.dispose();
          disposeObject(gltf.scene);

          return;
        }

        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = maxAnisotropy;

        const material = new THREE.MeshPhysicalMaterial({
          map: texture,
          color: new THREE.Color().setScalar(0.34),
          metalness: 1,
          roughness: 0.34,
          clearcoat: 0.55,
          clearcoatRoughness: 0.16,
          emissive: new THREE.Color(0x000000),
        });

        material.onBeforeCompile = (shader) => {
          Object.assign(shader.uniforms, rimUniforms);
          shader.fragmentShader = `${RIM_HEADER}\n${shader.fragmentShader.replace(
            "#include <emissivemap_fragment>",
            RIM_CHUNK,
          )}`;
        };

        pivot = prepareModel(gltf.scene, material);
        pivot.rotation.set(...SHOT_A.rotation);
        scene.add(pivot);
        dirty = true;
      })
      .catch(fail);

    animationId = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(animationId);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("resize", markLayoutDirty);
      visibility.disconnect();
      resizes.disconnect();

      if (pivot) disposeObject(pivot);
      disposeObject(sky);
      lens.material.dispose();
      bloom.dispose();
      composer.dispose();
      renderTarget.dispose();
      envTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [slotRef, clockRef]);

  return <div ref={containerRef} className="e2-stage" aria-hidden="true" />;
}
