const NOISE_GLSL = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float valueNoise(vec2 p) {
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
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * valueNoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    amplitude *= 0.5;
  }
  return value;
}
`;

export const SKY_VERTEX = `
void main() {
  gl_Position = vec4(position.xy, 0.9999, 1.0);
}
`;

export const SKY_FRAGMENT = `
uniform vec2 uRes;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uTime;
uniform float uCorona;
uniform float uSun;
uniform float uHole;
uniform float uSunEdge;
${NOISE_GLSL}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 d = (frag - uCenter) / uRadius;
  float r = length(d);
  vec2 dir = d / max(r, 1e-4);
  float edge = max(r - 1.0, 0.0);
  vec2 sp = frag / uRes;
  float t = uTime;

  vec3 zenith = vec3(0.0015, 0.004, 0.012);
  vec3 horizon = vec3(0.006, 0.016, 0.042);
  vec3 col = mix(horizon, zenith, smoothstep(0.0, 0.85, sp.y));
  col += vec3(0.020, 0.040, 0.095) * exp(-edge * 1.1) * 0.55;

  float phi = atan(d.y, d.x) - 0.42;
  float lat = sin(phi);
  float eq = cos(phi);
  float flare = 1.0 + edge * 0.85;
  float bentPhi = phi + 0.5 * lat * eq * (1.0 - 1.0 / flare) * 2.0;
  vec2 bentDir = vec2(cos(bentPhi), sin(bentPhi));

  float helmets = 0.0;
  helmets += exp(-pow((sin((phi - 0.06) * 0.5)) / (0.15 / flare + 0.022), 2.0)) * exp(-edge * 0.78) * 1.0;
  helmets += exp(-pow((sin((phi - 3.24) * 0.5)) / (0.13 / flare + 0.02), 2.0)) * exp(-edge * 0.85) * 0.9;
  helmets += exp(-pow((sin((phi - 0.62) * 0.5)) / (0.09 / flare + 0.016), 2.0)) * exp(-edge * 1.05) * 0.55;
  helmets += exp(-pow((sin((phi - 2.55) * 0.5)) / (0.1 / flare + 0.016), 2.0)) * exp(-edge * 0.9) * 0.6;
  helmets += exp(-pow((sin((phi + 0.58) * 0.5)) / (0.08 / flare + 0.014), 2.0)) * exp(-edge * 1.3) * 0.45;
  helmets += exp(-pow((sin((phi - 3.85) * 0.5)) / (0.07 / flare + 0.014), 2.0)) * exp(-edge * 1.5) * 0.4;

  float lobes = fbm(bentDir * 2.2 + vec2(t * 0.004, -t * 0.003));
  float fineA = valueNoise(bentDir * 56.0 + vec2(edge * 0.45, 1.7));
  float fineB = valueNoise(bentDir * 128.0 + vec2(edge * 0.9, -3.1));
  float fineC = valueNoise(bentDir * 250.0 + vec2(edge * 1.6, 8.4));
  float filaments = pow(fineA, 1.7) * 0.7 + pow(fineB, 2.2) * 0.55 + pow(fineC, 2.6) * 0.4;
  float polar = pow(abs(lat), 3.0);
  float plumes = pow(valueNoise(bentDir * 130.0 + vec2(edge * 0.25, 0.0)), 2.6) * polar * exp(-edge * 3.4);

  float inner = exp(-edge * 34.0);
  float kcorona = exp(-edge * 6.2) * (0.34 + 0.66 * abs(eq)) * (0.7 + 0.6 * lobes);
  float middle = exp(-edge * 3.2) * (0.05 + 0.2 * eq * eq) * (0.5 + lobes);
  float streamers = helmets * (0.35 + filaments * 1.5);

  vec3 white = vec3(1.0, 1.0, 1.0);
  vec3 silver = vec3(0.84, 0.9, 1.0);
  vec3 ice = vec3(0.55, 0.72, 1.0);
  vec3 corona = white * inner * 1.7
    + silver * kcorona * (0.4 + filaments * 1.1) * 0.66
    + mix(silver, ice, smoothstep(0.0, 0.8, edge)) * middle * (0.4 + filaments * 1.2) * 0.42
    + mix(silver, ice, smoothstep(0.1, 1.4, edge)) * streamers * 0.52
    + mix(silver, white, 0.5) * plumes * 1.0;
  col += corona * uCorona * smoothstep(0.996, 1.006, r);

  col *= 1.0 - smoothstep(1.0, 0.994, r) * (1.0 - uSun);

  float limbX = (r - 1.004) / 0.0055;
  float limb = exp(-limbX * limbX);
  col += vec3(0.88, 0.94, 1.0) * limb * 0.55 * uCorona;

  float sunMask = smoothstep(uSunEdge, uSunEdge - 0.015, r) * smoothstep(uHole - 0.02, uHole + 0.05, r);
  if (sunMask > 0.0 && uSun > 0.0) {
    float granules = fbm(d * 16.0 + t * 0.04);
    vec3 sun = vec3(0.96, 0.98, 1.0) * (3.0 + granules * 0.9) * mix(1.0, 0.74, smoothstep(0.55, 1.0, r));
    col += sun * sunMask * uSun;
  }

  float cellSize = uRes.y * 0.0052;
  vec2 cell = floor(frag / cellSize);
  float seed = hash12(cell);
  float star = step(0.9972, seed) * (0.2 + 0.8 * pow(hash12(cell + 7.1), 2.4));
  vec2 local = fract(frag / cellSize) - 0.5;
  star *= smoothstep(0.26, 0.0, length(local));
  star *= 0.7 + 0.3 * sin(t * 1.1 + seed * 80.0);
  col += mix(vec3(0.72, 0.82, 1.0), vec3(1.0), hash12(cell + 3.3)) * star * 0.8 * smoothstep(1.6, 3.0, r);

  gl_FragColor = vec4(col, 1.0);
}
`;

export const LENS_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const LENS_FRAGMENT = `
uniform sampler2D tDiffuse;
uniform vec2 uRes;
uniform vec2 uBead;
uniform vec2 uDisc;
uniform float uDiscRadius;
uniform float uCrush;
uniform float uFlare;
uniform float uTime;
uniform float uGrain;
varying vec2 vUv;
${NOISE_GLSL}
float ghost(vec2 frag, vec2 at, float radius) {
  float dist = length(frag - at);
  float disc = smoothstep(radius, radius * 0.55, dist);
  float ring = exp(-pow((dist - radius) / (radius * 0.07), 2.0));
  return disc * 0.4 + ring * 0.7;
}
float bead(vec2 b, float s) {
  float bd = length(b) / s;
  float glow = exp(-bd * 120.0) * 1.9 + exp(-bd * 30.0) * 0.26 + exp(-bd * 7.0) * 0.03;
  float angle = atan(b.y, b.x);
  float spikes = pow(abs(cos(angle * 2.0 + 0.785)), 90.0) * exp(-bd * 16.0) * 0.6;
  float spikes2 = pow(abs(cos(angle * 3.0 + 0.3)), 140.0) * exp(-bd * 30.0) * 0.25;
  return glow + spikes + spikes2;
}
void main() {
  vec3 col = texture2D(tDiffuse, vUv).rgb;
  vec2 frag = vUv * uRes;
  float s = uDiscRadius * 4.8;

  float rd = length(frag - uDisc) / max(uDiscRadius, 1.0);
  float inside = smoothstep(0.992, 0.962, rd) * uCrush;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float keep = smoothstep(0.006, 0.07, lum);
  col = mix(col, col * keep * mix(vec3(1.0), vec3(0.86, 0.94, 1.08), 1.0 - keep), inside);

  vec2 b = frag - uBead;
  vec2 radial = normalize(uBead - uDisc + 1e-4);
  float ax = abs(b.x) / s;
  float ay = abs(b.y) / s;
  float bd = length(b) / s;

  vec3 prism = vec3(
    bead(b * 0.955, s),
    bead(b, s),
    bead(b * 1.05, s)
  );
  float streak = exp(-ay * 260.0) * exp(-ax * 1.25);
  float streakCore = exp(-ay * 1200.0) * exp(-ax * 3.6);
  vec3 flare = prism * vec3(0.97, 0.99, 1.0)
    + vec3(0.42, 0.66, 1.0) * streak * 0.55
    + vec3(0.88, 0.95, 1.0) * streakCore * 0.95;

  vec3 rainbow = vec3(
    exp(-pow((bd - 0.0545) / 0.0042, 2.0)),
    exp(-pow((bd - 0.0505) / 0.0042, 2.0)),
    exp(-pow((bd - 0.0465) / 0.0042, 2.0))
  );
  float side = 0.55 + 0.45 * dot(normalize(b + 1e-4), radial);
  flare += rainbow * 0.14 * side;

  vec2 axis = uDisc - uBead;
  flare += vec3(0.45, 0.85, 1.0) * ghost(frag, uBead - axis * 0.55, s * 0.013) * 0.08;
  flare += vec3(0.74, 0.70, 1.0) * ghost(frag, uBead - axis * 0.98, s * 0.03) * 0.045;
  flare += vec3(0.55, 0.78, 1.0) * ghost(frag, uBead - axis * 1.62, s * 0.058) * 0.024;
  flare += vec3(1.0, 0.86, 0.95) * ghost(frag, uBead - axis * 1.9, s * 0.009) * 0.05;

  col += flare * uFlare;

  vec2 q = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  col *= mix(0.6, 1.0, smoothstep(1.05, 0.3, length(q)));
  col = max(col, vec3(0.0));
  col += (hash12(frag + fract(uTime * 7.3) * 431.0) - 0.5) * uGrain;
  gl_FragColor = vec4(col, 1.0);
}
`;

export const RIM_HEADER = `
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform vec2 uBeadDir;
uniform float uShine;
`;

export const RIM_CHUNK = `
#include <emissivemap_fragment>
float rimFacing = 1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0);
float rimMask = pow(rimFacing, 4.0);
vec2 rimPlane = normal.xy / max(length(normal.xy), 1e-4);
float rimBias = 0.35 + 0.65 * clamp(dot(rimPlane, uBeadDir) * 0.5 + 0.5, 0.0, 1.0);
totalEmissiveRadiance += uRimColor * rimMask * uRimStrength * rimBias;
float shineFace = smoothstep(0.55, 0.95, abs(normal.z));
float shineBand = clamp(dot(diffuseColor.rgb, vec3(0.3333)) / 0.3, 0.0, 1.0);
vec2 shineUv = vMapUv - 0.5;
float shineSide = 0.55 + 0.45 * clamp(dot(normalize(shineUv + 1e-4), uBeadDir), -1.0, 1.0);
totalEmissiveRadiance += vec3(0.52, 0.66, 1.0) * pow(shineBand, 2.2) * shineFace * shineSide * uShine;
`;
