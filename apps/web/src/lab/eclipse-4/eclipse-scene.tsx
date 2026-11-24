import { type RefObject, useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

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

const SLOT_UNITS = 2.08;

const CAMERA_REST_Z = 6;

const CAMERA_START_Z = 6.9;

const MAX_PIXEL_RATIO = 2;

const MAX_RENDER_PIXELS = 3_200_000;

const ACTIVE_FRAME_MS = 1000 / 60;

const CALM_FRAME_MS = 1000 / 30;

const POINTER_CALM_MS = 2500;

const TURN_MS = 2600;

const SETTLE_MS = 5200;

const BEAD_ANGLE = Math.PI / 4;

const HOLE_RADIUS = 0.4;

const SUN_EDGE = 0.965;

const MOON_SCALE = 1.075;

const POINTER_TILT = 0.11;

const START_ROTATION = { x: -0.18, y: 0.82, z: 0.32 };

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

const progress = (elapsed: number, delay: number, duration: number) =>
  clamp01((elapsed - delay) / duration);

const mix = (from: number, to: number, amount: number) =>
  from + (to - from) * amount;

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

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

const SMOOTH_PASSES = 40;

const SMOOTH_LAMBDA = 0.5;

const SMOOTH_MU = -0.53;

function smoothGeometry(source: THREE.BufferGeometry) {
  const stripped = source.clone();

  for (const name of Object.keys(stripped.attributes)) {
    if (name !== "position") stripped.deleteAttribute(name);
  }

  stripped.computeBoundingBox();
  const span = stripped.boundingBox?.getSize(new THREE.Vector3()).length() ?? 1;
  const geometry = mergeVertices(stripped, span * 1e-5);

  stripped.dispose();
  const index = geometry.index;

  if (!index) return geometry;
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const count = position.count;

  const neighbours: Set<number>[] = Array.from(
    { length: count },
    () => new Set(),
  );

  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    neighbours[a]?.add(b).add(c);
    neighbours[b]?.add(a).add(c);
    neighbours[c]?.add(a).add(b);
  }

  const offsets = new Uint32Array(count + 1);

  for (let i = 0; i < count; i++) {
    offsets[i + 1] = (offsets[i] ?? 0) + (neighbours[i]?.size ?? 0);
  }

  const links = new Uint32Array(offsets[count] ?? 0);

  for (let i = 0; i < count; i++) {
    let cursor = offsets[i] ?? 0;

    for (const n of neighbours[i] ?? []) links[cursor++] = n;
  }

  const current = position.array as Float32Array;
  const next = new Float32Array(current.length);

  const pass = (factor: number) => {
    for (let i = 0; i < count; i++) {
      const start = offsets[i] ?? 0;
      const end = offsets[i + 1] ?? 0;
      const degree = end - start;
      const base = i * 3;

      if (degree === 0) {
        next[base] = current[base] ?? 0;
        next[base + 1] = current[base + 1] ?? 0;
        next[base + 2] = current[base + 2] ?? 0;
        continue;
      }

      let sx = 0;
      let sy = 0;
      let sz = 0;

      for (let k = start; k < end; k++) {
        const n = (links[k] ?? 0) * 3;
        sx += current[n] ?? 0;
        sy += current[n + 1] ?? 0;
        sz += current[n + 2] ?? 0;
      }

      const px = current[base] ?? 0;
      const py = current[base + 1] ?? 0;
      const pz = current[base + 2] ?? 0;
      next[base] = px + factor * (sx / degree - px);
      next[base + 1] = py + factor * (sy / degree - py);
      next[base + 2] = pz + factor * (sz / degree - pz);
    }

    current.set(next);
  };

  for (let i = 0; i < SMOOTH_PASSES; i++) {
    pass(SMOOTH_LAMBDA);
    pass(SMOOTH_MU);
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();

  return geometry;
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
    const original = child.geometry as THREE.BufferGeometry;
    const geometry = smoothGeometry(original);
    original.dispose();
    child.geometry = geometry;
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
    camera.position.set(0, 0, CAMERA_START_Z);

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
      uHole: { value: (HOLE_RADIUS * 1.01) / MOON_SCALE },
      uSunEdge: { value: (SUN_EDGE * 1.01) / MOON_SCALE },
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

      const elapsed = reducedMotion ? Infinity : now - startedAt;

      const calm =
        elapsed > SETTLE_MS + 800 && now - lastPointerAt > POINTER_CALM_MS;

      const frameMs = calm ? CALM_FRAME_MS : ACTIVE_FRAME_MS;

      if (!dirty && now - lastFrameAt < frameMs - 2) return;

      const step = Math.min(now - lastFrameAt, 100);
      lastFrameAt = now;
      dirty = false;

      const seconds = reducedMotion ? 12 : (now - startedAt) / 1000;
      const turn = easeInOutCubic(progress(elapsed, 0, TURN_MS));
      const corona = mix(0.55, 1, easeOutCubic(progress(elapsed, 0, 2600)));
      const ignite = progress(elapsed, TURN_MS - 650, 520);
      const fade = easeOutCubic(progress(elapsed, TURN_MS - 130, 1700));
      const flare = ignite * mix(1.7, 1, fade);
      const idle = easeInOutCubic(progress(elapsed, TURN_MS - 400, 2000));

      const follow = 1 - 0.94 ** (step / ACTIVE_FRAME_MS);
      pointer.x += (pointerTarget.x - pointer.x) * follow;
      pointer.y += (pointerTarget.y - pointer.y) * follow;

      camera.position.set(
        pointer.x * 0.14 * idle,
        -pointer.y * 0.1 * idle,
        mix(
          CAMERA_START_Z,
          CAMERA_REST_Z,
          easeOutCubic(progress(elapsed, 0, TURN_MS + 600)),
        ),
      );
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();

      pivot.rotation.set(
        mix(START_ROTATION.x, 0, turn) +
          (pointer.y * POINTER_TILT + Math.sin(seconds * 0.27) * 0.035) * idle,
        mix(START_ROTATION.y, 0, turn) +
          (pointer.x * POINTER_TILT + Math.sin(seconds * 0.19) * 0.045) * idle,
        mix(START_ROTATION.z, 0, turn) + Math.sin(seconds * 0.11) * 0.06 * idle,
      );

      rimUniforms.uRimStrength.value = mix(1.2, 2.2, corona);
      scene.environmentIntensity = mix(0.22, 0.3, corona);

      pivot.updateMatrixWorld();
      const center = toPixels(edgePoint.set(0, 0, 0));
      const right = toPixels(edgePoint.set(1, 0, 0));
      const radius = Math.hypot(right.x - center.x, right.y - center.y);
      const moon = radius * MOON_SCALE;

      skyUniforms.uCenter.value.set(center.x, center.y);
      skyUniforms.uRadius.value = moon;
      skyUniforms.uTime.value = seconds;
      skyUniforms.uCorona.value = corona;
      lens.uniforms.uBead.value.set(
        center.x + Math.cos(BEAD_ANGLE) * moon * 0.995,
        center.y + Math.sin(BEAD_ANGLE) * moon * 0.995,
      );
      lens.uniforms.uDisc.value.set(center.x, center.y);
      lens.uniforms.uDiscRadius.value = moon;
      lens.uniforms.uCrush.value = mix(0.55, 1, turn);
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
          roughness: 0.3,
          clearcoat: 1,
          clearcoatRoughness: 0.2,
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
        pivot.rotation.set(
          START_ROTATION.x,
          START_ROTATION.y,
          START_ROTATION.z,
        );
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
  }, [slotRef, startedAt]);

  return <div ref={containerRef} className="e4-stage" aria-hidden="true" />;
}
