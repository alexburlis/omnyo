import { type RefObject, useEffect, useRef } from "react";
import * as THREE from "three";

import {
  MODEL_SIZE,
  createChrome,
  createEnvironment,
  createGlass,
  disposeObject,
  loadLensModel,
} from "./lens-model";
import {
  WINDOW_HEIGHT,
  WINDOW_WIDTH,
  drawProductWindow,
} from "./product-window";

export type LensStatus = "loading" | "live" | "failed";

const SLOT_FOV = 26;

const SLOT_FILL = 1.16;

const REST_DISTANCE =
  (MODEL_SIZE * SLOT_FILL) /
  (2 * Math.tan(THREE.MathUtils.degToRad(SLOT_FOV / 2)));

const START_DISTANCE = REST_DISTANCE * 0.6;

const INTRO_MS = 2400;

const MAX_PIXEL_RATIO = 2;

const MAX_RENDER_PIXELS = 7_000_000;

const WINDOW_WORLD_WIDTH = 5.6;

const WINDOW_POSITION = new THREE.Vector3(0.85, -0.2, -2.2);

const START_ROTATION = new THREE.Euler(0.28, -0.62, 0.06);

const REST_ROTATION = new THREE.Euler(0.12, -0.24, 0);

const BACKDROP_VERTEX = `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const BACKDROP_FRAGMENT = `
uniform float uTime;
uniform float uCaustic;
varying vec3 vWorld;
vec3 spectrum(float t) {
  return clamp(abs(fract(t + vec3(0.0, 0.66, 0.33)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}
void main() {
  vec2 p = vWorld.xy;
  float vertical = smoothstep(-6.0, 6.0, p.y);
  vec3 floorTone = vec3(0.80, 0.79, 0.765);
  vec3 wallTone = vec3(0.94, 0.935, 0.925);
  vec3 color = mix(floorTone, wallTone, vertical);
  float glow = exp(-dot(p - vec2(0.2, 0.6), p - vec2(0.2, 0.6)) * 0.06);
  color += vec3(0.07, 0.07, 0.068) * glow;
  vec2 c = p - vec2(-1.2, -1.9);
  c.y *= 1.7;
  float r = length(c);
  float ring = exp(-pow((r - 1.45) / 0.2, 2.0));
  float core = exp(-pow(r / 1.2, 2.0));
  float angle = atan(c.y, c.x) / 6.2831 + uTime * 0.015;
  vec3 tint = mix(vec3(1.0), spectrum(angle + r * 0.35), 0.6);
  color *= 1.0 - core * 0.08 * uCaustic;
  color += tint * ring * 0.14 * uCaustic;
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

const WINDOW_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const WINDOW_FRAGMENT = `
uniform sampler2D uSharp;
uniform sampler2D uSoft;
uniform float uFocus;
varying vec2 vUv;
void main() {
  vec4 sharp = texture2D(uSharp, vUv);
  vec4 soft = texture2D(uSoft, vUv);
  vec4 color = mix(soft, sharp, uFocus);
  if (color.a < 0.5) discard;
  gl_FragColor = vec4(color.rgb, 1.0);
  #include <colorspace_fragment>
}
`;

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

const mix = (from: number, to: number, amount: number) =>
  from + (to - from) * amount;

const easeOutQuart = (t: number) => 1 - (1 - t) ** 4;

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

function createWindowTextures(maxAnisotropy: number) {
  const sharp = document.createElement("canvas");
  sharp.width = 2560;
  sharp.height = Math.round((2560 * WINDOW_HEIGHT) / WINDOW_WIDTH);
  const soft = document.createElement("canvas");
  soft.width = 1280;
  soft.height = Math.round((1280 * WINDOW_HEIGHT) / WINDOW_WIDTH);

  const sharpTexture = new THREE.CanvasTexture(sharp);
  sharpTexture.colorSpace = THREE.SRGBColorSpace;
  sharpTexture.anisotropy = maxAnisotropy;
  const softTexture = new THREE.CanvasTexture(soft);
  softTexture.colorSpace = THREE.SRGBColorSpace;

  const paint = () => {
    drawProductWindow(sharp);
    const context = soft.getContext("2d");

    if (context) {
      context.clearRect(0, 0, soft.width, soft.height);
      context.filter = "blur(5px)";
      context.drawImage(sharp, 0, 0, soft.width, soft.height);
      context.filter = "none";
    }

    sharpTexture.needsUpdate = true;
    softTexture.needsUpdate = true;
  };

  paint();

  return { sharpTexture, softTexture, paint };
}

function createShadowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 384;
  const context = canvas.getContext("2d");

  if (context) {
    context.filter = "blur(28px)";
    context.fillStyle = "rgba(30, 28, 24, 0.5)";
    context.beginPath();
    context.roundRect(80, 86, 352, 236, 30);
    context.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  return texture;
}

export function LensScene({
  slotRef,
  heroRef,
  onStatus,
}: {
  slotRef: RefObject<HTMLElement | null>;
  heroRef: RefObject<HTMLElement | null>;
  onStatus: (status: LensStatus) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  useEffect(() => {
    const container = containerRef.current;
    const slot = slotRef.current;
    const hero = heroRef.current;

    if (!container || !slot || !hero) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let renderer: THREE.WebGLRenderer;

    if (!document.createElement("canvas").getContext("webgl2")) {
      statusRef.current("failed");

      return;
    }

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
    let onScreen = true;
    let layoutDirty = true;
    let layoutRatio = 0;
    let dirty = true;
    let live = false;
    let pivot: THREE.Group | null = null;
    let modelReadyAt = -1;

    renderer.setClearColor(0xefeeeb, 1);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.setAttribute("aria-hidden", "true");
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const envTexture = createEnvironment(renderer);
    scene.environment = envTexture;

    const camera = new THREE.PerspectiveCamera(SLOT_FOV, 1, 0.1, 80);

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-3, 5, 4);
    scene.add(key);

    const backdropUniforms = {
      uTime: { value: 0 },
      uCaustic: { value: 0 },
    };

    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 60),
      new THREE.ShaderMaterial({
        uniforms: backdropUniforms,
        vertexShader: BACKDROP_VERTEX,
        fragmentShader: BACKDROP_FRAGMENT,
      }),
    );

    backdrop.position.z = -6;
    scene.add(backdrop);

    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    const windowArt = createWindowTextures(maxAnisotropy);
    const windowHeight = (WINDOW_WORLD_WIDTH * WINDOW_HEIGHT) / WINDOW_WIDTH;

    const windowUniforms = {
      uSharp: { value: windowArt.sharpTexture },
      uSoft: { value: windowArt.softTexture },
      uFocus: { value: 0 },
    };

    const windowMaterial = new THREE.ShaderMaterial({
      uniforms: windowUniforms,
      vertexShader: WINDOW_VERTEX,
      fragmentShader: WINDOW_FRAGMENT,
    });

    const productWindow = new THREE.Mesh(
      new THREE.PlaneGeometry(WINDOW_WORLD_WIDTH, windowHeight),
      windowMaterial,
    );

    productWindow.position.copy(WINDOW_POSITION);
    productWindow.rotation.set(0.02, -0.14, 0);
    productWindow.onBeforeRender = (activeRenderer) => {
      const focus = activeRenderer.getRenderTarget() ? 1 : 0;

      if (windowUniforms.uFocus.value !== focus) {
        windowUniforms.uFocus.value = focus;
        windowMaterial.uniformsNeedUpdate = true;
      }
    };

    scene.add(productWindow);

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(WINDOW_WORLD_WIDTH * 1.45, windowHeight * 1.62),
      new THREE.MeshBasicMaterial({
        map: createShadowTexture(),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );

    shadow.position.set(WINDOW_POSITION.x + 0.4, WINDOW_POSITION.y - 0.5, -5.9);
    scene.add(shadow);

    void document.fonts.ready.then(() => {
      if (disposed) return;
      windowArt.paint();
      dirty = true;
    });

    const chrome = createChrome();
    const glass = createGlass();

    const pointerTarget = { x: 0, y: 0 };
    const pointer = { x: 0, y: 0 };

    const handlePointer = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointerTarget.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointerTarget.y = (event.clientY / window.innerHeight) * 2 - 1;
    };

    if (!reducedMotion) window.addEventListener("pointermove", handlePointer);

    const markDirty = () => {
      layoutDirty = true;
      dirty = true;
    };

    const visibility = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
      dirty = true;
    });

    visibility.observe(container);

    const resizes = new ResizeObserver(markDirty);
    resizes.observe(container);
    resizes.observe(slot);
    window.addEventListener("resize", markDirty);

    const syncLayout = () => {
      const bounds = container.getBoundingClientRect();
      const target = slot.getBoundingClientRect();
      const width = Math.round(bounds.width);
      const height = Math.round(bounds.height);

      if (width === 0 || height === 0 || target.height === 0) return false;

      const pixelRatio = Math.max(
        1,
        Math.min(
          window.devicePixelRatio,
          MAX_PIXEL_RATIO,
          Math.sqrt(MAX_RENDER_PIXELS / (width * height)),
        ),
      );

      const centerX = target.left + target.width / 2 - bounds.left;
      const centerY = target.top + target.height / 2 - bounds.top;
      const halfWidth = Math.max(centerX, width - centerX);
      const halfHeight = Math.max(centerY, height - centerY);
      const slotSize = Math.min(target.width, target.height);
      const tangent = Math.tan(THREE.MathUtils.degToRad(SLOT_FOV / 2));

      camera.aspect = halfWidth / halfHeight;
      camera.fov = THREE.MathUtils.radToDeg(
        2 * Math.atan((tangent * halfHeight * 2) / slotSize),
      );
      camera.setViewOffset(
        halfWidth * 2 * pixelRatio,
        halfHeight * 2 * pixelRatio,
        (halfWidth - centerX) * pixelRatio,
        (halfHeight - centerY) * pixelRatio,
        width * pixelRatio,
        height * pixelRatio,
      );
      camera.updateProjectionMatrix();

      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
      layoutRatio = window.devicePixelRatio;

      return true;
    };

    const startedAt = performance.now();
    let lastAt = startedAt;

    const frame = (now: number) => {
      animationId = requestAnimationFrame(frame);

      if (!onScreen) return;

      if (layoutDirty || window.devicePixelRatio !== layoutRatio) {
        if (!syncLayout()) return;
        layoutDirty = false;
        dirty = true;
      }

      if (reducedMotion && !dirty) return;
      dirty = false;

      const delta = Math.min(now - lastAt, 100);
      lastAt = now;
      const seconds = reducedMotion ? 0 : (now - startedAt) / 1000;

      const intro =
        modelReadyAt < 0
          ? 0
          : reducedMotion
            ? 1
            : clamp01((now - modelReadyAt) / INTRO_MS);

      const dolly = easeOutQuart(intro);
      const settle = easeInOutCubic(intro);

      const heroBounds = hero.getBoundingClientRect();

      const scrolled = reducedMotion
        ? 0
        : clamp01(-heroBounds.top / Math.max(heroBounds.height, 1));

      const follow = 1 - 0.92 ** (delta / 16.7);
      pointer.x += (pointerTarget.x - pointer.x) * follow;
      pointer.y += (pointerTarget.y - pointer.y) * follow;

      camera.position.set(
        pointer.x * 0.16,
        -pointer.y * 0.1,
        mix(START_DISTANCE, REST_DISTANCE, dolly) + scrolled * 1.4,
      );
      camera.lookAt(0, 0, 0);

      backdropUniforms.uTime.value = seconds;
      backdropUniforms.uCaustic.value = settle;

      scene.environmentRotation.y =
        mix(-1.4, 0, dolly) + Math.sin(seconds * 0.21) * 0.32;

      if (pivot) {
        pivot.rotation.set(
          mix(START_ROTATION.x, REST_ROTATION.x, settle) +
            Math.sin(seconds * 0.37) * 0.04 +
            pointer.y * 0.1 -
            scrolled * 0.3,
          mix(START_ROTATION.y, REST_ROTATION.y, settle) +
            Math.sin(seconds * 0.23) * 0.12 +
            pointer.x * 0.2 +
            scrolled * 0.9,
          mix(START_ROTATION.z, REST_ROTATION.z, settle),
        );
        pivot.position.y = Math.sin(seconds * 0.6) * 0.035;
      }

      renderer.render(scene, camera);

      if (pivot && !live) {
        live = true;
        statusRef.current("live");
      }
    };

    animationId = requestAnimationFrame(frame);

    const loading = new AbortController();

    loadLensModel({ chrome, glass, signal: loading.signal }).then(
      (model) => {
        if (disposed) {
          disposeObject(model);

          return;
        }

        pivot = model;
        pivot.rotation.copy(START_ROTATION);
        scene.add(pivot);
        modelReadyAt = performance.now();
        dirty = true;
      },
      (error: unknown) => {
        if (disposed || loading.signal.aborted) return;
        console.warn("The Omnyo model could not be loaded", error);
        statusRef.current("failed");
      },
    );

    return () => {
      disposed = true;
      loading.abort();
      cancelAnimationFrame(animationId);
      window.removeEventListener("pointermove", handlePointer);
      window.removeEventListener("resize", markDirty);
      visibility.disconnect();
      resizes.disconnect();

      if (pivot) disposeObject(pivot);
      chrome.dispose();
      glass.dispose();
      disposeObject(backdrop);
      disposeObject(shadow);
      productWindow.geometry.dispose();
      windowMaterial.dispose();
      windowArt.sharpTexture.dispose();
      windowArt.softTexture.dispose();
      envTexture.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [slotRef, heroRef]);

  return <div ref={containerRef} className="lens-canvas" aria-hidden="true" />;
}
