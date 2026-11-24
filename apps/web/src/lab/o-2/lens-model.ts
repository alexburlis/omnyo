import * as THREE from "three";

import meshUrl from "./lens-o-mesh.bin?url";
import { decodeLensMesh } from "./lens-mesh";

export const MODEL_SIZE = 2.5;

const LENS_OVERLAP = 0.05;

const LENS_RIM = 0.035;

const LENS_BULGE = 0.16;

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
  vec3 low = vec3(0.16, 0.16, 0.17);
  vec3 mid = vec3(0.42, 0.42, 0.43);
  vec3 high = vec3(0.7, 0.7, 0.71);
  vec3 color = mix(low, mid, smoothstep(0.3, 0.55, h));
  color = mix(color, high, smoothstep(0.6, 1.0, h));
  gl_FragColor = vec4(color, 1.0);
}
`;

const STUDIO_PANELS = [
  { size: [22, 5], color: [6.5, 6.5, 6.6], position: [0, 11, 2] },
  { size: [2.4, 16], color: [5.2, 5.6, 6.6], position: [-8, 1, 4] },
  { size: [1.6, 16], color: [6.6, 6, 5.3], position: [8.5, 1, 2] },
  { size: [7, 12], color: [2.2, 2.2, 2.2], position: [3, 0, 10] },
  { size: [0.9, 16], color: [9, 9, 9], position: [-2.6, 1.5, 9] },
  { size: [2.4, 16], color: [0.05, 0.05, 0.06], position: [-6.2, 0, 8] },
  { size: [2, 16], color: [0.05, 0.05, 0.06], position: [6.4, 0, 7] },
  { size: [22, 3.5], color: [0.03, 0.03, 0.035], position: [0, -6.5, 6] },
] as const;

export function disposeObject(object: THREE.Object3D) {
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
      const textured = material as THREE.MeshBasicMaterial;
      textured.map?.dispose();
      material.dispose();
    }
  });
}

export function createEnvironment(renderer: THREE.WebGLRenderer) {
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
      new THREE.PlaneGeometry(panel.size[0], panel.size[1]),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(panel.color[0], panel.color[1], panel.color[2]),
        side: THREE.DoubleSide,
      }),
    );

    mesh.position.set(panel.position[0], panel.position[1], panel.position[2]);
    mesh.lookAt(0, 0, 0);
    studio.add(mesh);
  }

  const texture = pmrem.fromScene(studio, 0.012).texture;
  disposeObject(studio);
  pmrem.dispose();

  return texture;
}

export function createChrome() {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0.97, 0.972, 0.98),
    metalness: 1,
    roughness: 0.14,
    clearcoat: 0.5,
    clearcoatRoughness: 0.1,
    envMapIntensity: 1.2,
  });
}

export function createGlass() {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.02,
    transmission: 1,
    thickness: 0.7,
    ior: 1.5,
    dispersion: 0.3,
    attenuationColor: new THREE.Color(0.95, 0.97, 1),
    attenuationDistance: 6,
    specularIntensity: 0.1,
    envMapIntensity: 0.25,
  });
}

function createLensGeometry(radius: number) {
  const height = (r: number) => LENS_RIM + LENS_BULGE * (1 - (r / radius) ** 2);
  const profile: THREE.Vector2[] = [];
  const steps = 48;

  for (let i = 0; i <= steps; i++) {
    const r = radius * Math.sin(((i / steps) * Math.PI) / 2);
    profile.push(new THREE.Vector2(r, -height(r)));
  }

  for (let i = steps; i >= 0; i--) {
    const r = radius * Math.sin(((i / steps) * Math.PI) / 2);
    profile.push(new THREE.Vector2(r, height(r)));
  }

  const geometry = new THREE.LatheGeometry(profile, 160);
  geometry.rotateX(Math.PI / 2);

  return geometry;
}

async function fetchMesh(signal: AbortSignal) {
  const response = await fetch(meshUrl, { signal });

  if (!response.ok) {
    throw new Error(`The model mesh failed to load (${response.status})`);
  }

  return decodeLensMesh(await response.arrayBuffer());
}

export async function loadLensModel({
  chrome,
  glass,
  signal,
}: {
  chrome: THREE.Material;
  glass: THREE.Material | null;
  signal: AbortSignal;
}) {
  const treated = await fetchMesh(signal);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(treated.positions, 3),
  );
  geometry.setAttribute(
    "normal",
    new THREE.BufferAttribute(treated.normals, 3),
  );
  geometry.setIndex(new THREE.BufferAttribute(treated.index, 1));
  geometry.computeBoundingSphere();

  const mark = new THREE.Group();
  mark.add(new THREE.Mesh(geometry, chrome));

  if (glass) {
    mark.add(
      new THREE.Mesh(
        createLensGeometry(treated.innerRadius + LENS_OVERLAP),
        glass,
      ),
    );
  }

  mark.scale.setScalar(MODEL_SIZE / 2);

  const pivot = new THREE.Group();
  pivot.add(mark);

  return pivot;
}
