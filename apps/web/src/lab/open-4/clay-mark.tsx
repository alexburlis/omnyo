import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const RING_RADIUS = 18.4;

const TUBE_RADIUS = 6.27;

const GAP_CENTER = Math.PI / 4;

const GAP_HALF = THREE.MathUtils.degToRad(25);

const BALL_ORBIT = 25.6;

const BALL_RADIUS = 6.5;

const UNIT = 1 / 26;

const MAX_PIXEL_RATIO = 2;

const INTRO_MS = 2600;

const BALL_DROP_MS = 1500;

const BALL_DELAY_MS = 900;

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

const easeOutBack = (t: number) => {
  const c1 = 1.5;
  const c3 = c1 + 1;

  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

function buildRing(material: THREE.Material) {
  const group = new THREE.Group();
  const arc = Math.PI * 2 - GAP_HALF * 2;
  const start = GAP_CENTER + GAP_HALF;

  const torus = new THREE.Mesh(
    new THREE.TorusGeometry(
      RING_RADIUS * UNIT,
      TUBE_RADIUS * UNIT,
      64,
      320,
      arc,
    ),
    material,
  );

  torus.rotation.z = start;
  group.add(torus);

  for (const angle of [start, start + arc]) {
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(TUBE_RADIUS * UNIT, 64, 48),
      material,
    );

    cap.position.set(
      Math.cos(angle) * RING_RADIUS * UNIT,
      Math.sin(angle) * RING_RADIUS * UNIT,
      0,
    );
    group.add(cap);
  }

  group.scale.set(1, 1, 0.88);
  group.traverse((child) => {
    child.castShadow = true;
  });

  return group;
}

function makeClayGrain() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");

  if (!context) return null;
  const image = context.createImageData(size, size);
  const coarse = new Float32Array(32 * 32);

  for (let index = 0; index < coarse.length; index++)
    coarse[index] = Math.random();

  const sample = (x: number, y: number) => {
    const gx = (x / size) * 32;
    const gy = (y / size) * 32;
    const x0 = Math.floor(gx) % 32;
    const y0 = Math.floor(gy) % 32;
    const x1 = (x0 + 1) % 32;
    const y1 = (y0 + 1) % 32;
    const tx = gx - Math.floor(gx);
    const ty = gy - Math.floor(gy);
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const top = coarse[y0 * 32 + x0]! * (1 - sx) + coarse[y0 * 32 + x1]! * sx;

    const bottom =
      coarse[y1 * 32 + x0]! * (1 - sx) + coarse[y1 * 32 + x1]! * sx;

    return top * (1 - sy) + bottom * sy;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = 150 + sample(x, y) * 60 + (Math.random() - 0.5) * 34;
      const offset = (y * size + x) * 4;
      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
      image.data[offset + 3] = 255;
    }
  }

  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;

  return texture;
}

function disposeScene(object: THREE.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();

      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];

      for (const material of materials) material.dispose();
    }
  });
}

export default function ClayMark({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);

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
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch {
      return;
    }

    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.VSMShadowMap;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const envTexture = pmrem.fromScene(room, 0.04).texture;
    disposeScene(room);
    pmrem.dispose();
    scene.environment = envTexture;
    scene.environmentIntensity = 0.55;

    const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 60);
    camera.position.set(0, 0.25, 9.6);
    camera.lookAt(0, 0.05, 0);

    scene.add(new THREE.HemisphereLight(0xfff3e4, 0xb9805e, 0.7));

    const key = new THREE.DirectionalLight(0xfff1df, 2.8);
    key.position.set(-2.6, 3.6, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -4;
    key.shadow.camera.right = 4;
    key.shadow.camera.top = 4;
    key.shadow.camera.bottom = -4;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 16;
    key.shadow.radius = 14;
    key.shadow.blurSamples = 20;
    key.shadow.bias = -0.0006;
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xffd7bd, 0.7);
    fill.position.set(4, -1, 3);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 1.1);
    rim.position.set(2, 3, -4);
    scene.add(rim);

    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.ShadowMaterial({ color: 0x6b3a1f, opacity: 0.16 }),
    );

    wall.position.z = -0.75;
    wall.receiveShadow = true;
    scene.add(wall);

    const grain = makeClayGrain();
    const ringGrain = grain?.clone() ?? null;

    if (ringGrain) {
      ringGrain.repeat.set(7, 2.5);
      ringGrain.needsUpdate = true;
    }

    if (grain) grain.repeat.set(2, 1);

    const clay = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color("#b84e2e"),
      roughness: 0.82,
      bumpMap: ringGrain,
      bumpScale: 0.9,
      roughnessMap: ringGrain,
      metalness: 0,
      sheen: 0.7,
      sheenRoughness: 0.55,
      sheenColor: new THREE.Color("#ffd2b8"),
      clearcoat: 0.12,
      clearcoatRoughness: 0.5,
    });

    const butter = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color("#f1c56a"),
      roughness: 0.5,
      bumpMap: grain,
      bumpScale: 0.7,
      metalness: 0,
      sheen: 0.5,
      sheenColor: new THREE.Color("#fff1c8"),
      clearcoat: 0.3,
      clearcoatRoughness: 0.35,
    });

    const pivot = new THREE.Group();
    scene.add(pivot);
    const body = new THREE.Group();
    body.position.set(-0.1, -0.1, 0);
    pivot.add(body);

    body.add(buildRing(clay));

    const ballRest = new THREE.Vector3(
      Math.cos(GAP_CENTER) * BALL_ORBIT * UNIT,
      Math.sin(GAP_CENTER) * BALL_ORBIT * UNIT,
      0,
    );

    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS * UNIT, 64, 48),
      butter,
    );

    ball.castShadow = true;
    ball.position.copy(ballRest);
    body.add(ball);

    const pointerTarget = { x: 0, y: 0 };
    const pointer = { x: 0, y: 0 };

    let lastPointerAt = Number.NEGATIVE_INFINITY;

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      lastPointerAt = performance.now();
      pointerTarget.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointerTarget.y = (event.clientY / window.innerHeight) * 2 - 1;
    };

    if (!reducedMotion) {
      window.addEventListener("pointermove", handlePointerMove, {
        passive: true,
      });
    }

    let onScreen = true;

    const visibility = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
    });

    visibility.observe(container);

    let layoutDirty = true;

    const resizes = new ResizeObserver(() => {
      layoutDirty = true;
    });

    resizes.observe(container);

    const syncLayout = () => {
      const width = Math.round(container.clientWidth);
      const height = Math.round(container.clientHeight);

      if (width === 0 || height === 0) return false;
      renderer.setPixelRatio(
        Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO),
      );
      renderer.setSize(width, height);
      camera.aspect = width / height;
      const baseFov = 24;
      const halfWidth = 1.75;

      const neededFov = THREE.MathUtils.radToDeg(
        2 * Math.atan(halfWidth / camera.position.z / camera.aspect),
      );

      camera.fov = Math.max(baseFov, neededFov);
      camera.updateProjectionMatrix();

      return true;
    };

    const startedAt = performance.now();
    let lastAt = startedAt;
    let animationId = 0;
    let shown = false;

    const frame = (now: number) => {
      animationId = requestAnimationFrame(frame);

      if (!onScreen && shown) return;

      if (layoutDirty) {
        if (!syncLayout()) return;
        layoutDirty = false;

        if (reducedMotion) shown = false;
      }

      if (reducedMotion && shown) return;

      const calm =
        now - startedAt > INTRO_MS + 2000 && now - lastPointerAt > 2500;

      if (shown && calm && now - lastAt < 1000 / 30 - 2) return;

      const elapsed = reducedMotion ? 1e9 : now - startedAt;
      const delta = Math.min(now - lastAt, 100);
      lastAt = now;
      const seconds = elapsed / 1000;

      const intro = easeOutCubic(clamp01(elapsed / INTRO_MS));
      const drop = clamp01((elapsed - BALL_DELAY_MS) / BALL_DROP_MS);
      const settle = clamp01((elapsed - INTRO_MS) / 1800);

      const follow = 1 - 0.94 ** (delta / 16.7);
      pointer.x += (pointerTarget.x - pointer.x) * follow;
      pointer.y += (pointerTarget.y - pointer.y) * follow;

      pivot.rotation.set(
        THREE.MathUtils.lerp(0.55, -0.06, intro) +
          pointer.y * 0.12 * settle +
          Math.sin(seconds * 0.6) * 0.03 * settle,
        THREE.MathUtils.lerp(-0.9, 0.22, intro) +
          pointer.x * 0.28 * settle +
          Math.sin(seconds * 0.42) * 0.08 * settle,
        THREE.MathUtils.lerp(-0.25, 0.02, intro),
      );
      pivot.position.set(
        0,
        THREE.MathUtils.lerp(-0.5, 0, intro) +
          Math.sin(seconds * 0.9) * 0.05 * settle,
        THREE.MathUtils.lerp(-1.2, 0, intro),
      );

      const dropEase = easeOutBack(drop);
      ball.position.set(
        ballRest.x + (1 - dropEase) * 1.4,
        ballRest.y +
          (1 - dropEase) * 1.9 +
          Math.sin(seconds * 1.6) * 0.035 * settle,
        ballRest.z + (1 - dropEase) * 0.8,
      );
      ball.scale.setScalar(0.4 + 0.6 * easeOutCubic(drop));

      renderer.render(scene, camera);

      if (!shown) {
        shown = true;
        setLive(true);
      }
    };

    animationId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("pointermove", handlePointerMove);
      visibility.disconnect();
      resizes.disconnect();
      disposeScene(scene);
      grain?.dispose();
      ringGrain?.dispose();
      envTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className={`${className ?? ""} clay-canvas${live ? " is-live" : ""}`}
    />
  );
}
