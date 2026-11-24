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

export type EclipseStatus = "live" | "failed";

const MODEL_DIAMETER = 2;

const SLOT_UNITS = 2.16;

const CAMERA_REST_Z = 6;

const CAMERA_START_Z = 7.6;

const MAX_PIXEL_RATIO = 2;

const MAX_RENDER_PIXELS = 3_200_000;

const ACTIVE_FRAME_MS = 1000 / 60;

const CALM_FRAME_MS = 1000 / 30;

const POINTER_CALM_MS = 2500;

const TURN_DELAY_MS = 400;

const TURN_MS = 3700;

const TOTALITY_MS = TURN_DELAY_MS + TURN_MS;

const SETTLE_MS = TOTALITY_MS + 2200;

const MIN_TURN_MS = 1500;

const BEAD_ANGLE = Math.PI / 4;

const HOLE_RADIUS = 0.4;

const SUN_EDGE = 0.985;

const POINTER_TILT = 0.06;

const START_ROTATION = { x: -0.08, y: 1.12, z: 0.14 };

const SMOOTH_PASSES = 40;

const LIMB_PERCENTILE = 1;

const LIMB_MARGIN = 1.004;

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

const progress = (elapsed: number, delay: number, duration: number) =>
  clamp01((elapsed - delay) / duration);

const mix = (from: number, to: number, amount: number) =>
  from + (to - from) * amount;

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

const STUDIO_PANELS = [
  { w: 16, h: 16, color: [3.2, 2.6, 2.0], at: [0, 0, -9] },
  { w: 10, h: 1.6, color: [1.1, 1.12, 1.2], at: [0, 7, 5] },
  { w: 1.4, h: 9, color: [1.8, 1.4, 1.0], at: [8, 1, 1] },
  { w: 1.2, h: 7, color: [0.35, 0.4, 0.5], at: [-8, -1, 3] },
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
  studio.background = new THREE.Color(0x000000);

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
    new THREE.TorusGeometry(5.5, 0.5, 16, 64),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(7, 6.4, 5.4) }),
  );

  ring.position.set(0, 0, -6);
  studio.add(ring);

  const texture = pmrem.fromScene(studio, 0.02).texture;
  disposeObject(studio);
  pmrem.dispose();

  return texture;
}

function buildNeighbours(index: ArrayLike<number>, count: number) {
  const degree = new Uint32Array(count + 1);

  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] ?? 0;
    const b = index[i + 1] ?? 0;
    const c = index[i + 2] ?? 0;
    degree[a] = (degree[a] ?? 0) + 2;
    degree[b] = (degree[b] ?? 0) + 2;
    degree[c] = (degree[c] ?? 0) + 2;
  }

  const offsets = new Uint32Array(count + 1);

  for (let i = 0; i < count; i++) {
    offsets[i + 1] = (offsets[i] ?? 0) + (degree[i] ?? 0);
  }

  const cursor = offsets.slice(0, count);
  const neighbours = new Uint32Array(offsets[count] ?? 0);

  const push = (from: number, to: number) => {
    const at = cursor[from] ?? 0;

    neighbours[at] = to;
    cursor[from] = at + 1;
  };

  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] ?? 0;
    const b = index[i + 1] ?? 0;
    const c = index[i + 2] ?? 0;
    push(a, b);
    push(a, c);
    push(b, a);
    push(b, c);
    push(c, a);
    push(c, b);
  }

  return { offsets, neighbours };
}

function smoothGeometry(source: THREE.BufferGeometry) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", source.getAttribute("position").clone());

  if (source.index) geometry.setIndex(source.index.clone());

  const index = geometry.index;
  const position = geometry.getAttribute("position");

  if (!index) return geometry;
  const count = position.count;
  const { offsets, neighbours } = buildNeighbours(index.array, count);
  const current = new Float32Array(position.array);
  const next = new Float32Array(current.length);

  const relax = (factor: number) => {
    for (let v = 0; v < count; v++) {
      const start = offsets[v] ?? 0;
      const end = offsets[v + 1] ?? 0;
      const base = v * 3;
      const x = current[base] ?? 0;
      const y = current[base + 1] ?? 0;
      const z = current[base + 2] ?? 0;

      if (end === start) {
        next[base] = x;
        next[base + 1] = y;
        next[base + 2] = z;
        continue;
      }

      let sx = 0;
      let sy = 0;
      let sz = 0;

      for (let k = start; k < end; k++) {
        const n = (neighbours[k] ?? 0) * 3;
        sx += current[n] ?? 0;
        sy += current[n + 1] ?? 0;
        sz += current[n + 2] ?? 0;
      }

      const inv = 1 / (end - start);
      next[base] = x + factor * (sx * inv - x);
      next[base + 1] = y + factor * (sy * inv - y);
      next[base + 2] = z + factor * (sz * inv - z);
    }

    current.set(next);
  };

  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    relax(0.5);
    relax(-0.53);
  }

  position.array.set(current);
  position.needsUpdate = true;
  geometry.computeVertexNormals();

  return geometry;
}

function prepareModel(model: THREE.Object3D, material: THREE.Material) {
  const replaced = new Set<THREE.Material>();
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const original = child.geometry as THREE.BufferGeometry;
    const geometry = smoothGeometry(original);
    original.dispose();
    child.geometry = geometry;

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

  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const scale = MODEL_DIAMETER / Math.max(size.x, size.y);

  model.scale.setScalar(scale);
  model.position.sub(center.multiplyScalar(scale));

  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geometry = child.geometry as THREE.BufferGeometry;
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;

    if (!bounds) return;
    const extent = bounds.getSize(new THREE.Vector3());
    const position = geometry.attributes.position;

    if (!position) return;
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
  });

  const pivot = new THREE.Group();
  pivot.add(model);
  pivot.updateMatrixWorld(true);
  const limbScale = measureLimb(model) * LIMB_MARGIN;

  const occluder = new THREE.Mesh(
    new THREE.CircleGeometry(limbScale, 192),
    new THREE.MeshBasicMaterial({ color: 0x000000 }),
  );

  pivot.add(occluder);

  return { pivot, limbScale };
}

function measureLimb(model: THREE.Object3D) {
  const reach: number[] = [];
  const point = new THREE.Vector3();

  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    const position = (child.geometry as THREE.BufferGeometry).attributes
      .position;

    if (!position) return;

    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(child.matrixWorld);
      reach.push(
        (Math.hypot(point.x, point.y) * CAMERA_REST_Z) /
          (CAMERA_REST_Z - point.z),
      );
    }
  });

  if (reach.length === 0) return 1;
  reach.sort((a, b) => a - b);

  return reach[Math.floor((reach.length - 1) * LIMB_PERCENTILE)] ?? 1;
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
  startedAt,
}: {
  slotRef: RefObject<HTMLElement | null>;
  onStatus: (status: EclipseStatus) => void;
  startedAt: number;
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

    const assets = Promise.all([
      new THREE.TextureLoader().loadAsync("/logo.png"),
      new GLTFLoader().loadAsync("/model.glb"),
    ]);

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
    let limbScale = 1;
    let introAt = 0;
    let ready = false;
    let announced = false;
    let width = 1;
    let height = 1;
    let pixelRatio = 1;

    renderer.setClearColor(0x000000, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.domElement.setAttribute("aria-hidden", "true");
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 0, CAMERA_START_Z);

    const envTexture = createEnvironment(renderer);
    scene.environment = envTexture;
    scene.environmentIntensity = 0.12;

    const backLightA = new THREE.DirectionalLight(0xfff0dc, 6);
    backLightA.position.set(4, 4, -5);
    scene.add(backLightA);
    const backLightB = new THREE.DirectionalLight(0xffd2a6, 2.2);
    backLightB.position.set(-5, -3, -4);
    scene.add(backLightB);

    const skyUniforms = {
      uRes: { value: new THREE.Vector2(1, 1) },
      uCenter: { value: new THREE.Vector2(0, 0) },
      uRadius: { value: 100 },
      uSunRadius: { value: 100 },
      uTime: { value: 0 },
      uCorona: { value: 0 },
      uSun: { value: 1 },
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
      uRimColor: { value: new THREE.Color(1.0, 0.86, 0.68) },
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
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.05, 2.6);
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
          uGrain: { value: 0.018 },
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

      if (!onScreen || !pivot || !ready) return;

      if (layoutDirty || window.devicePixelRatio !== layoutPixelRatio) {
        if (!syncLayout()) return;
        layoutDirty = false;
      }

      if (reducedMotion && !dirty) return;

      if (introAt === 0) {
        introAt = now - Math.min(now - startedAt, TOTALITY_MS - MIN_TURN_MS);
      }

      const elapsed = reducedMotion ? Infinity : now - introAt;

      const calm = elapsed > SETTLE_MS && now - lastPointerAt > POINTER_CALM_MS;

      const frameMs = calm ? CALM_FRAME_MS : ACTIVE_FRAME_MS;

      if (!dirty && now - lastFrameAt < frameMs - 2) return;

      const step = Math.min(now - lastFrameAt, 100);
      lastFrameAt = now;
      dirty = false;

      const seconds = reducedMotion ? 12 : (now - introAt) / 1000;
      const turn = easeInOutCubic(progress(elapsed, TURN_DELAY_MS, TURN_MS));
      const corona = easeInOutSine(progress(elapsed, TOTALITY_MS - 1900, 2600));
      const sun = 1 - progress(elapsed, TOTALITY_MS - 150, 500);
      const ignite = easeOutCubic(progress(elapsed, TOTALITY_MS - 380, 380));
      const fade = easeInOutSine(progress(elapsed, TOTALITY_MS, 1900));
      const flare = ignite * mix(1.5, 0.62, fade);
      const idle = easeInOutSine(progress(elapsed, TOTALITY_MS, 2400));

      const follow = 1 - 0.95 ** (step / ACTIVE_FRAME_MS);
      pointer.x += (pointerTarget.x - pointer.x) * follow;
      pointer.y += (pointerTarget.y - pointer.y) * follow;

      camera.position.set(
        pointer.x * 0.08 * idle,
        -pointer.y * 0.06 * idle,
        mix(
          CAMERA_START_Z,
          CAMERA_REST_Z,
          easeInOutSine(progress(elapsed, 0, TOTALITY_MS + 800)),
        ),
      );
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();

      pivot.rotation.set(
        mix(START_ROTATION.x, 0, turn) +
          (pointer.y * POINTER_TILT + Math.sin(seconds * 0.23) * 0.018) * idle,
        mix(START_ROTATION.y, 0, turn) +
          (pointer.x * POINTER_TILT + Math.sin(seconds * 0.17) * 0.024) * idle,
        mix(START_ROTATION.z, 0, turn),
      );

      rimUniforms.uRimStrength.value = mix(0.9, 1.6, corona);

      pivot.updateMatrixWorld();
      const center = toPixels(edgePoint.set(0, 0, 0));
      const right = toPixels(edgePoint.set(1, 0, 0));
      const radius = Math.hypot(right.x - center.x, right.y - center.y);
      const limb = radius * limbScale;

      skyUniforms.uCenter.value.set(center.x, center.y);
      skyUniforms.uRadius.value = mix(radius, limb, turn);
      skyUniforms.uSunRadius.value = radius;
      skyUniforms.uTime.value = seconds;
      skyUniforms.uCorona.value = corona;
      skyUniforms.uSun.value = sun;
      lens.uniforms.uBead.value.set(
        center.x + Math.cos(BEAD_ANGLE) * limb * 0.985,
        center.y + Math.sin(BEAD_ANGLE) * limb * 0.985,
      );
      lens.uniforms.uDisc.value.set(center.x, center.y);
      lens.uniforms.uDiscRadius.value = limb;
      lens.uniforms.uCrush.value = turn * turn;
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

    if (syncLayout()) {
      layoutDirty = false;
      composer.render();
    }

    assets
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
          color: new THREE.Color().setScalar(0.22),
          metalness: 1,
          roughness: 0.24,
          clearcoat: 1,
          clearcoatRoughness: 0.04,
          emissive: new THREE.Color(0x000000),
        });

        material.onBeforeCompile = (shader) => {
          Object.assign(shader.uniforms, rimUniforms);
          shader.fragmentShader = `${RIM_HEADER}\n${shader.fragmentShader.replace(
            "#include <emissivemap_fragment>",
            RIM_CHUNK,
          )}`;
        };

        const prepared = prepareModel(gltf.scene, material);
        pivot = prepared.pivot;
        limbScale = prepared.limbScale;
        pivot.rotation.set(
          START_ROTATION.x,
          START_ROTATION.y,
          START_ROTATION.z,
        );
        scene.add(pivot);

        return renderer.compileAsync(scene, camera);
      })
      .then(() => {
        if (disposed) return;
        ready = true;
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
  }, [slotRef, startedAt]);

  return <div ref={containerRef} className="e1-stage" aria-hidden="true" />;
}
