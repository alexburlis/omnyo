import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export type AgentState =
  | "running"
  | "review"
  | "waiting"
  | "scheduled"
  | "done";

export interface Satellite {
  id: string;
  agent: string;
  detail: string;
  state: AgentState;
  ring: number;
  phase: number;
  speed: number;
}

const STATE_COLORS: Record<AgentState, number> = {
  running: 0xff6a2b,
  review: 0xa9b8ff,
  waiting: 0xffc94d,
  scheduled: 0x8a94a2,
  done: 0xede9e1,
};

const RINGS = [
  { radius: 1.72, tiltX: 1.18, tiltZ: -0.32 },
  { radius: 2.12, tiltX: 1.26, tiltZ: 0.24 },
  { radius: 2.52, tiltX: 1.1, tiltZ: -0.08 },
] as const;

const FOV = 28;

const MODEL_SIZE = 2.3;

const HOLE_RATIO = 0.52;

const FIT_HALF_WIDTH = 2.72;

const FIT_HALF_HEIGHT = 2.35;

const TRAIL_POINTS = 48;

const TRAIL_ARC = 0.9;

const MAX_PIXEL_RATIO = 2;

const STUDIO_PANELS = [
  { width: 16, height: 2.4, intensity: 6, position: [0, 9, 1] },
  { width: 10, height: 7, intensity: 0.9, position: [0, 1, 11] },
  { width: 2, height: 7, intensity: 2.4, position: [-9, 2, 2] },
  { width: 1.4, height: 6, intensity: 1.2, position: [9, 1, -2] },
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
  vec3 low = vec3(0.02, 0.025, 0.035);
  vec3 high = vec3(0.16, 0.17, 0.19);
  gl_FragColor = vec4(mix(low, high, h * h), 1.0);
}
`;

function disposeObject(object: THREE.Object3D) {
  const materials = new Set<THREE.Material>();
  object.traverse((child) => {
    if (
      child instanceof THREE.Mesh ||
      child instanceof THREE.Line ||
      child instanceof THREE.Sprite
    ) {
      child.geometry.dispose();

      const list = Array.isArray(child.material)
        ? child.material
        : [child.material];

      for (const material of list) materials.add(material);
    }
  });

  for (const material of materials) {
    const mapped = material as THREE.MeshBasicMaterial;
    mapped.map?.dispose();
    material.dispose();
  }
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
      new THREE.PlaneGeometry(panel.width, panel.height),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color().setScalar(panel.intensity),
        side: THREE.DoubleSide,
      }),
    );

    const [x, y, z] = panel.position;
    mesh.position.set(x, y, z);
    mesh.lookAt(0, 0, 0);
    studio.add(mesh);
  }

  const warm = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 8),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(1, 0.36, 0.12).multiplyScalar(3.2),
      side: THREE.DoubleSide,
    }),
  );

  warm.position.set(8, -1, -6);
  warm.lookAt(0, 0, 0);
  studio.add(warm);
  const texture = pmrem.fromScene(studio, 0.03).texture;
  disposeObject(studio);
  pmrem.dispose();

  return texture;
}

function createGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");

  if (context) {
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.25, "rgba(255,255,255,0.45)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  return texture;
}

function ringPoint(radius: number, angle: number, target: THREE.Vector3) {
  return target.set(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
}

function openRing(geometry: THREE.BufferGeometry) {
  const index = geometry.getIndex();
  const position = geometry.getAttribute("position");

  if (!index || !position) return;
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;

  if (!bounds) return;
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cy = (bounds.min.y + bounds.max.y) / 2;
  const half = Math.max(bounds.max.x - cx, bounds.max.y - cy);
  const kept: number[] = [];

  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    const x = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
    const y = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;

    if (Math.hypot(x - cx, y - cy) / half < HOLE_RATIO) continue;
    kept.push(a, b, c);
  }

  geometry.setIndex(kept);
}

function prepareModel(model: THREE.Object3D, material: THREE.Material) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const scale = MODEL_SIZE / Math.max(size.x, size.y, size.z);
  model.scale.setScalar(scale);
  model.position.sub(center.multiplyScalar(scale));
  const replaced = new Set<THREE.Material>();
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    openRing(child.geometry);
    child.geometry.computeVertexNormals();

    const list = Array.isArray(child.material)
      ? child.material
      : [child.material];

    for (const old of list) {
      if (!old || replaced.has(old)) continue;
      replaced.add(old);
      old.dispose();
    }

    child.material = material;
  });
  const pivot = new THREE.Group();
  pivot.add(model);

  return pivot;
}

export default function Orbit({ satellites }: { satellites: Satellite[] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    const host = hostRef.current;

    if (!root || !host) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let disposed = false;
    let frameId = 0;
    let onScreen = true;
    let width = 0;
    let height = 0;
    let layoutDirty = true;
    let lastAt = performance.now();
    let elapsed = 0;
    let pivot: THREE.Group | null = null;
    let modelAt = -1;
    let shown = false;
    let dirty = true;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      stencil: false,
    });

    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const environment = createEnvironment(renderer);
    scene.environment = environment;

    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 60);

    const key = new THREE.DirectionalLight(0xf4f1ea, 1.4);
    key.position.set(-3, 5, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xff6a2b, 3.2);
    rim.position.set(4, -1.5, -3);
    scene.add(rim);

    const system = new THREE.Group();
    system.rotation.x = 0.1;
    scene.add(system);

    const glowTexture = createGlowTexture();
    const ringGroups: THREE.Group[] = [];

    for (const ring of RINGS) {
      const group = new THREE.Group();
      group.rotation.set(ring.tiltX, 0, ring.tiltZ);
      const points: THREE.Vector3[] = [];

      for (let i = 0; i <= 256; i++) {
        points.push(
          ringPoint(ring.radius, (i / 256) * Math.PI * 2, new THREE.Vector3()),
        );
      }

      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({
          color: 0x9aa6b6,
          transparent: true,
          opacity: 0.32,
        }),
      );

      group.add(line);
      const ticks: THREE.Vector3[] = [];

      for (let i = 0; i < 24; i++) {
        const angle = (i / 24) * Math.PI * 2;
        ticks.push(
          ringPoint(ring.radius - 0.035, angle, new THREE.Vector3()),
          ringPoint(ring.radius + 0.035, angle, new THREE.Vector3()),
        );
      }

      group.add(
        new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(ticks),
          new THREE.LineBasicMaterial({
            color: 0x9aa6b6,
            transparent: true,
            opacity: 0.5,
          }),
        ),
      );
      system.add(group);
      ringGroups.push(group);
    }

    const sats = satellites.map((satellite) => {
      const ring = RINGS[satellite.ring] ?? RINGS[0];
      const group = ringGroups[satellite.ring] ?? ringGroups[0]!;
      const color = new THREE.Color(STATE_COLORS[satellite.state]);

      const body = new THREE.Mesh(
        new THREE.SphereGeometry(0.052, 20, 14),
        new THREE.MeshBasicMaterial({ color }),
      );

      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTexture,
          color,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );

      halo.scale.setScalar(0.42);
      body.add(halo);
      group.add(body);

      const trailPositions = new Float32Array(TRAIL_POINTS * 3);
      const trailColors = new Float32Array(TRAIL_POINTS * 3);

      for (let i = 0; i < TRAIL_POINTS; i++) {
        const fade = (i / (TRAIL_POINTS - 1)) ** 1.6;
        trailColors[i * 3] = color.r * fade;
        trailColors[i * 3 + 1] = color.g * fade;
        trailColors[i * 3 + 2] = color.b * fade;
      }

      const trailGeometry = new THREE.BufferGeometry();
      trailGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(trailPositions, 3),
      );
      trailGeometry.setAttribute(
        "color",
        new THREE.BufferAttribute(trailColors, 3),
      );

      const trail = new THREE.Line(
        trailGeometry,
        new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );

      group.add(trail);

      return {
        satellite,
        radius: ring.radius,
        body,
        trail,
        trailPositions,
        angle: satellite.phase,
      };
    });

    const pointerTarget = { x: 0, y: 0 };
    const pointer = { x: 0, y: 0 };

    const handlePointer = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointerTarget.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointerTarget.y = (event.clientY / window.innerHeight) * 2 - 1;
    };

    if (!reducedMotion) window.addEventListener("pointermove", handlePointer);

    const visibility = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
    });

    visibility.observe(root);

    const resize = new ResizeObserver(() => {
      layoutDirty = true;
    });

    resize.observe(root);

    const syncLayout = () => {
      const bounds = root.getBoundingClientRect();
      width = Math.round(bounds.width);
      height = Math.round(bounds.height);

      if (width === 0 || height === 0) return false;
      const ratio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
      renderer.setPixelRatio(ratio);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      const tangent = Math.tan(THREE.MathUtils.degToRad(FOV / 2));

      const distance = Math.max(
        FIT_HALF_HEIGHT / tangent,
        FIT_HALF_WIDTH / (tangent * camera.aspect),
      );

      camera.position.set(0, 0.25, distance);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();

      return true;
    };

    const world = new THREE.Vector3();
    const local = new THREE.Vector3();
    const core = new THREE.Vector3();
    const shifts = new Map<HTMLDivElement, number>();
    let shiftFollow = 1;

    const placed: {
      label: HTMLDivElement;
      x: number;
      y: number;
      left: number;
      tagWidth: number;
      tagHeight: number;
      side: number;
      depth: number;
      shift: number;
    }[] = [];

    const edge = new THREE.Vector3();

    const place = () => {
      core.set(0, 0, 0).project(camera);
      const cx = (core.x * 0.5 + 0.5) * width;
      const cy = (-core.y * 0.5 + 0.5) * height;
      edge.set((MODEL_SIZE / 2) * (pivot?.scale.x ?? 1), 0, 0).project(camera);
      const coreRadius = Math.abs((edge.x * 0.5 + 0.5) * width - cx) * 1.08;

      placed.length = 0;

      for (const [index, entry] of sats.entries()) {
        ringPoint(entry.radius, entry.angle, local);
        entry.body.position.copy(local);

        for (let i = 0; i < TRAIL_POINTS; i++) {
          const angle = entry.angle - TRAIL_ARC * (1 - i / (TRAIL_POINTS - 1));
          ringPoint(entry.radius, angle, local);
          entry.trailPositions[i * 3] = local.x;
          entry.trailPositions[i * 3 + 1] = local.y;
          entry.trailPositions[i * 3 + 2] = local.z;
        }

        const attribute = entry.trail.geometry.getAttribute("position");
        attribute.needsUpdate = true;

        const label = labelRefs.current[index];

        if (!label) continue;
        entry.body.getWorldPosition(world);
        const depth = world.z;
        world.project(camera);
        const x = (world.x * 0.5 + 0.5) * width;
        const y = (-world.y * 0.5 + 0.5) * height;
        const tag = label.firstElementChild as HTMLElement | null;
        const tagWidth = tag?.offsetWidth ?? 0;
        const tagHeight = tag?.offsetHeight ?? 0;
        const side = x >= cx ? 1 : -1;

        const nearest = Math.min(
          Math.max(cy, y - tagHeight / 2),
          y + tagHeight / 2,
        );

        const dy = Math.abs(nearest - cy);

        const chord =
          dy < coreRadius ? Math.sqrt(coreRadius ** 2 - dy ** 2) + 14 : 0;

        const preferred =
          side > 0
            ? Math.max(x + 18, chord ? cx + chord : -Infinity)
            : Math.min(x - 18, chord ? cx - chord : Infinity) - tagWidth;

        const left = Math.min(Math.max(preferred, 10), width - 10 - tagWidth);
        placed.push({
          label,
          x,
          y,
          left,
          tagWidth,
          tagHeight,
          side,
          depth,
          shift: 0,
        });
      }

      placed.sort((a, b) => b.depth - a.depth);

      for (const [index, item] of placed.entries()) {
        for (const other of placed.slice(0, index)) {
          const overlapX =
            item.left < other.left + other.tagWidth + 6 &&
            other.left < item.left + item.tagWidth + 6;

          const top = item.y + item.shift - item.tagHeight / 2;
          const otherTop = other.y + other.shift - other.tagHeight / 2;

          const overlapY =
            top < otherTop + other.tagHeight + 6 &&
            otherTop < top + item.tagHeight + 6;

          if (!overlapX || !overlapY) continue;
          item.shift =
            top >= otherTop
              ? otherTop + other.tagHeight + 6 - (item.y - item.tagHeight / 2)
              : otherTop - item.tagHeight - 6 - (item.y - item.tagHeight / 2);
        }
      }

      for (const item of placed) {
        const { label, x, y, left, tagWidth, side, depth } = item;
        const previous = shifts.get(label) ?? item.shift;
        const shift = previous + (item.shift - previous) * shiftFollow;
        shifts.set(label, shift);
        const attach = side > 0 ? left - x : left - x + tagWidth;
        const length = Math.max(0, Math.hypot(attach, shift) - 5);
        const angle = Math.atan2(shift, attach);
        label.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
        label.style.setProperty("--tx", `${(left - x).toFixed(1)}px`);
        label.style.setProperty("--ty", `${shift.toFixed(1)}px`);
        label.style.setProperty("--lead-w", `${length.toFixed(1)}px`);
        label.style.setProperty("--lead-a", `${angle.toFixed(3)}rad`);
        label.style.zIndex = depth < 0 ? "1" : "3";
        label.dataset.side = side > 0 ? "right" : "left";
        label.dataset.behind = depth < -0.15 ? "true" : "false";
      }
    };

    const frame = (now: number) => {
      frameId = requestAnimationFrame(frame);

      if (!onScreen) {
        lastAt = now;

        return;
      }

      if (layoutDirty) {
        if (!syncLayout()) return;
        layoutDirty = false;
        dirty = true;
      }

      if (reducedMotion && !dirty) {
        lastAt = now;

        return;
      }

      dirty = false;
      const delta = Math.min((now - lastAt) / 1000, 0.1);
      lastAt = now;

      if (!reducedMotion) elapsed += delta;

      if (!reducedMotion) {
        for (const entry of sats) entry.angle += entry.satellite.speed * delta;
      }

      const follow = 1 - 0.92 ** (delta * 60);
      pointer.x += (pointerTarget.x - pointer.x) * follow;
      pointer.y += (pointerTarget.y - pointer.y) * follow;
      system.rotation.set(0.1 + pointer.y * 0.06, pointer.x * 0.12, 0);

      if (pivot) {
        const reveal =
          reducedMotion || modelAt < 0
            ? 1
            : Math.min(1, (now - modelAt) / 1600);

        const ease = 1 - (1 - reveal) ** 3;
        pivot.scale.setScalar(0.86 + ease * 0.14);
        pivot.rotation.set(
          -0.08 + pointer.y * 0.08,
          Math.sin(elapsed * 0.35) * 0.32 + pointer.x * 0.2 + (1 - ease) * -0.9,
          Math.sin(elapsed * 0.21) * 0.03,
        );
      }

      shiftFollow = reducedMotion ? 1 : 1 - 0.86 ** (delta * 60);
      place();
      renderer.render(scene, camera);

      if (!shown) {
        shown = true;
        setLive(true);
      }
    };

    frameId = requestAnimationFrame(frame);

    new GLTFLoader()
      .loadAsync("/model.glb")
      .then((gltf) => {
        if (disposed) {
          disposeObject(gltf.scene);

          return;
        }

        pivot = prepareModel(
          gltf.scene,
          new THREE.MeshPhysicalMaterial({
            color: 0xf2ede4,
            metalness: 1,
            roughness: 0.2,
            clearcoat: 1,
            clearcoatRoughness: 0.06,
          }),
        );
        system.add(pivot);
        modelAt = performance.now();
        dirty = true;
      })
      .catch((error: unknown) => {
        console.error("Omnyo model failed to load", error);
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      window.removeEventListener("pointermove", handlePointer);
      visibility.disconnect();
      resize.disconnect();

      if (pivot) disposeObject(pivot);
      disposeObject(system);
      glowTexture.dispose();
      environment.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [satellites]);

  return (
    <div
      ref={rootRef}
      className={live ? "o3-orbit is-live" : "o3-orbit"}
      aria-hidden="true"
    >
      <svg className="o3-scope" viewBox="-100 -100 200 200">
        <circle r="96" />
        <circle r="70" className="o3-scope-faint" />
        <circle r="44" className="o3-scope-faint" />
        <line x1="-100" y1="0" x2="100" y2="0" className="o3-scope-faint" />
        <line x1="0" y1="-100" x2="0" y2="100" className="o3-scope-faint" />
        {Array.from({ length: 120 }, (_, index) => {
          const angle = (index / 120) * Math.PI * 2;
          const major = index % 10 === 0;
          const inner = major ? 90.5 : 93.5;

          return (
            <line
              key={index}
              x1={Math.cos(angle) * inner}
              y1={Math.sin(angle) * inner}
              x2={Math.cos(angle) * 96}
              y2={Math.sin(angle) * 96}
              className={major ? "o3-scope-major" : undefined}
            />
          );
        })}
        <g className="o3-sweep">
          <path d="M0 0 L96 0 A96 96 0 0 0 83.1 -48 Z" />
        </g>
      </svg>
      <div ref={hostRef} className="o3-orbit-canvas" />
      {satellites.map((satellite, index) => (
        <div
          key={satellite.id}
          ref={(element) => {
            labelRefs.current[index] = element;
          }}
          className={`o3-sat o3-state--${satellite.state}`}
        >
          <span className="o3-sat-tag">
            <b>{satellite.agent}</b>
            <span>{satellite.detail}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
