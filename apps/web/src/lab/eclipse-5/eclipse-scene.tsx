import { useEffect, useRef } from "react";
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
import { APPROACH, type PathDriver, mix, smoothstep } from "./path";

export type EclipseStatus = "live" | "failed";

const MODEL_DIAMETER = 2;

const CAMERA_DISTANCE = 18;

const CAMERA_FOV = 14;

const MAX_PIXEL_RATIO = 2;

const MAX_RENDER_PIXELS = 3_200_000;

const ACTIVE_FRAME_MS = 1000 / 60;

const CALM_FRAME_MS = 1000 / 30;

const POINTER_CALM_MS = 2200;

const SMOOTH_ITERATIONS = 24;

const OBJECT_LAYER = 1;

const MESH_FIT = 0.952;

const DISC_FIT = 0.9962;

const STUDIO_PANELS = [
  { w: 16, h: 16, color: [5, 3.2, 1.7], at: [0, 0, -9] },
  { w: 12, h: 3, color: [0.9, 1.1, 1.6], at: [0, 7, 5] },
  { w: 2, h: 9, color: [2.4, 1.3, 0.6], at: [8, 1, 1] },
  { w: 1.6, h: 7, color: [0.45, 0.65, 1.15], at: [-8, -1, 3] },
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
  studio.background = new THREE.Color(0x020306);

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
    new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 5.6, 3.4) }),
  );

  ring.position.set(0, 0, -6);
  studio.add(ring);

  const texture = pmrem.fromScene(studio, 0.035).texture;
  disposeObject(studio);
  pmrem.dispose();

  return texture;
}

function smoothGeometry(geometry: THREE.BufferGeometry) {
  const index = geometry.index;
  const position = geometry.attributes.position;

  if (!index || !position) return;
  const count = position.count;
  const neighbors: number[][] = Array.from({ length: count }, () => []);
  const indices = index.array;

  const link = (a: number, b: number) => {
    const list = neighbors[a];

    if (list && !list.includes(b)) list.push(b);
  };

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] ?? 0;
    const b = indices[i + 1] ?? 0;
    const c = indices[i + 2] ?? 0;
    link(a, b);
    link(a, c);
    link(b, a);
    link(b, c);
    link(c, a);
    link(c, b);
  }

  let points = Float32Array.from(position.array as ArrayLike<number>);
  let next = new Float32Array(points.length);

  for (let iteration = 0; iteration < SMOOTH_ITERATIONS; iteration++) {
    for (const factor of [0.5, -0.53]) {
      for (let vertex = 0; vertex < count; vertex++) {
        const list = neighbors[vertex] ?? [];
        const base = vertex * 3;

        if (list.length === 0) {
          next[base] = points[base] ?? 0;
          next[base + 1] = points[base + 1] ?? 0;
          next[base + 2] = points[base + 2] ?? 0;
          continue;
        }

        let sx = 0;
        let sy = 0;
        let sz = 0;

        for (const other of list) {
          sx += points[other * 3] ?? 0;
          sy += points[other * 3 + 1] ?? 0;
          sz += points[other * 3 + 2] ?? 0;
        }

        const inverse = 1 / list.length;
        const x = points[base] ?? 0;
        const y = points[base + 1] ?? 0;
        const z = points[base + 2] ?? 0;
        next[base] = x + factor * (sx * inverse - x);
        next[base + 1] = y + factor * (sy * inverse - y);
        next[base + 2] = z + factor * (sz * inverse - z);
      }

      const swap = points;
      points = next;
      next = swap;
    }
  }

  (position.array as Float32Array).set(points);
  position.needsUpdate = true;
}

function prepareModel(model: THREE.Object3D, material: THREE.Material) {
  model.traverse((child) => {
    if (child instanceof THREE.Mesh) smoothGeometry(child.geometry);
  });

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
    child.layers.set(OBJECT_LAYER);
    const geometry = child.geometry;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;

    if (!bounds) return;
    const extent = bounds.getSize(new THREE.Vector3());
    const position = geometry.attributes.position;

    if (!position) return;
    const uvs = new Float32Array(position.count * 2);
    const uvScale = 0.6;
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
  driver,
  onStatus,
}: {
  driver: PathDriver;
  onStatus: (status: EclipseStatus) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  useEffect(() => {
    const container = containerRef.current;

    if (!container) return;

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
    let layoutDirty = true;
    let layoutPixelRatio = 0;
    let lastFrameAt = 0;
    let lastVersion = -1;
    let lastPointerAt = Number.NEGATIVE_INFINITY;
    let pivot: THREE.Group | null = null;
    let announced = false;
    let width = 1;
    let height = 1;
    let pixelRatio = 1;
    const startedAt = performance.now();

    renderer.setClearColor(0x000000, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.domElement.setAttribute("aria-hidden", "true");
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 1, 60);
    camera.position.set(0, 0, CAMERA_DISTANCE);
    camera.layers.enable(OBJECT_LAYER);
    const objectCamera = new THREE.PerspectiveCamera();

    const envTexture = createEnvironment(renderer);
    scene.environment = envTexture;
    scene.environmentIntensity = 0.4;

    const sunLight = new THREE.DirectionalLight(0xffc68a, 6);
    sunLight.position.set(4, 4, -5);
    const underLight = new THREE.DirectionalLight(0xff8a4a, 2.5);
    underLight.position.set(-5, -3, -4);
    const skyLight = new THREE.DirectionalLight(0xa9c4ff, 0.7);
    skyLight.position.set(-2, 3, 6);
    const ambient = new THREE.AmbientLight(0xffffff, 0.05);

    for (const light of [sunLight, underLight, skyLight, ambient]) {
      light.layers.enableAll();
      scene.add(light);
    }

    const skyUniforms = {
      uRes: { value: new THREE.Vector2(1, 1) },
      uSun: { value: new THREE.Vector2(0, 0) },
      uSunR: { value: 100 },
      uMoon: { value: new THREE.Vector2(-1000, -1000) },
      uMoonR: { value: 100 },
      uTime: { value: 0 },
      uDark: { value: 0 },
      uFilter: { value: 1 },
      uCorona: { value: 0 },
      uStars: { value: 0 },
      uHorizon: { value: 0 },
      uExposure: { value: 1 },
      uRidge: { value: 0.06 },
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

    const moonDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 160),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.004, 0.0045, 0.008),
        depthTest: false,
        depthWrite: false,
      }),
    );

    moonDisc.layers.set(OBJECT_LAYER);
    moonDisc.renderOrder = -1;
    moonDisc.frustumCulled = false;
    scene.add(moonDisc);

    const rimUniforms = {
      uRimColor: { value: new THREE.Color(1.0, 0.62, 0.3) },
      uRimStrength: { value: 1 },
      uSunDir: { value: new THREE.Vector2(-APPROACH.x, APPROACH.y) },
      uRimSpread: { value: 0 },
      uCenter: { value: new THREE.Vector2(0, 0) },
      uRadius: { value: 1 },
    };

    const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 4,
    });

    const composer = new EffectComposer(renderer, renderTarget);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.4, 1.05);
    composer.addPass(bloom);
    const objectPass = new RenderPass(scene, objectCamera);
    objectPass.clear = false;
    objectPass.clearDepth = true;
    composer.addPass(objectPass);
    composer.addPass(new OutputPass());

    const lens = new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          uRes: { value: new THREE.Vector2(1, 1) },
          uBead: { value: new THREE.Vector2(-1000, -1000) },
          uStreak: { value: 0 },
          uGlow: { value: 0 },
          uWarm: { value: 1 },
          uTime: { value: 0 },
          uGrain: { value: 0.03 },
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

    const markLayoutDirty = () => {
      layoutDirty = true;
    };

    const resizes = new ResizeObserver(markLayoutDirty);
    resizes.observe(container);
    window.addEventListener("resize", markLayoutDirty);

    const syncLayout = () => {
      const bounds = container.getBoundingClientRect();
      width = Math.round(bounds.width);
      height = Math.round(bounds.height);

      if (width === 0 || height === 0) return false;

      pixelRatio = Math.max(
        1,
        Math.min(
          window.devicePixelRatio,
          MAX_PIXEL_RATIO,
          Math.sqrt(MAX_RENDER_PIXELS / (width * height)),
        ),
      );

      camera.aspect = width / height;
      camera.updateProjectionMatrix();

      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height);
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      bloom.resolution.set(width * pixelRatio, height * pixelRatio);
      skyUniforms.uRes.value.set(width * pixelRatio, height * pixelRatio);
      skyUniforms.uRidge.value = width >= 900 ? 0.058 : 0.045;
      lens.uniforms.uRes.value.set(width * pixelRatio, height * pixelRatio);
      layoutPixelRatio = window.devicePixelRatio;
      lastVersion = -1;

      return true;
    };

    const worldPerPixel = () =>
      (2 *
        CAMERA_DISTANCE *
        Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2))) /
      height;

    const frame = (now: number) => {
      animationId = requestAnimationFrame(frame);

      if (!pivot) return;

      if (layoutDirty || window.devicePixelRatio !== layoutPixelRatio) {
        if (!syncLayout()) return;
        layoutDirty = false;
      }

      const state = driver.state;
      const changed = state.version !== lastVersion;

      if (reducedMotion && !changed) return;

      const calm =
        !state.moving &&
        now - lastPointerAt > POINTER_CALM_MS &&
        now - startedAt > 3200;

      const frameMs = calm ? CALM_FRAME_MS : ACTIVE_FRAME_MS;

      if (!changed && now - lastFrameAt < frameMs - 2) return;

      const step = Math.min(now - lastFrameAt, 100);
      lastFrameAt = now;
      lastVersion = state.version;

      const seconds = reducedMotion ? 12 : (now - startedAt) / 1000;
      const follow = 1 - 0.93 ** (step / ACTIVE_FRAME_MS);
      pointer.x += (pointerTarget.x - pointer.x) * follow;
      pointer.y += (pointerTarget.y - pointer.y) * follow;

      const scaleX = width / state.w;
      const scaleY = height / state.h;
      const k = worldPerPixel();
      const ox = state.ox * scaleX;
      const oy = state.oy * scaleY;
      const radius = state.or * scaleY;

      pivot.position.set((ox - width / 2) * k, -(oy - height / 2) * k, 0);
      pivot.scale.setScalar(radius * k * MESH_FIT);
      moonDisc.position.copy(pivot.position);
      rimUniforms.uCenter.value.set(pivot.position.x, pivot.position.y);
      rimUniforms.uRadius.value = pivot.scale.x;
      moonDisc.scale.setScalar(radius * k * DISC_FIT);

      const c = state.c;
      const settle = 1 - smoothstep(0.9, 1, c);
      pivot.rotation.set(
        -0.07 * settle +
          (pointer.y * 0.05 + Math.sin(seconds * 0.27) * 0.012) * settle,
        0.1 * settle +
          (pointer.x * 0.06 + Math.sin(seconds * 0.19) * 0.015) * settle,
        -0.9 + c * 1.25 + Math.sin(seconds * 0.11) * 0.02,
      );

      const sunX = state.cx * scaleX;
      const sunY = state.cy * scaleY;
      const dirX = sunX - ox;
      const dirY = -(sunY - oy);
      const dirLength = Math.hypot(dirX, dirY);

      if (dirLength > 1) {
        rimUniforms.uSunDir.value.set(dirX / dirLength, dirY / dirLength);
      }

      rimUniforms.uRimSpread.value = state.totality;
      rimUniforms.uRimStrength.value = mix(1.25, 2.4, state.corona);
      rimUniforms.uRimColor.value.setRGB(
        1,
        mix(0.55, 0.78, 1 - state.filter),
        mix(0.24, 0.5, 1 - state.filter),
      );
      scene.environmentIntensity = mix(0.42, 0.24, state.dark);
      sunLight.position.set(
        dirX / Math.max(dirLength, 1),
        dirY / Math.max(dirLength, 1),
        -1.2,
      );
      sunLight.intensity = mix(5, 7, state.corona);
      skyLight.intensity = mix(0.8, 0.25, state.dark);

      const dpr = pixelRatio;
      skyUniforms.uSun.value.set(sunX * dpr, (height - sunY) * dpr);
      skyUniforms.uSunR.value = state.r * scaleY * dpr;
      skyUniforms.uMoon.value.set(ox * dpr, (height - oy) * dpr);
      skyUniforms.uMoonR.value = radius * dpr;
      skyUniforms.uTime.value = seconds;
      skyUniforms.uDark.value = state.dark;
      skyUniforms.uFilter.value = state.filter;
      skyUniforms.uCorona.value = state.corona;
      skyUniforms.uStars.value = state.stars;
      skyUniforms.uHorizon.value = state.horizon;
      skyUniforms.uExposure.value = 1 - state.obscuration;

      lens.uniforms.uBead.value.set(
        state.flareX * scaleX * dpr,
        (height - state.flareY * scaleY) * dpr,
      );
      lens.uniforms.uStreak.value = state.streak;
      lens.uniforms.uGlow.value = state.glow;
      lens.uniforms.uWarm.value = state.filter;
      lens.uniforms.uTime.value = seconds;

      camera.updateMatrixWorld();
      objectCamera.copy(camera);
      objectCamera.layers.set(OBJECT_LAYER);

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
          color: new THREE.Color().setScalar(0.36),
          metalness: 1,
          roughness: 0.55,
          clearcoat: 1,
          clearcoatRoughness: 0.4,
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
        scene.add(pivot);
        lastVersion = -1;
      })
      .catch(fail);

    animationId = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(animationId);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("resize", markLayoutDirty);
      resizes.disconnect();

      if (pivot) disposeObject(pivot);
      disposeObject(sky);
      disposeObject(moonDisc);
      lens.material.dispose();
      bloom.dispose();
      composer.dispose();
      renderTarget.dispose();
      envTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [driver]);

  return <div ref={containerRef} className="e5-stage" aria-hidden="true" />;
}
