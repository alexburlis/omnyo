import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

import {
  FLARE_FRAGMENT,
  PARTICLE_FRAGMENT,
  PARTICLE_VERTEX,
  QUAD_VERTEX,
  RIM_CHUNK,
  RIM_HEADER,
  SKY_FRAGMENT,
  WINDOW_COUNT,
} from "./shaders";

export type Vec3 = [number, number, number];

export type Vec4 = [number, number, number, number];

export interface EngineFrame {
  width: number;
  height: number;
  time: number;
  sky: { top: Vec3; mid: Vec3; bot: Vec3 };
  sun: { x: number; y: number; r: number };
  moon: { x: number; y: number; r: number; on: number };
  night: number;
  visible: number;
  corona: number;
  stars: number;
  grain: number;
  bead: { x: number; y: number; intensity: number; streak: number };
  o: {
    opacity: number;
    rx: number;
    ry: number;
    rz: number;
    env: number;
    rim: number;
    key: number;
    back: number;
    rimDir: [number, number];
  };
  particles: {
    stage: number;
    alpha: number;
    intro: number;
    color: Vec3;
    ringTurn: number;
    orbitScale: number;
    windows: Vec4[];
  };
}

export interface EngineEvents {
  onProgress: (fraction: number) => void;
  onModelReady: () => void;
  onFailure: (reason: unknown) => void;
}

const MAX_PIXEL_RATIO = 2;

const MAX_RENDER_PIXELS = 3_400_000;

const MODEL_DIAMETER = 2;

const O_TO_MOON = 1 / 1.06;

const CAMERA_Z = 12;

const CAMERA_FOV = 22;

const SMOOTH_PASSES = 40;

const STUDIO_PANELS = [
  { w: 16, h: 16, color: [5.2, 3.4, 1.9], at: [0, 0, -9] },
  { w: 10, h: 2.4, color: [1.6, 1.62, 1.7], at: [0, 7, 5] },
  { w: 2, h: 9, color: [2.4, 1.4, 0.7], at: [8, 1, 1] },
  { w: 1.6, h: 7, color: [0.6, 0.75, 1.1], at: [-8, -1, 3] },
  { w: 12, h: 1.4, color: [0.9, 0.5, 0.25], at: [0, -6, 4] },
] as const;

function disposeMaterial(material: THREE.Material) {
  const standard = material as THREE.MeshPhysicalMaterial;
  standard.map?.dispose();
  standard.normalMap?.dispose();
  standard.roughnessMap?.dispose();
  standard.metalnessMap?.dispose();
  standard.emissiveMap?.dispose();
  material.dispose();
}

function disposeObject(object: THREE.Object3D) {
  const seen = new Set<THREE.Material>();
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Points)) return;
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
  studio.background = new THREE.Color(0x030304);

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
    pass(0.5);
    pass(-0.53);
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

    for (let i = 0; i < position.count; i++) {
      uvs[i * 2] = ((position.getX(i) - bounds.min.x) / extent.x) * 0.8 + 0.1;
      uvs[i * 2 + 1] =
        ((position.getY(i) - bounds.min.y) / extent.y) * 0.8 + 0.1;
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

function sampleRing(count: number) {
  const ring = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const roll = Math.random();

    const radius =
      roll < 0.22
        ? 0.985 - Math.random() * 0.03
        : roll < 0.36
          ? 0.42 + Math.random() * 0.03
          : Math.sqrt(0.18 + Math.random() * 0.8);

    ring[i * 3] = Math.cos(angle) * radius;
    ring[i * 3 + 1] = Math.sin(angle) * radius;
    ring[i * 3 + 2] = (Math.random() - 0.5) * 0.12;
  }

  return ring;
}

const ORBITS = [
  { radius: 1.22, speed: 0.05, clusters: 4, share: 0.26 },
  { radius: 1.45, speed: -0.034, clusters: 5, share: 0.34 },
  { radius: 1.74, speed: 0.024, clusters: 6, share: 0.4 },
] as const;

function createParticles(count: number) {
  const ring = sampleRing(count);
  const windows = new Float32Array(count * 4);
  const seeds = new Float32Array(count * 4);
  const orbits = new Float32Array(count * 3);
  const accents = new Float32Array(count);

  const centres = ORBITS.map((orbit) =>
    Array.from(
      { length: orbit.clusters },
      (_, index) =>
        (index / orbit.clusters) * Math.PI * 2 + Math.random() * 0.8,
    ),
  );

  for (let i = 0; i < count; i++) {
    const roll = Math.random();
    const accent = Math.random() < 0.05;
    accents[i] = accent ? 1 : 0;
    windows[i * 4] = Math.floor(Math.random() * WINDOW_COUNT);
    windows[i * 4 + 1] = Math.random();
    windows[i * 4 + 2] = Math.random();
    windows[i * 4 + 3] = roll < 0.64 ? 0 : roll < 0.74 ? 1 : 2;

    for (let k = 0; k < 4; k++) seeds[i * 4 + k] = Math.random();

    let pick = Math.random();
    let orbitIndex = 0;

    for (; orbitIndex < ORBITS.length - 1; orbitIndex++) {
      pick -= ORBITS[orbitIndex]?.share ?? 0;

      if (pick < 0) break;
    }

    const orbit = ORBITS[orbitIndex] ?? ORBITS[0];
    const loose = Math.random() < 0.3;
    const clusterList = centres[orbitIndex] ?? [0];

    const centre =
      clusterList[Math.floor(Math.random() * clusterList.length)] ?? 0;

    const spread = (Math.random() + Math.random() + Math.random() - 1.5) * 0.34;

    orbits[i * 3] = loose
      ? orbit.radius + (Math.random() - 0.5) * 0.32
      : orbit.radius + (Math.random() - 0.5) * 0.045;
    orbits[i * 3 + 1] = loose ? Math.random() * Math.PI * 2 : centre + spread;
    orbits[i * 3 + 2] = orbit.speed * (loose ? 0.7 : 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(count * 3), 3),
  );
  geometry.setAttribute("aRing", new THREE.BufferAttribute(ring, 3));
  geometry.setAttribute("aWin", new THREE.BufferAttribute(windows, 4));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
  geometry.setAttribute("aOrbit", new THREE.BufferAttribute(orbits, 3));
  geometry.setAttribute("aAccent", new THREE.BufferAttribute(accents, 1));

  const uniforms = {
    uStage: { value: 0 },
    uTime: { value: 0 },
    uIntro: { value: 0 },
    uSize: { value: 2.1 },
    uDpr: { value: 1 },
    uAlpha: { value: 1 },
    uView: { value: new THREE.Vector2(1, 1) },
    uSun: { value: new THREE.Vector3() },
    uOrbit: { value: 1 },
    uMoon: { value: new THREE.Vector4() },
    uWin: {
      value: Array.from({ length: WINDOW_COUNT }, () => new THREE.Vector4()),
    },
    uColor: { value: new THREE.Vector3(0.05, 0.05, 0.055) },
    uAccent: { value: new THREE.Vector3(1, 0.31, 0.09) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: PARTICLE_VERTEX,
    fragmentShader: PARTICLE_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return { points, uniforms };
}

export function canUseWebGL() {
  try {
    const probe = document.createElement("canvas");

    return Boolean(probe.getContext("webgl2") ?? probe.getContext("webgl"));
  } catch {
    return false;
  }
}

export function createEngine(canvas: HTMLCanvasElement, events: EngineEvents) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    stencil: false,
    powerPreference: "high-performance",
  });

  renderer.setClearColor(0xf3efe6, 1);
  renderer.autoClear = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  let disposed = false;
  let failed = false;
  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let pivot: THREE.Group | null = null;
  let oTransparent = false;

  const fail = (reason: unknown) => {
    if (disposed || failed) return;
    failed = true;
    events.onFailure(reason);
  };

  const handleLost = (event: Event) => {
    event.preventDefault();
    fail("WebGL context lost");
  };

  canvas.addEventListener("webglcontextlost", handleLost);

  const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
  const quad = new THREE.PlaneGeometry(2, 2);

  const skyUniforms = {
    uRes: { value: new THREE.Vector2(1, 1) },
    uTop: { value: new THREE.Vector3(0.95, 0.94, 0.9) },
    uMid: { value: new THREE.Vector3(0.95, 0.94, 0.9) },
    uBot: { value: new THREE.Vector3(0.95, 0.94, 0.9) },
    uSun: { value: new THREE.Vector2() },
    uSunR: { value: 100 },
    uMoon: { value: new THREE.Vector2(-9999, -9999) },
    uMoonR: { value: 100 },
    uMoonOn: { value: 0 },
    uNight: { value: 0 },
    uVisible: { value: 1 },
    uCorona: { value: 0 },
    uStars: { value: 0 },
    uTime: { value: 0 },
    uGrain: { value: 0 },
  };

  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: QUAD_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });

  const sky = new THREE.Mesh(quad, skyMaterial);
  sky.frustumCulled = false;
  const skyScene = new THREE.Scene();
  skyScene.add(sky);

  const particleCount = window.innerWidth < 720 ? 5200 : 9000;
  const particles = createParticles(particleCount);
  skyScene.add(particles.points);

  const flareUniforms = {
    uRes: { value: new THREE.Vector2(1, 1) },
    uBead: { value: new THREE.Vector2(-9999, -9999) },
    uDisc: { value: new THREE.Vector2(0, 0) },
    uBeadI: { value: 0 },
    uStreak: { value: 0 },
  };

  const flareMaterial = new THREE.ShaderMaterial({
    uniforms: flareUniforms,
    vertexShader: QUAD_VERTEX,
    fragmentShader: FLARE_FRAGMENT,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE.AdditiveBlending,
  });

  const flare = new THREE.Mesh(quad, flareMaterial);
  flare.frustumCulled = false;
  const flareScene = new THREE.Scene();
  flareScene.add(flare);

  const oScene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);
  camera.position.set(0, 0, CAMERA_Z);
  camera.lookAt(0, 0, 0);
  const envTexture = createEnvironment(renderer);
  oScene.environment = envTexture;
  const key = new THREE.DirectionalLight(0xfff1e2, 2);
  key.position.set(-3, 4, 6);
  oScene.add(key);
  const backA = new THREE.DirectionalLight(0xffc68a, 6);
  backA.position.set(4, 4, -5);
  oScene.add(backA);
  const backB = new THREE.DirectionalLight(0xff8a4a, 3);
  backB.position.set(-5, -3, -4);
  oScene.add(backB);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.5);
  fill.position.set(-2, 3, 6);
  oScene.add(fill);

  const rimUniforms = {
    uRimColor: { value: new THREE.Color(1.0, 0.64, 0.32) },
    uRimStrength: { value: 0 },
    uBeadDir: { value: new THREE.Vector2(1, 0) },
  };

  let oMaterial: THREE.MeshPhysicalMaterial | null = null;
  const loader = new GLTFLoader();
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

  Promise.all([
    new THREE.TextureLoader().loadAsync("/logo.png"),
    loader.loadAsync("/model.glb", (event) => {
      if (event.total > 0) events.onProgress(event.loaded / event.total);
    }),
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
        roughness: 0.28,
        clearcoat: 1,
        clearcoatRoughness: 0.18,
      });

      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, rimUniforms);
        shader.fragmentShader = `${RIM_HEADER}\n${shader.fragmentShader.replace(
          "#include <emissivemap_fragment>",
          RIM_CHUNK,
        )}`;
      };

      oMaterial = material;
      pivot = prepareModel(gltf.scene, material);
      oScene.add(pivot);
      renderer.compile(oScene, camera);
      events.onModelReady();
    })
    .catch((error: unknown) => {
      if (disposed) return;
      console.warn("The 3D O could not load; the particle O stays.", error);
    });

  const resize = (cssWidth: number, cssHeight: number) => {
    width = cssWidth;
    height = cssHeight;
    pixelRatio = Math.max(
      1,
      Math.min(
        window.devicePixelRatio || 1,
        MAX_PIXEL_RATIO,
        Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, width * height)),
      ),
    );
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height);
    screenCamera.left = -width / 2;
    screenCamera.right = width / 2;
    screenCamera.top = height / 2;
    screenCamera.bottom = -height / 2;
    screenCamera.updateProjectionMatrix();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const device = new THREE.Vector2(width * pixelRatio, height * pixelRatio);
    skyUniforms.uRes.value.copy(device);
    flareUniforms.uRes.value.copy(device);
    particles.uniforms.uView.value.set(width, height);
    particles.uniforms.uDpr.value = pixelRatio;
    particles.uniforms.uSize.value = width < 720 ? 1.8 : 2.1;
  };

  const toDevice = (x: number, y: number) =>
    [x * pixelRatio, (height - y) * pixelRatio] as const;

  const toScene = (x: number, y: number) =>
    [x - width / 2, height / 2 - y] as const;

  const render = (frame: EngineFrame) => {
    if (disposed || failed) return;

    if (frame.width !== width || frame.height !== height) {
      resize(frame.width, frame.height);
    }

    const [sx, sy] = toDevice(frame.sun.x, frame.sun.y);
    const [mx, my] = toDevice(frame.moon.x, frame.moon.y);
    skyUniforms.uTop.value.set(...frame.sky.top);
    skyUniforms.uMid.value.set(...frame.sky.mid);
    skyUniforms.uBot.value.set(...frame.sky.bot);
    skyUniforms.uSun.value.set(sx, sy);
    skyUniforms.uSunR.value = Math.max(1, frame.sun.r * pixelRatio);
    skyUniforms.uMoon.value.set(mx, my);
    skyUniforms.uMoonR.value = Math.max(1, frame.moon.r * pixelRatio);
    skyUniforms.uMoonOn.value = frame.moon.on;
    skyUniforms.uNight.value = frame.night;
    skyUniforms.uVisible.value = frame.visible;
    skyUniforms.uCorona.value = frame.corona;
    skyUniforms.uStars.value = frame.stars;
    skyUniforms.uTime.value = frame.time;
    skyUniforms.uGrain.value = frame.grain;

    const p = particles.uniforms;
    const [psx, psy] = toScene(frame.sun.x, frame.sun.y);
    const [pmx, pmy] = toScene(frame.moon.x, frame.moon.y);
    p.uStage.value = frame.particles.stage;
    p.uTime.value = frame.time;
    p.uIntro.value = frame.particles.intro;
    p.uAlpha.value = frame.particles.alpha;
    p.uColor.value.set(...frame.particles.color);
    p.uSun.value.set(psx, psy, frame.sun.r);
    p.uOrbit.value = frame.particles.orbitScale;
    p.uMoon.value.set(
      pmx,
      pmy,
      frame.moon.r * O_TO_MOON,
      frame.particles.ringTurn,
    );
    frame.particles.windows.forEach((rect, index) => {
      p.uWin.value[index]?.set(...rect);
    });
    particles.points.visible = frame.particles.alpha > 0.002;

    renderer.setRenderTarget(null);
    renderer.clear(true, true, true);
    renderer.render(skyScene, screenCamera);

    if (pivot && oMaterial && frame.o.opacity > 0.002) {
      const unitsPerPixel =
        (2 * CAMERA_Z * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2))) /
        height;

      pivot.position.set(pmx * unitsPerPixel, pmy * unitsPerPixel, 0);
      pivot.scale.setScalar(
        (frame.moon.r * O_TO_MOON * unitsPerPixel * 2) / MODEL_DIAMETER,
      );
      pivot.rotation.set(frame.o.rx, frame.o.ry, frame.o.rz);
      const wantTransparent = frame.o.opacity < 0.999;

      if (wantTransparent !== oTransparent) {
        oTransparent = wantTransparent;
        oMaterial.transparent = wantTransparent;
        oMaterial.needsUpdate = true;
      }

      oMaterial.opacity = frame.o.opacity;
      oScene.environmentIntensity = frame.o.env;
      key.intensity = frame.o.key;
      backA.intensity = 6 * frame.o.back;
      backB.intensity = 3 * frame.o.back;
      rimUniforms.uRimStrength.value = frame.o.rim;
      rimUniforms.uBeadDir.value.set(...frame.o.rimDir);
      renderer.clearDepth();
      renderer.render(oScene, camera);
    }

    if (frame.bead.intensity > 0.002 || frame.bead.streak > 0.002) {
      const [bx, by] = toDevice(frame.bead.x, frame.bead.y);
      flareUniforms.uBead.value.set(bx, by);
      flareUniforms.uDisc.value.set(sx, sy);
      flareUniforms.uBeadI.value = frame.bead.intensity;
      flareUniforms.uStreak.value = frame.bead.streak;
      renderer.render(flareScene, screenCamera);
    }
  };

  const dispose = () => {
    disposed = true;
    canvas.removeEventListener("webglcontextlost", handleLost);

    if (pivot) disposeObject(pivot);
    quad.dispose();
    skyMaterial.dispose();
    flareMaterial.dispose();
    particles.points.geometry.dispose();
    (particles.points.material as THREE.Material).dispose();
    envTexture.dispose();
    renderer.dispose();
  };

  return { render, dispose };
}

export type Engine = ReturnType<typeof createEngine>;
