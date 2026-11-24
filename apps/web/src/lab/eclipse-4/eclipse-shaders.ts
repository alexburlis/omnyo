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

  vec3 col = mix(vec3(0.010, 0.012, 0.022), vec3(0.003, 0.004, 0.009), sp.y);
  col += vec3(0.32, 0.14, 0.05) * exp(-edge * 1.1) * 0.09;
  col += vec3(0.05, 0.09, 0.16) * exp(-edge * 0.3) * 0.08;

  float streamA = fbm(dir * 2.4 + vec2(edge * 0.32 - t * 0.012, t * 0.008));
  float streamB = fbm(dir * 6.5 + vec2(-edge * 0.55, t * 0.018));
  float streamers = pow(streamA, 1.5) * 1.5 + streamB * 0.45;
  float rays = pow(fbm(dir * 13.0 + vec2(t * 0.004, -t * 0.003)), 3.2);

  float inner = exp(-edge * 16.0);
  float mid = exp(-edge * 3.4) * (0.15 + streamers);
  float outer = exp(-edge * 1.15) * streamers * 0.2;
  float shafts = exp(-edge * 0.55) * rays * 0.16;

  vec3 pearl = vec3(1.0, 0.95, 0.87);
  vec3 amber = vec3(1.0, 0.60, 0.27);
  vec3 ember = vec3(0.86, 0.30, 0.11);
  vec3 corona = pearl * inner * 2.2
    + mix(amber, pearl, 0.4) * mid * 0.62
    + ember * outer
    + amber * shafts * 0.7;
  col += corona * uCorona * smoothstep(0.996, 1.004, r);

  float chromo = exp(-pow((r - 1.012) / 0.012, 2.0)) * (0.5 + 0.9 * valueNoise(dir * 34.0 + t * 0.06));
  col += vec3(1.0, 0.26, 0.36) * chromo * 1.4 * uCorona;

  float sunMask = smoothstep(uSunEdge, uSunEdge - 0.015, r) * smoothstep(uHole - 0.02, uHole + 0.05, r);
  if (sunMask > 0.0) {
    float granules = fbm(d * 16.0 + t * 0.04);
    vec3 sun = vec3(1.0, 0.84, 0.62) * (3.0 + granules * 0.9) * mix(1.0, 0.72, smoothstep(0.55, 1.0, r));
    col += sun * sunMask * uSun;
  }

  float holeMask = smoothstep(uHole + 0.05, uHole - 0.02, r);
  vec3 holeGlow = mix(vec3(0.05, 0.02, 0.01), vec3(1.0, 0.6, 0.3), smoothstep(uHole * 0.45, uHole, r));
  col += holeGlow * holeMask * 0.16 * uCorona;

  float cellSize = uRes.y * 0.0058;
  vec2 cell = floor(frag / cellSize);
  float seed = hash12(cell);
  float star = step(0.9975, seed) * (0.25 + 0.75 * pow(hash12(cell + 7.1), 2.0));
  vec2 local = fract(frag / cellSize) - 0.5;
  star *= smoothstep(0.26, 0.0, length(local));
  star *= 0.65 + 0.35 * sin(t * 1.3 + seed * 80.0);
  col += vec3(0.82, 0.88, 1.0) * star * 0.75 * smoothstep(1.7, 3.2, r);

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
  float ring = exp(-pow((dist - radius) / (radius * 0.08), 2.0));
  return disc * 0.5 + ring * 0.6;
}
void main() {
  vec3 col = texture2D(tDiffuse, vUv).rgb;
  vec2 frag = vUv * uRes;
  float s = uRes.y;

  vec2 fromDisc = frag - uDisc;
  float rd = length(fromDisc) / max(uDiscRadius, 1.0);
  float aa = 1.5 / max(uDiscRadius, 1.0);
  float inside = smoothstep(1.0 + aa, 1.0 - aa, rd) * uCrush;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float limb = smoothstep(0.7, 0.9, rd);
  float keep = smoothstep(mix(0.13, 0.5, limb), mix(0.72, 1.2, limb), lum);
  float bevel = 1.0 - smoothstep(0.86, 0.955, rd);
  col = mix(col, col * keep * bevel * mix(vec3(1.0), vec3(1.05, 0.96, 0.86), 1.0 - keep), inside);
  vec2 rimDir = fromDisc / max(length(fromDisc), 1e-4);
  vec2 beadDir = normalize(uBead - uDisc + vec2(1e-4));
  float facing = dot(rimDir, beadDir) * 0.5 + 0.5;
  float rimWidth = max(0.0035, 1.1 / max(uDiscRadius, 1.0));
  float rimLine = exp(-pow((rd - (1.0 - rimWidth * 1.6)) / rimWidth, 2.0));
  float rimInner = exp(-pow((rd - 0.952) / (rimWidth * 1.4), 2.0));
  float rimLight = 0.1 + 1.6 * pow(facing, 4.0);
  col += vec3(1.0, 0.8, 0.55) * rimLine * rimLight * uCrush;
  col += vec3(1.0, 0.72, 0.42) * rimInner * (0.04 + 0.5 * pow(facing, 6.0)) * uCrush;
  vec2 b = frag - uBead;
  float ax = abs(b.x) / s;
  float ay = abs(b.y) / s;
  float bd = length(b) / s;

  float streak = exp(-ay * 240.0) * exp(-ax * 1.3);
  float streakCore = exp(-ay * 1100.0) * exp(-ax * 4.0);
  float glow = exp(-bd * 140.0) * 1.4 + exp(-bd * 32.0) * 0.2 + exp(-bd * 8.0) * 0.025;
  float angle = atan(b.y, b.x);
  float spikes = pow(abs(cos(angle * 2.0 + 0.785)), 80.0) * exp(-bd * 18.0) * 0.55;
  vec3 flare = vec3(0.40, 0.68, 1.0) * streak * 0.5
    + vec3(0.86, 0.95, 1.0) * streakCore * 0.9
    + vec3(1.0, 0.97, 0.92) * (glow + spikes);

  vec2 axis = uDisc - uBead;
  flare += vec3(0.45, 0.9, 0.75) * ghost(frag, uBead - axis * 0.55, s * 0.014) * 0.09;
  flare += vec3(0.95, 0.55, 0.25) * ghost(frag, uBead - axis * 0.95, s * 0.032) * 0.05;
  flare += vec3(0.55, 0.45, 1.0) * ghost(frag, uBead - axis * 1.6, s * 0.06) * 0.025;

  col += flare * uFlare;

  vec2 q = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  col *= mix(0.62, 1.0, smoothstep(1.05, 0.32, length(q)));
  col += (hash12(frag + fract(uTime * 7.3) * 431.0) - 0.5) * uGrain;
  gl_FragColor = vec4(col, 1.0);
}
`;

export const RIM_HEADER = `
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform vec2 uBeadDir;
`;

export const RIM_CHUNK = `
#include <emissivemap_fragment>
float rimFacing = 1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0);
float rimMask = pow(rimFacing, 5.0);
vec2 rimPlane = normal.xy / max(length(normal.xy), 1e-4);
float rimBias = 0.45 + 0.55 * clamp(dot(rimPlane, uBeadDir) * 0.5 + 0.5, 0.0, 1.0);
totalEmissiveRadiance += uRimColor * rimMask * uRimStrength * rimBias;
`;
