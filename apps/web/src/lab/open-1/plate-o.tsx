import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";

const FOV = 28;

const MODEL_SIZE = 2.5;

const MAX_PIXEL_RATIO = 2;

const INTRO_MS = 2600;

const ACTIVE_FRAME_MS = 1000 / 60;

const CALM_FRAME_MS = 1000 / 30;

const POINTER_CALM_MS = 2200;

const START = { x: -0.9, y: 1.1, z: -0.3 };

const REST = { x: 0.3, y: -0.46, z: 0.06 };

const STUDIO_PANELS = [
  { w: 12, h: 2.4, i: 9, p: [-2, 9, 3] },
  { w: 3, h: 8, i: 4.5, p: [9, 1, 2] },
  { w: 2, h: 6, i: 2.2, p: [-9, 0, 4] },
  { w: 10, h: 1.4, i: 1.4, p: [0, -7, 5] },
  { w: 16, h: 9, i: 1.1, p: [2, 3, 12] },
  { w: 18, h: 0.9, i: 6, p: [-3, -1, 11] },
  { w: 10, h: 4.5, i: 3.2, p: [-7.5, -2.4, 5] },
] as const;

const DOME_VERTEX = `
varying vec3 vDirection;
void main() {
  vDirection = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DOME_FRAGMENT = `
varying vec3 vDirection;
void main() {
  float h = vDirection.y * 0.5 + 0.5;
  vec3 low = vec3(0.02, 0.03, 0.16);
  vec3 high = vec3(0.62, 0.68, 1.0);
  gl_FragColor = vec4(mix(low, high, smoothstep(0.1, 0.95, h)), 1.0);
}
`;

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

const easeOutQuint = (t: number) => 1 - (1 - t) ** 5;

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
      const standard = material as THREE.MeshStandardMaterial;
      standard.map?.dispose();
      material.dispose();
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
        vertexShader: DOME_VERTEX,
        fragmentShader: DOME_FRAGMENT,
      }),
    ),
  );

  for (const panel of STUDIO_PANELS) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(panel.w, panel.h),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color().setScalar(panel.i),
        side: THREE.DoubleSide,
      }),
    );

    mesh.position.set(panel.p[0], panel.p[1], panel.p[2]);
    mesh.lookAt(0, 0, 0);
    studio.add(mesh);
  }

  const texture = pmrem.fromScene(studio, 0.03).texture;
  disposeObject(studio);
  pmrem.dispose();

  return texture;
}

const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M46.85 12.3a24.7 24.7 0 1 0 5.45 5.45L43.2 26.85a12.15 12.15 0 1 1-6.05-6.05Z"/></svg>`;

const EXTRUDE = {
  curveSegments: 96,
  bevelEnabled: true,
  bevelOffset: 0,
  bevelSegments: 12,
};

function buildMark(material: THREE.Material) {
  const ring = new THREE.ExtrudeGeometry(
    new SVGLoader()
      .parse(MARK_SVG)
      .paths.flatMap((path) => SVGLoader.createShapes(path)),
    { ...EXTRUDE, depth: 7, bevelThickness: 2.4, bevelSize: 1.5 },
  );

  const dotShape = new THREE.Shape();
  dotShape.absarc(49.5, 14.5, 6.5, 0, Math.PI * 2, false);

  const dot = new THREE.ExtrudeGeometry(dotShape, {
    ...EXTRUDE,
    depth: 7,
    bevelThickness: 3.2,
    bevelSize: 2.2,
  });

  dot.translate(0, 0, -6);

  ring.computeBoundingBox();
  const bounds = ring.boundingBox ?? new THREE.Box3();
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const scale = MODEL_SIZE / Math.max(size.x, size.y);
  const pivot = new THREE.Group();

  for (const geometry of [ring, dot]) {
    geometry.translate(-center.x, -center.y, -center.z);
    geometry.scale(scale, scale, scale);
    geometry.rotateX(Math.PI);
    geometry.computeVertexNormals();
    pivot.add(new THREE.Mesh(geometry, material));
  }

  return pivot;
}

export default function PlateO() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let frameId = 0;
    let onScreen = true;
    let dirty = true;
    let sized = false;
    let lastFrameAt = 0;
    let lastPointerAt = Number.NEGATIVE_INFINITY;
    let shown = false;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      stencil: false,
      powerPreference: "high-performance",
    });

    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const envTexture = createEnvironment(renderer);
    scene.environment = envTexture;

    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    camera.position.set(0, 0, 8);

    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-3, 5, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xc9d0ff, 3.2);
    rim.position.set(4, -2, -3);
    scene.add(rim);
    scene.add(new THREE.AmbientLight(0x8090ff, 0.25));

    const pointerTarget = { x: 0, y: 0 };
    const pointer = { x: 0, y: 0 };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointerTarget.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointerTarget.y = (event.clientY / window.innerHeight) * 2 - 1;
      lastPointerAt = performance.now();
    };

    if (!reducedMotion) window.addEventListener("pointermove", onPointerMove);

    const resize = () => {
      const { width, height } = container.getBoundingClientRect();

      if (width < 2 || height < 2) return;
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      renderer.setPixelRatio(ratio);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      const fitHeight = MODEL_SIZE / 0.6 / (2 * tan);
      const fitWidth = MODEL_SIZE / 0.74 / (2 * tan * camera.aspect);
      camera.position.z = Math.max(fitHeight, fitWidth);
      camera.updateProjectionMatrix();
      sized = true;
      dirty = true;
    };

    const resizes = new ResizeObserver(resize);
    resizes.observe(container);
    resize();

    const visibility = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
    });

    visibility.observe(container);

    const pivot = buildMark(
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(0.96, 0.97, 1),
        metalness: 1,
        roughness: 0.16,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
      }),
    );

    pivot.rotation.set(START.x, START.y, START.z);
    scene.add(pivot);
    const startedAt = performance.now();

    const frame = (now: number) => {
      frameId = requestAnimationFrame(frame);

      if (!onScreen || !sized) return;

      if (reducedMotion && !dirty) return;
      const intro = clamp01((now - startedAt) / INTRO_MS);
      const calm = intro >= 1 && now - lastPointerAt > POINTER_CALM_MS;
      const budget = calm ? CALM_FRAME_MS : ACTIVE_FRAME_MS;

      if (!dirty && now - lastFrameAt < budget - 2) return;
      const step = Math.min(now - lastFrameAt, 100);
      lastFrameAt = now;
      dirty = false;

      const t = reducedMotion ? 0 : (now - startedAt) / 1000;
      const settle = reducedMotion ? 1 : easeOutQuint(intro);
      const follow = 1 - 0.93 ** (step / ACTIVE_FRAME_MS);
      pointer.x += (pointerTarget.x - pointer.x) * follow;
      pointer.y += (pointerTarget.y - pointer.y) * follow;

      pivot.rotation.set(
        mix(START.x, REST.x, settle) +
          pointer.y * 0.22 * settle +
          Math.sin(t * 0.37) * 0.05 * settle,
        mix(START.y, REST.y, settle) +
          pointer.x * 0.38 * settle +
          Math.sin(t * 0.23) * 0.12 * settle,
        mix(START.z, REST.z, settle) + Math.sin(t * 0.19) * 0.02,
      );
      pivot.position.y = Math.sin(t * 0.6) * 0.04 * settle;
      const s = mix(0.86, 1, settle);
      pivot.scale.setScalar(s);

      scene.environmentRotation.y = mix(-1.6, 0, settle) + t * 0.05;
      renderer.render(scene, camera);

      if (!shown) {
        shown = true;
        setLive(true);
      }
    };

    frameId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("pointermove", onPointerMove);
      resizes.disconnect();
      visibility.disconnect();

      disposeObject(pivot);
      envTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className={live ? "o1-gl o1-gl--live" : "o1-gl"}
    />
  );
}
