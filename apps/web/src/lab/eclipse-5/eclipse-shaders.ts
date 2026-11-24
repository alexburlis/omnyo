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
uniform vec2 uSun;
uniform float uSunR;
uniform vec2 uMoon;
uniform float uMoonR;
uniform float uTime;
uniform float uDark;
uniform float uFilter;
uniform float uCorona;
uniform float uStars;
uniform float uHorizon;
uniform float uExposure;
uniform float uRidge;
${NOISE_GLSL}
float spot(vec2 p, vec2 at, float size) {
  float d = length(p - at) / size;
  return smoothstep(1.0, 0.45, d) * 0.55 + smoothstep(0.45, 0.2, d) * 0.4;
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 sp = frag / uRes;
  float aspect = uRes.x / uRes.y;
  float t = uTime;

  vec3 dayLow = vec3(0.075, 0.052, 0.095);
  vec3 dayMid = vec3(0.028, 0.06, 0.15);
  vec3 dayTop = vec3(0.007, 0.018, 0.06);
  vec3 day = mix(dayLow, dayMid, smoothstep(0.0, 0.42, sp.y));
  day = mix(day, dayTop, smoothstep(0.42, 1.0, sp.y));
  vec3 night = mix(vec3(0.006, 0.007, 0.016), vec3(0.0012, 0.0016, 0.0045), smoothstep(0.0, 0.75, sp.y));
  vec3 col = mix(day, night, uDark);

  vec3 sunset = vec3(0.95, 0.36, 0.1) * exp(-sp.y * 15.0) + vec3(0.32, 0.1, 0.22) * exp(-sp.y * 4.5) * 0.45;
  col += sunset * uHorizon * 0.5;

  vec2 ds = frag - uSun;
  float rs = length(ds) / uSunR;
  vec2 dir = ds / max(length(ds), 1e-3);
  float edge = max(rs - 1.0, 0.0);

  vec2 dm = frag - uMoon;
  float dmLength = length(dm);
  float rm = dmLength / uMoonR;
  float limbAngle = atan(dm.y, dm.x);
  float limb = uMoonR * (1.0 + 0.0042 * (valueNoise(vec2(limbAngle * 26.0, 1.3)) - 0.5) + 0.0026 * (valueNoise(vec2(limbAngle * 71.0, 4.1)) - 0.5));
  float body = clamp((limb - dmLength) / 1.1 + 0.5, 0.0, 1.0);
  float clear = 1.0 - body;

  vec3 aureCol = mix(vec3(1.0, 0.82, 0.62), vec3(1.0, 0.5, 0.18), uFilter);
  float aureole = exp(-edge * 1.35) * 0.09 + exp(-edge * 5.5) * 0.2;
  col += aureCol * aureole * uExposure * mix(1.0, 0.45, uDark) * clear;

  float cellSize = uRes.y * 0.0058;
  vec2 cell = floor(frag / cellSize);
  float seed = hash12(cell);
  float star = step(0.9972, seed) * (0.25 + 0.75 * pow(hash12(cell + 7.1), 2.0));
  vec2 local = fract(frag / cellSize) - 0.5;
  star *= smoothstep(0.26, 0.0, length(local));
  star *= 0.65 + 0.35 * sin(t * 1.3 + seed * 80.0);
  col += vec3(0.82, 0.88, 1.0) * star * 0.8 * smoothstep(1.8, 3.4, rs) * uStars * smoothstep(0.12, 0.3, sp.y);

  vec2 planet = vec2(0.2 * aspect, 0.8);
  float pd = length(sp * vec2(aspect, 1.0) - planet) * uRes.y;
  col += vec3(1.0, 0.96, 0.88) * (exp(-pd * 0.9) * 2.2 + exp(-pd * 0.12) * 0.05) * smoothstep(0.86, 0.99, uStars);

  float streamA = fbm(dir * 2.4 + vec2(edge * 0.32 - t * 0.012, t * 0.008));
  float streamB = fbm(dir * 6.5 + vec2(-edge * 0.55, t * 0.018));
  float streamers = pow(streamA, 1.5) * 1.5 + streamB * 0.45;
  float rays = pow(fbm(dir * 13.0 + vec2(t * 0.004, -t * 0.003)), 3.2);
  float poles = 0.7 + 0.3 * abs(dir.x);
  float inner = exp(-edge * 14.0);
  float mid = exp(-edge * 3.2) * (0.15 + streamers) * poles;
  float outer = exp(-edge * 1.05) * streamers * 0.22 * poles;
  float shafts = exp(-edge * 0.5) * rays * 0.18;
  vec3 pearl = vec3(1.0, 0.97, 0.93);
  vec3 cream = vec3(1.0, 0.86, 0.66);
  vec3 ember = vec3(0.72, 0.36, 0.2);
  vec3 corona = pearl * inner * 2.6
    + mix(cream, pearl, 0.5) * mid * 0.7
    + ember * outer
    + cream * shafts * 0.8;
  col += corona * uCorona * clear * smoothstep(0.99, 1.0, rs);

  float angle = atan(dir.y, dir.x);
  float height = 0.012 + 0.07 * pow(valueNoise(vec2(angle * 4.0, 3.7) + t * 0.01), 3.5);
  float prom = smoothstep(0.995, 1.012, rs) * smoothstep(1.0 + height, 1.0 + height * 0.35, rs);
  prom *= 0.55 + 0.45 * valueNoise(vec2(angle * 40.0, rs * 30.0 - t * 0.08));
  col += vec3(1.0, 0.2, 0.32) * prom * 2.4 * uCorona * clear;

  float disc = clamp((uSunR - length(ds)) / 1.4 + 0.5, 0.0, 1.0);
  if (disc > 0.0) {
    vec2 p = ds / uSunR;
    float mu = sqrt(max(1.0 - dot(p, p), 0.0));
    float gran = fbm(p * 24.0 + vec2(t * 0.03, -t * 0.02));
    float plage = fbm(p * 5.0 + 3.1);
    vec3 filtered = mix(vec3(0.42, 0.045, 0.004), vec3(1.0, 0.4, 0.05), pow(mu, 0.5));
    filtered *= (0.42 + 0.78 * pow(mu, 0.7)) * (0.86 + gran * 0.3 + smoothstep(0.55, 0.8, plage) * 0.18);
    float spots = spot(p, vec2(0.34, -0.22), 0.06) + spot(p, vec2(0.43, -0.18), 0.035) + spot(p, vec2(-0.3, 0.36), 0.045);
    filtered *= 1.0 - clamp(spots, 0.0, 0.92);
    filtered *= 0.95;
    vec3 white = vec3(1.0, 0.95, 0.88) * (0.6 + 0.4 * mu) * 10.0;
    vec3 sunCol = mix(white, filtered, uFilter);
    col = mix(col, sunCol, disc * clear);
  }

  vec3 moon = vec3(0.004, 0.0045, 0.008) + vec3(0.03, 0.016, 0.008) * smoothstep(0.15, 0.62, rm) * smoothstep(0.75, 0.55, rm) * (0.4 + 0.6 * uCorona);
  col = mix(col, moon, body);

  float x = sp.x * aspect;
  float ridge = uRidge * (0.62 + 0.55 * fbm(vec2(x * 1.6, 2.3)) + 0.22 * fbm(vec2(x * 7.0, 8.1)));
  float px = 1.0 / uRes.y;
  float land = smoothstep(ridge + px, ridge - px, sp.y);
  float lip = exp(-max(sp.y - ridge, 0.0) / (uRidge * 0.5));
  col += vec3(0.9, 0.42, 0.16) * lip * uHorizon * 0.12 * (1.0 - land);
  vec3 ground = mix(vec3(0.006, 0.009, 0.022), vec3(0.0015, 0.0015, 0.003), uDark);
  ground += vec3(0.04, 0.018, 0.01) * uHorizon * smoothstep(ridge - 0.04, ridge, sp.y);
  col = mix(col, ground, land);

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
uniform float uStreak;
uniform float uGlow;
uniform float uWarm;
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

  vec2 b = frag - uBead;
  float ax = abs(b.x) / s;
  float ay = abs(b.y) / s;
  float bd = length(b) / s;

  vec3 streakTint = mix(vec3(0.4, 0.68, 1.0), vec3(1.0, 0.55, 0.22), uWarm);
  vec3 coreTint = mix(vec3(0.86, 0.95, 1.0), vec3(1.0, 0.82, 0.6), uWarm);
  float streak = exp(-ay * 240.0) * exp(-ax * 1.3);
  float streakCore = exp(-ay * 1100.0) * exp(-ax * 4.0);
  vec3 flare = streakTint * streak * 0.5 + coreTint * streakCore * 0.9;
  flare *= uStreak;

  float glow = exp(-bd * 110.0) * 1.8 + exp(-bd * 26.0) * 0.32 + exp(-bd * 7.0) * 0.035;
  float angle = atan(b.y, b.x);
  float spikes = pow(abs(cos(angle * 2.0 + 0.785)), 90.0) * exp(-bd * 11.0) * 0.7;
  vec3 point = vec3(1.0, 0.97, 0.92) * (glow + spikes);
  vec2 axis = uRes * 0.5 - uBead;
  point += vec3(0.45, 0.9, 0.75) * ghost(frag, uBead + axis * 0.7, s * 0.014) * 0.05;
  point += vec3(0.95, 0.55, 0.25) * ghost(frag, uBead + axis * 1.25, s * 0.032) * 0.025;
  point += vec3(0.55, 0.45, 1.0) * ghost(frag, uBead + axis * 1.75, s * 0.06) * 0.014;
  flare += point * uGlow;

  col += flare;

  vec2 q = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  col *= mix(0.7, 1.0, smoothstep(1.1, 0.35, length(q)));
  col += (hash12(frag + fract(uTime * 7.3) * 431.0) - 0.5) * uGrain;
  gl_FragColor = vec4(col, 1.0);
}
`;

export const RIM_HEADER = `
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform vec2 uSunDir;
uniform float uRimSpread;
uniform vec2 uCenter;
uniform float uRadius;
`;

export const RIM_CHUNK = `
#include <emissivemap_fragment>
vec2 rimSpot = (-vViewPosition.xy - uCenter) / max(uRadius, 1e-4);
float rimRadial = length(rimSpot);
float rimFacing = 1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0);
float rimMask = pow(rimFacing, 4.5) * mix(0.18, 1.0, smoothstep(0.84, 0.97, rimRadial));
vec2 rimPlane = normal.xy / max(length(normal.xy), 1e-4);
float rimToward = clamp(dot(rimPlane, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
float rimBias = mix(0.12 + 0.88 * pow(rimToward, 2.0), 0.55 + 0.45 * rimToward, uRimSpread);
totalEmissiveRadiance += uRimColor * rimMask * uRimStrength * rimBias;
`;
