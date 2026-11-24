import { type RefObject, useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { type Journey, PORTAL_WORLD, WORLDS, type World } from "./worlds";

const MAX_PIXEL_RATIO = 2;

const MAX_RENDER_PIXELS = 5_000_000;

const MODEL_SIZE = 2.5;

const O_RADIUS = MODEL_SIZE / 2;

const PORTAL_RADIUS = 0.78;

const FRAME_MS = 1000 / 60;

const HOLE_CUT = 0.56;

const HOLE_RADIUS = 0.6;

const RIM_BAND = 0.66;

const SMOOTH_PASSES = 4;

const WORLD_GLSL = `
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uGround;
uniform float uHorizonY;
uniform vec2 uSun;
uniform float uSunPower;
uniform float uStreak;
uniform float uHaze;
uniform float uTime;
uniform float uTravel;
uniform vec2 uResolution;
uniform vec3 uRing;
uniform float uRingGlow;
uniform float uVignette;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.0, 9.0);
    a *= 0.5;
  }
  return v;
}

vec3 skyColor(vec2 uv, float aspect) {
  float up = clamp((uv.y - uHorizonY) / (1.0 - uHorizonY), 0.0, 1.0);
  vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.38, up));
  col = mix(col, uTop, smoothstep(0.3, 1.0, up));
  vec2 d = (uv - uSun) * vec2(max(aspect, 1.0), 1.0);
  float r = length(d);
  col += uGlow * (exp(-r * r * 26.0) * 0.85 + exp(-r * 3.4) * 0.32) * uSunPower;
  vec2 cp = vec2(uv.x * aspect * 0.9 + uTime * 0.006 + uTravel * 0.05, up * 7.0 - uTravel * 0.9);
  float c = fbm(cp * vec2(0.8, 1.0) + vec2(0.0, fbm(cp * 0.7) * 0.8));
  float band = smoothstep(0.02, 0.3, up) * (1.0 - smoothstep(0.55, 1.0, up));
  float cloud = smoothstep(0.48, 0.82, c) * band * uHaze;
  vec3 lit = mix(uMid, uGlow, 0.55 + 0.45 * exp(-r * 2.0));
  col = mix(col, lit, cloud * 0.55);
  return col;
}

vec3 worldColor(vec2 uv) {
  float aspect = uResolution.x / uResolution.y;
  float h = uHorizonY;
  vec3 col;
  if (uv.y >= h) {
    col = skyColor(uv, aspect);
  } else {
    float depth = h - uv.y;
    float persp = 1.0 / max(depth, 0.004);
    float wave = noise(vec2(uv.x * aspect * 6.0 * (0.2 + depth), persp * 0.35 - uTravel * 3.0 + uTime * 0.18));
    float ripple = (wave - 0.5) * 0.035 * (0.25 + depth * 3.0);
    vec2 ruv = vec2(uv.x + ripple, min(h + depth * 1.15, 1.0));
    vec3 refl = skyColor(ruv, aspect);
    float fres = mix(0.92, 0.42, smoothstep(0.0, 0.42, depth));
    col = mix(uGround, refl, fres);
    vec2 sd = (vec2(uv.x + ripple * 2.0, uv.y) - vec2(uSun.x, h)) * vec2(aspect, 1.0);
    float column = exp(-abs(sd.x) * (9.0 + depth * 30.0)) * smoothstep(0.55, 0.0, depth);
    float glint = smoothstep(0.62, 0.9, wave) * column;
    col += uGlow * (column * 0.22 + glint * 0.55) * uSunPower;
  }
  col += uGlow * exp(-abs(uv.y - h) * 70.0) * 0.28 * uHaze;
  vec2 sd = (uv - uSun) * vec2(aspect, 1.0);
  col += uGlow * uStreak * (
    exp(-abs(sd.y) * 160.0) * exp(-abs(sd.x) * 0.7) * 0.45 +
    exp(-abs(sd.y) * 900.0) * exp(-abs(sd.x) * 1.6) * 0.6
  );
  vec2 rd = (uv - uRing.xy) * vec2(aspect, 1.0);
  float rr = length(rd);
  float outside = max(rr - uRing.z, 0.0);
  col += uGlow * uRingGlow * (exp(-outside * 22.0) * 0.6 + exp(-outside * 5.0) * 0.28)
    * smoothstep(uRing.z * 0.7, uRing.z, rr);
  vec2 v = (uv - 0.5) * vec2(aspect, 1.0);
  col *= mix(1.0, 0.72, smoothstep(0.4, 1.15, length(v)) * uVignette);
  return col;
}
`;

const SCREEN_VERTEX = `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const PORTAL_VERTEX = `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const WORLD_FRAGMENT = `
${WORLD_GLSL}
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  gl_FragColor = vec4(worldColor(uv), 1.0);
  #include <colorspace_fragment>
}
`;

const ENV_VERTEX = `
varying vec3 vDirection;
void main() {
  vDirection = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ENV_FRAGMENT = `
varying vec3 vDirection;
void main() {
  float y = vDirection.y;
  vec3 top = vec3(0.05, 0.08, 0.22);
  vec3 band = vec3(2.6, 1.15, 0.45);
  vec3 low = vec3(0.05, 0.025, 0.04);
  vec3 col = y > 0.0
    ? mix(band, top, smoothstep(0.0, 0.45, y))
    : mix(band * 0.6, low, smoothstep(0.0, 0.25, -y));
  gl_FragColor = vec4(col, 1.0);
}
`;

const ENV_PANELS = [
  { w: 12, h: 2.4, color: [5.5, 5.2, 4.8], pos: [0, 9, 2] },
  { w: 3.2, h: 9, color: [1.4, 1.6, 2.4], pos: [-8, 1, 5] },
  { w: 3.2, h: 9, color: [2.6, 1.6, 1.0], pos: [8, 1, 5] },
  { w: 2.4, h: 10, color: [3.4, 2.0, 1.1], pos: [6, 0, -6] },
  { w: 2.4, h: 10, color: [1.4, 1.8, 3.2], pos: [-6, 0, -6] },
  { w: 10, h: 3, color: [0.6, 0.55, 0.6], pos: [0, -1, 9] },
] as const;

interface WorldUniforms {
  [name: string]: THREE.IUniform;
  uTop: { value: THREE.Color };
  uMid: { value: THREE.Color };
  uHorizon: { value: THREE.Color };
  uGlow: { value: THREE.Color };
  uGround: { value: THREE.Color };
  uHorizonY: { value: number };
  uSun: { value: THREE.Vector2 };
  uSunPower: { value: number };
  uStreak: { value: number };
  uHaze: { value: number };
  uTime: { value: number };
  uTravel: { value: number };
  uResolution: { value: THREE.Vector2 };
  uRing: { value: THREE.Vector3 };
  uRingGlow: { value: number };
  uVignette: { value: number };
}

function createWorldUniforms(): WorldUniforms {
  return {
    uTop: { value: new THREE.Color() },
    uMid: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uGlow: { value: new THREE.Color() },
    uGround: { value: new THREE.Color() },
    uHorizonY: { value: 0.5 },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uSunPower: { value: 1 },
    uStreak: { value: 1 },
    uHaze: { value: 0.6 },
    uTime: { value: 0 },
    uTravel: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uRing: { value: new THREE.Vector3(0.5, 0.5, 0) },
    uRingGlow: { value: 0 },
    uVignette: { value: 1 },
  };
}

const scratchA = new THREE.Color();

const scratchB = new THREE.Color();

function applyWorld(
  uniforms: WorldUniforms,
  from: World,
  to: World,
  amount: number,
) {
  const lerpColor = (target: THREE.Color, a: string, b: string) => {
    scratchA.set(a);
    scratchB.set(b);
    target.copy(scratchA).lerp(scratchB, amount);
  };

  const lerp = (a: number, b: number) => a + (b - a) * amount;
  lerpColor(uniforms.uTop.value, from.top, to.top);
  lerpColor(uniforms.uMid.value, from.mid, to.mid);
  lerpColor(uniforms.uHorizon.value, from.horizon, to.horizon);
  lerpColor(uniforms.uGlow.value, from.glow, to.glow);
  lerpColor(uniforms.uGround.value, from.ground, to.ground);
  uniforms.uHorizonY.value = lerp(from.horizonY, to.horizonY);
  uniforms.uSun.value.set(lerp(from.sunX, to.sunX), lerp(from.sunY, to.sunY));
  uniforms.uSunPower.value = lerp(from.sun, to.sun);
  uniforms.uStreak.value = lerp(from.streak, to.streak);
  uniforms.uHaze.value = lerp(from.haze, to.haze);
}

function disposeMaterial(material: THREE.Material) {
  const standard = material as THREE.MeshPhysicalMaterial;
  standard.map?.dispose();
  standard.clearcoatMap?.dispose();
  standard.roughnessMap?.dispose();
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
  studio.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(20, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader: ENV_VERTEX,
        fragmentShader: ENV_FRAGMENT,
      }),
    ),
  );

  for (const panel of ENV_PANELS) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(panel.w, panel.h),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(...panel.color),
        side: THREE.DoubleSide,
      }),
    );

    const [x, y, z] = panel.pos;
    mesh.position.set(x, y, z);
    mesh.lookAt(0, 0, 0);
    studio.add(mesh);
  }

  const texture = pmrem.fromScene(studio, 0.035).texture;
  disposeObject(studio);
  pmrem.dispose();

  return texture;
}

function openPortal(geometry: THREE.BufferGeometry) {
  const index = geometry.index;
  const position = geometry.attributes.position;

  if (!index || !position) return;
  const kept: number[] = [];

  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    const x = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
    const y = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;

    if (Math.hypot(x, y) < HOLE_CUT) continue;
    kept.push(a, b, c);
  }

  geometry.setIndex(kept);
}

function roundHole(geometry: THREE.BufferGeometry) {
  const position = geometry.attributes.position;

  if (!position) return;
  const coords = position.array as Float32Array;

  for (let v = 0; v < position.count; v++) {
    const x = coords[v * 3] ?? 0;
    const y = coords[v * 3 + 1] ?? 0;
    const r = Math.hypot(x, y);

    if (r === 0 || r >= RIM_BAND) continue;

    const eased =
      r < HOLE_RADIUS
        ? HOLE_RADIUS
        : HOLE_RADIUS +
          ((r - HOLE_RADIUS) * (RIM_BAND - HOLE_RADIUS)) /
            (RIM_BAND - HOLE_RADIUS + (RIM_BAND - r) * 0.6);

    coords[v * 3] = (x / r) * eased;
    coords[v * 3 + 1] = (y / r) * eased;
  }

  position.needsUpdate = true;
}

function smoothSurface(geometry: THREE.BufferGeometry) {
  const index = geometry.index;
  const position = geometry.attributes.position;

  if (!index || !position) return;
  const count = position.count;
  const sums = new Float32Array(count * 3);
  const weights = new Float32Array(count);
  const coords = position.array as Float32Array;

  const pass = (factor: number) => {
    sums.fill(0);
    weights.fill(0);

    for (let i = 0; i < index.count; i += 3) {
      const tri = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];

      for (let e = 0; e < 3; e++) {
        const from = tri[e] ?? 0;
        const to = tri[(e + 1) % 3] ?? 0;

        for (const [a, b] of [
          [from, to],
          [to, from],
        ] as const) {
          sums[a * 3] += coords[b * 3] ?? 0;
          sums[a * 3 + 1] += coords[b * 3 + 1] ?? 0;
          sums[a * 3 + 2] += coords[b * 3 + 2] ?? 0;
          weights[a] += 1;
        }
      }
    }

    for (let v = 0; v < count; v++) {
      const w = weights[v] ?? 0;

      if (w === 0) continue;

      for (let k = 0; k < 3; k++) {
        const at = v * 3 + k;
        const current = coords[at] ?? 0;
        coords[at] = current + factor * ((sums[at] ?? 0) / w - current);
      }
    }
  };

  for (let i = 0; i < SMOOTH_PASSES; i++) {
    pass(0.5);
    pass(-0.53);
  }

  position.needsUpdate = true;
}

function prepareModel(model: THREE.Object3D, material: THREE.Material) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const scale = MODEL_SIZE / Math.max(size.x, size.y);
  model.scale.setScalar(scale);
  model.position.sub(center.multiplyScalar(scale));

  const replaced = new Set<THREE.Material>();
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geometry = child.geometry as THREE.BufferGeometry;
    geometry.deleteAttribute("color");
    openPortal(geometry);
    roundHole(geometry);
    smoothSurface(geometry);
    roundHole(geometry);
    geometry.computeVertexNormals();
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

  return model;
}

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

const easeOut = (t: number) => 1 - (1 - t) ** 3;

export type StageStatus = "live" | "failed";

export default function Stage({
  journey,
  onStatus,
}: {
  journey: RefObject<Journey>;
  onStatus: (status: StageStatus) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  useEffect(() => {
    const container = containerRef.current;

    if (!container) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let renderer: THREE.WebGLRenderer;

    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        stencil: false,
        powerPreference: "high-performance",
      });
    } catch {
      statusRef.current("failed");

      return;
    }

    let disposed = false;
    let animationId = 0;
    let visible = true;
    let pageVisible = document.visibilityState === "visible";
    let layoutWidth = 0;
    let layoutHeight = 0;
    let lastFrame = 0;
    let shownLive = false;
    let ring: THREE.Group | null = null;
    let readyAt = -1;

    renderer.autoClear = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor(0x000000, 1);
    container.appendChild(renderer.domElement);

    const onContextLost = (event: Event) => {
      event.preventDefault();
      statusRef.current("failed");
    };

    renderer.domElement.addEventListener("webglcontextlost", onContextLost);

    const backgroundScene = new THREE.Scene();
    const backgroundCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const worldUniforms = createWorldUniforms();

    const background = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: worldUniforms,
        vertexShader: SCREEN_VERTEX,
        fragmentShader: WORLD_FRAGMENT,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );

    background.frustumCulled = false;
    backgroundScene.add(background);

    const portalUniforms = createWorldUniforms();
    applyWorld(portalUniforms, WORLDS[PORTAL_WORLD], WORLDS[PORTAL_WORLD], 0);
    portalUniforms.uVignette.value = 1;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.02, 120);
    const envTexture = createEnvironment(renderer);
    scene.environment = envTexture;
    scene.environmentIntensity = 1;

    const rimWarm = new THREE.DirectionalLight(0xffb27a, 3.2);
    rimWarm.position.set(2.5, -1.5, -4);
    scene.add(rimWarm);
    const rimCool = new THREE.DirectionalLight(0xa9c2ff, 2.4);
    rimCool.position.set(-3, 2.5, -4);
    scene.add(rimCool);
    const key = new THREE.DirectionalLight(0xfff1e2, 1.6);
    key.position.set(-1.5, 3, 4);
    scene.add(key);
    scene.add(new THREE.AmbientLight(0xffffff, 0.15));

    const holder = new THREE.Group();
    holder.visible = false;
    scene.add(holder);

    const portal = new THREE.Mesh(
      new THREE.CircleGeometry(PORTAL_RADIUS, 96),
      new THREE.ShaderMaterial({
        uniforms: portalUniforms,
        vertexShader: PORTAL_VERTEX,
        fragmentShader: WORLD_FRAGMENT,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );

    holder.add(portal);

    const pointerTarget = { x: 0, y: 0 };
    const pointer = { x: 0, y: 0 };

    const onPointer = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointerTarget.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointerTarget.y = (event.clientY / window.innerHeight) * 2 - 1;
    };

    if (!reducedMotion) window.addEventListener("pointermove", onPointer);

    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });

    intersection.observe(container);

    const onVisibility = () => {
      pageVisible = document.visibilityState === "visible";
    };

    document.addEventListener("visibilitychange", onVisibility);

    const tanFor = (fov: number) => Math.tan(THREE.MathUtils.degToRad(fov / 2));

    const distances = { start: 6, finale: 4 };

    const syncLayout = () => {
      const width = Math.round(container.clientWidth);
      const height = Math.round(container.clientHeight);

      if (width === 0 || height === 0) return false;

      if (width === layoutWidth && height === layoutHeight) return true;
      layoutWidth = width;
      layoutHeight = height;

      const pixelRatio = Math.max(
        1,
        Math.min(
          window.devicePixelRatio,
          MAX_PIXEL_RATIO,
          Math.sqrt(MAX_RENDER_PIXELS / (width * height)),
        ),
      );

      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height);
      const aspect = width / height;
      camera.aspect = aspect;
      camera.fov = aspect < 0.85 ? 52 : 34;
      camera.updateProjectionMatrix();
      const t = tanFor(camera.fov);
      distances.start = Math.max(
        O_RADIUS / (0.62 * t),
        O_RADIUS / (0.66 * t * aspect),
      );
      distances.finale = Math.max(
        O_RADIUS / (0.74 * t),
        O_RADIUS / (1.24 * t * aspect),
      );
      const rw = width * pixelRatio;
      const rh = height * pixelRatio;
      worldUniforms.uResolution.value.set(rw, rh);
      portalUniforms.uResolution.value.set(rw, rh);

      return true;
    };

    const resizeObserver = new ResizeObserver(() => {
      layoutWidth = -1;
    });

    resizeObserver.observe(container);

    const startedAt = performance.now();
    const projected = new THREE.Vector3();

    const frame = (now: number) => {
      animationId = requestAnimationFrame(frame);

      if (!visible || !pageVisible) return;

      if (now - lastFrame < FRAME_MS - 2) return;
      const delta = Math.min(now - lastFrame, 100);
      lastFrame = now;

      if (!syncLayout()) return;

      const state = journey.current;
      const seconds = reducedMotion ? 0 : (now - startedAt) / 1000;
      const follow = 1 - 0.94 ** (delta / FRAME_MS);
      pointer.x += (pointerTarget.x - pointer.x) * follow;
      pointer.y += (pointerTarget.y - pointer.y) * follow;

      const travel =
        state.hero * 0.6 + state.finale * 0.5 + window.scrollY / 2400;

      worldUniforms.uTime.value = seconds;
      worldUniforms.uTravel.value = travel;
      portalUniforms.uTime.value = seconds;
      portalUniforms.uTravel.value = travel;

      const reveal =
        readyAt < 0
          ? 0
          : reducedMotion
            ? 1
            : easeOut(clamp01((now - readyAt) / 1400));

      const hero = state.hero;
      const finale = state.finale;
      let distance = Number.POSITIVE_INFINITY;
      let roll = 0;
      let tilt = 1;

      if (hero < 1) {
        const push = hero * hero;
        distance = mix(distances.start + (1 - reveal) * 1.6, -0.5, push);
        roll = push * 1.1;
        tilt = 1 - clamp01(hero * 2.2);
      } else if (finale > 0) {
        const arrive = easeOut(clamp01(finale));
        distance = mix(48, distances.finale, arrive);
        roll = (1 - arrive) * -2.4;
        tilt = arrive;
      }

      const outside = hero < 1 && distance > 0;
      applyWorld(
        worldUniforms,
        WORLDS[outside ? "dusk" : state.from],
        WORLDS[outside ? "dusk" : state.to],
        outside ? 0 : state.blend,
      );

      if (ring && Number.isFinite(distance) && distance > -0.6) {
        holder.visible = true;
        holder.position.set(0, 0, -distance);
        holder.rotation.set(
          (0.1 + Math.sin(seconds * 0.4) * 0.035 - pointer.y * 0.14) * tilt,
          (Math.sin(seconds * 0.27) * 0.12 + pointer.x * 0.22) * tilt,
          roll + Math.sin(seconds * 0.2) * 0.04 * tilt,
        );
        holder.position.y = Math.sin(seconds * 0.6) * 0.03 * tilt;
        const t = tanFor(camera.fov);
        projected.copy(holder.position).project(camera);
        worldUniforms.uRing.value.set(
          projected.x * 0.5 + 0.5,
          projected.y * 0.5 + 0.5,
          distance > 0.2 ? (O_RADIUS * 0.96) / (distance * t) / 2 : 4,
        );
        worldUniforms.uRingGlow.value = reveal * (distance > 0.2 ? 1 : 0);
        scene.environmentIntensity = reveal * 1.2;
      } else {
        holder.visible = false;
        worldUniforms.uRingGlow.value = 0;
      }

      renderer.clear();
      renderer.render(backgroundScene, backgroundCamera);
      renderer.clearDepth();
      renderer.render(scene, camera);

      if (!shownLive && ring) {
        shownLive = true;
        statusRef.current("live");
      }
    };

    animationId = requestAnimationFrame(frame);

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
          color: new THREE.Color(1, 1, 1),
          metalness: 1,
          roughness: 0.26,
          clearcoat: 0.7,
          clearcoatRoughness: 0.14,
        });

        ring = new THREE.Group();
        ring.add(prepareModel(gltf.scene, material));
        holder.add(ring);
        readyAt = performance.now();
      })
      .catch(() => {
        if (!disposed) statusRef.current("failed");
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(animationId);
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", onVisibility);
      renderer.domElement.removeEventListener(
        "webglcontextlost",
        onContextLost,
      );
      intersection.disconnect();
      resizeObserver.disconnect();
      disposeObject(holder);
      disposeObject(backgroundScene);
      envTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [journey]);

  return <div ref={containerRef} className="o3-canvas" aria-hidden="true" />;
}
