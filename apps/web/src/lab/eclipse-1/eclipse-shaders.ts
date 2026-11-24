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
uniform float uSunRadius;
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
  float t = uTime;

  vec3 col = vec3(0.0);

  float broad = fbm(dir * 3.1 + vec2(t * 0.006, -t * 0.004));
  float fine = fbm(dir * 11.0 + vec2(-t * 0.003, t * 0.004));
  float hair = valueNoise(dir * 46.0 + vec2(t * 0.01, 0.0));
  float rays = 0.55 + 0.75 * pow(broad, 1.6) + 0.35 * pow(fine, 2.0) + 0.12 * hair;

  vec2 squash = d * vec2(0.86, 1.18);
  float er = max(length(squash) - 1.0, 0.0);

  float inner = exp(-edge * 34.0);
  float mid = exp(-edge * 5.2) * rays;
  float outer = exp(-er * 1.9) * pow(broad, 2.2) * 0.9;
  float veil = exp(-er * 1.6) * 0.03;

  vec3 pearl = vec3(1.0, 0.97, 0.93);
  vec3 warm = vec3(1.0, 0.82, 0.6);
  vec3 corona = pearl * inner * 1.45
    + mix(warm, pearl, 0.6) * mid * 0.36
    + warm * outer * 0.14
    + warm * veil;
  col += corona * uCorona * smoothstep(0.995, 1.0, r);

  float sr = length(frag - uCenter) / uSunRadius;
  float sunMask = smoothstep(uSunEdge, uSunEdge - 0.01, sr) * smoothstep(uHole - 0.02, uHole + 0.04, sr);
  if (sunMask > 0.0) {
    float granules = fbm(d * 18.0 + t * 0.04);
    vec3 sun = vec3(1.0, 0.9, 0.76) * (3.2 + granules * 0.6) * mix(1.0, 0.78, smoothstep(0.55, 1.0, sr));
    col += sun * sunMask * uSun;
  }
  float sunGlow = exp(-max(sr - 1.0, 0.0) * 9.0) * step(1.0, sr);
  col += vec3(1.0, 0.86, 0.68) * sunGlow * 0.7 * uSun;

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
void main() {
  vec3 col = texture2D(tDiffuse, vUv).rgb;
  vec2 frag = vUv * uRes;
  float s = uRes.y;

  float px = 1.0 / max(uDiscRadius, 1.0);
  float rd = length(frag - uDisc) * px;
  float inside = smoothstep(1.0 - px * 1.5, 1.0 - px * 5.0, rd) * uCrush;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec2 toBead = uBead - uDisc;
  float facing = dot((frag - uDisc) / max(rd * uDiscRadius, 1.0), toBead / max(length(toBead), 1.0));
  float floorLum = mix(0.9, 0.3, smoothstep(-0.35, 0.9, facing));
  float keep = smoothstep(floorLum, 0.99, lum);
  col = mix(col, col * keep, inside);

  vec2 b = frag - uBead;
  float ax = abs(b.x) / s;
  float ay = abs(b.y) / s;
  float bd = length(b) / s;

  float streak = exp(-ay * 420.0) * exp(-ax * 1.6);
  float streakCore = exp(-ay * 1500.0) * exp(-ax * 5.0);
  float glow = exp(-bd * 170.0) * 1.5 + exp(-bd * 40.0) * 0.16 + exp(-bd * 9.0) * 0.018;
  vec3 flare = vec3(0.72, 0.84, 1.0) * streak * 0.32
    + vec3(0.95, 0.98, 1.0) * streakCore * 0.8
    + vec3(1.0, 0.98, 0.95) * glow;

  col += flare * uFlare;

  vec2 q = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  col *= mix(0.78, 1.0, smoothstep(1.1, 0.35, length(q)));
  col += (hash12(frag + fract(uTime * 7.3) * 431.0) - 0.5) * uGrain;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
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
float rimMask = pow(rimFacing, 9.0);
vec2 rimPlane = normal.xy / max(length(normal.xy), 1e-4);
float rimBias = 0.45 + 0.55 * clamp(dot(rimPlane, uBeadDir) * 0.5 + 0.5, 0.0, 1.0);
totalEmissiveRadiance += uRimColor * rimMask * uRimStrength * rimBias;
`;
