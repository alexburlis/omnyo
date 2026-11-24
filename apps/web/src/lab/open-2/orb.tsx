import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const MODEL_SIZE = 2.4;

const PANELS = [
  { w: 12, h: 3, i: 3.2, p: [0, 8, 3], c: [1, 1, 1] },
  { w: 4, h: 9, i: 4.5, p: [-7, 1, 3], c: [1, 0.55, 0.38] },
  { w: 4, h: 9, i: 4.5, p: [7, 1, 3], c: [0.42, 0.5, 1] },
  { w: 10, h: 1.4, i: 1.4, p: [0, -2, 8], c: [1, 1, 1] },
] as const;

function disposeTree(object: THREE.Object3D) {
  const seen = new Set<THREE.Material>();
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();

    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];

    for (const material of materials) {
      if (seen.has(material)) continue;
      seen.add(material);
      material.dispose();
    }
  });
}

function studio(renderer: THREE.WebGLRenderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const scene = new THREE.Scene();
  scene.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(20, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader:
          "varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
        fragmentShader:
          "varying vec3 d; void main(){ float h = d.y * 0.5 + 0.5; gl_FragColor = vec4(vec3(mix(0.015, 0.5, h * h * h)), 1.0); }",
      }),
    ),
  );

  for (const panel of PANELS) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(panel.w, panel.h),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(
          panel.c[0],
          panel.c[1],
          panel.c[2],
        ).multiplyScalar(panel.i),
        side: THREE.DoubleSide,
      }),
    );

    mesh.position.set(panel.p[0], panel.p[1], panel.p[2]);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
  }

  const texture = pmrem.fromScene(scene, 0.03).texture;
  disposeTree(scene);
  pmrem.dispose();

  return texture;
}

export function Orb() {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = host.current;

    if (!container) return;

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let disposed = false;
    let frameId = 0;
    let onScreen = false;
    let pivot: THREE.Group | null = null;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const env = studio(renderer);
    scene.environment = env;

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    camera.position.set(0, 0, 6.2);

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 4, 3);
    scene.add(key);

    const resize = () => {
      const { width, height } = container.getBoundingClientRect();

      if (!width || !height) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    resize();
    const sizes = new ResizeObserver(resize);
    sizes.observe(container);

    const visibility = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? false;
    });

    visibility.observe(container);

    const target = { x: 0, y: 0 };
    const pointer = { x: 0, y: 0 };

    const onMove = (event: PointerEvent) => {
      target.x = (event.clientX / window.innerWidth) * 2 - 1;
      target.y = (event.clientY / window.innerHeight) * 2 - 1;
    };

    if (!reduced) window.addEventListener("pointermove", onMove);

    const started = performance.now();
    let shown = false;

    const frame = (now: number) => {
      frameId = requestAnimationFrame(frame);

      if (!onScreen || !pivot) return;

      if (reduced && shown) return;
      const t = reduced ? 0 : (now - started) / 1000;
      pointer.x += (target.x - pointer.x) * 0.06;
      pointer.y += (target.y - pointer.y) * 0.06;
      pivot.rotation.set(
        0.04 + pointer.y * 0.18 + Math.sin(t * 0.5) * 0.05,
        Math.sin(t * 0.35) * 0.28 + pointer.x * 0.3,
        Math.sin(t * 0.27) * 0.03,
      );
      pivot.position.y = Math.sin(t * 0.8) * 0.05;
      scene.environmentRotation.y = t * 0.12;
      renderer.render(scene, camera);

      if (!shown) {
        shown = true;
        setReady(true);
      }
    };

    frameId = requestAnimationFrame(frame);

    new GLTFLoader()
      .loadAsync("/model.glb")
      .then((gltf) => {
        if (disposed) {
          disposeTree(gltf.scene);

          return;
        }

        const material = new THREE.MeshPhysicalMaterial({
          color: new THREE.Color().setScalar(0.92),
          metalness: 1,
          roughness: 0.14,
          clearcoat: 1,
          clearcoatRoughness: 0.05,
        });

        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const scale = MODEL_SIZE / Math.max(size.x, size.y, size.z);
        model.scale.setScalar(scale);
        model.position.sub(center.multiplyScalar(scale));
        model.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          child.geometry.computeVertexNormals();

          const old = Array.isArray(child.material)
            ? child.material
            : [child.material];

          for (const entry of old) entry.dispose();
          child.material = material;
        });
        pivot = new THREE.Group();
        pivot.add(model);
        scene.add(pivot);
      })
      .catch((error: unknown) => {
        console.error("Omnyo model failed to load", error);
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      window.removeEventListener("pointermove", onMove);
      sizes.disconnect();
      visibility.disconnect();

      if (pivot) disposeTree(pivot);
      env.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div
      ref={host}
      className={ready ? "o2-orb o2-orb--ready" : "o2-orb"}
      aria-hidden="true"
    />
  );
}
