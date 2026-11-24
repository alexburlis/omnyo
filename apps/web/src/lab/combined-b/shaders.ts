export const WINDOW_COUNT = 7;

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

export const QUAD_VERTEX = `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const SKY_FRAGMENT = `
uniform vec2 uRes;
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uBot;
uniform vec2 uSun;
uniform float uSunR;
uniform vec2 uMoon;
uniform float uMoonR;
uniform float uMoonOn;
uniform float uNight;
uniform float uVisible;
uniform float uCorona;
uniform float uStars;
uniform float uTime;
uniform float uGrain;
${NOISE_GLSL}
vec3 lightUp(vec3 base, vec3 light) {
  return base + (1.0 - base) * (vec3(1.0) - exp(-light));
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  float t = uTime;
  float y = 1.0 - frag.y / uRes.y;
  vec3 col = mix(uTop, uMid, smoothstep(0.0, 0.58, y));
  col = mix(col, uBot, smoothstep(0.42, 1.0, y));

  vec2 ds = (frag - uSun) / uSunR;
  float rs = length(ds);
  vec2 dm = (frag - uMoon) / uMoonR;
  float rm = length(dm);
  float aaS = 1.3 / uSunR;
  float grow = mix(0.32, 1.0, uMoonOn);
  float rmG = rm / grow;
  float aaM = 1.3 / (uMoonR * grow);
  float sunDisc = smoothstep(1.0 + aaS, 1.0 - aaS, rs);
  float moonDisc = smoothstep(1.0 + aaM, 1.0 - aaM, rmG) * smoothstep(0.0, 0.12, uMoonOn);
  float day = 1.0 - uNight;
  vec3 light = vec3(0.0);

  float outS = max(rs - 1.0, 0.0);
  float glow = uVisible * (0.4 * exp(-outS * 3.6) + 0.14 * exp(-outS * 1.1));
  col = mix(col, vec3(1.0, 0.69, 0.44), glow * day * (1.0 - sunDisc));
  light += vec3(1.0, 0.58, 0.28) * glow * uNight * 0.7 * (1.0 - sunDisc);

  float limb = smoothstep(0.02, 1.0, rs * rs * rs);
  vec3 dayCol = mix(vec3(1.0, 0.95, 0.82), vec3(1.0, 0.55, 0.2), limb);
  vec3 nightCol = mix(vec3(1.0, 0.99, 0.96), vec3(1.0, 0.83, 0.6), smoothstep(0.35, 1.0, rs * rs));
  vec3 sunCol = mix(dayCol, nightCol, smoothstep(0.25, 0.85, uNight));
  sunCol *= 0.955 + 0.09 * fbm(ds * 7.0 + vec2(t * 0.03, -t * 0.02));
  sunCol = mix(sunCol, vec3(1.0, 0.33, 0.1), smoothstep(0.86, 1.0, rs) * 0.5 * day);
  col = mix(col, sunCol, sunDisc * (1.0 - moonDisc));

  vec2 toSun = uSun - uMoon;
  vec2 sunDir = toSun / max(length(toSun), 1e-3);
  float facing = clamp(dot(dm / max(rm, 1e-4), sunDir) * 0.5 + 0.5, 0.0, 1.0);
  vec3 moonCol = mix(vec3(0.045, 0.04, 0.045), vec3(0.016, 0.015, 0.02), smoothstep(0.2, 0.9, uNight));
  moonCol += vec3(0.07, 0.045, 0.03) * pow(facing, 3.0) * smoothstep(0.55, 1.0, rmG) * day;
  col = mix(col, moonCol, moonDisc);
  float edgeLine = exp(-pow((rmG - 0.994) / (1.5 / (uMoonR * grow)), 2.0)) * smoothstep(0.0, 0.12, uMoonOn);
  col = mix(col, vec3(1.0, 0.8, 0.58), edgeLine * pow(facing, 2.5) * 0.85 * (1.0 - uCorona));

  if (uCorona > 0.002) {
    vec2 dir = dm / max(rm, 1e-4);
    float edge = max(rm - 1.0, 0.0);
    float streamA = fbm(dir * 2.4 + vec2(edge * 0.32 - t * 0.012, t * 0.008));
    float streamB = fbm(dir * 6.5 + vec2(-edge * 0.55, t * 0.018));
    float streamers = pow(streamA, 1.5) * 1.5 + streamB * 0.45;
    float rays = pow(fbm(dir * 13.0 + vec2(t * 0.004, -t * 0.003)), 3.2);
    float inner = exp(-edge * 15.0);
    float mid = exp(-edge * 3.2) * (0.15 + streamers);
    float outer = exp(-edge * 1.1) * streamers * 0.22;
    float shafts = exp(-edge * 0.5) * rays * 0.18;
    vec3 pearl = vec3(1.0, 0.95, 0.87);
    vec3 amber = vec3(1.0, 0.6, 0.27);
    vec3 ember = vec3(0.86, 0.3, 0.11);
    vec3 corona = pearl * inner * 2.4
      + mix(amber, pearl, 0.4) * mid * 0.66
      + ember * outer
      + amber * shafts * 0.8;
    float outside = smoothstep(0.996, 1.004, rm);
    light += corona * uCorona * outside;
    light += vec3(0.42, 0.18, 0.07) * exp(-edge * 0.9) * 0.16 * uCorona * outside;
    float chromo = exp(-pow((rm - 1.012) / 0.012, 2.0)) * (0.5 + 0.9 * valueNoise(dir * 34.0 + t * 0.06));
    light += vec3(1.0, 0.3, 0.38) * chromo * 1.1 * uCorona;
    float limbLine = exp(-pow((rm - 0.996) / (1.7 / uMoonR), 2.0));
    light += vec3(1.0, 0.84, 0.62) * limbLine * 0.55 * uCorona;
  }

  if (uStars > 0.002) {
    float cellSize = uRes.y * 0.0058;
    vec2 cell = floor(frag / cellSize);
    float seed = hash12(cell);
    float star = step(0.9972, seed) * (0.25 + 0.75 * pow(hash12(cell + 7.1), 2.0));
    vec2 local = fract(frag / cellSize) - 0.5;
    star *= smoothstep(0.26, 0.0, length(local));
    star *= 0.65 + 0.35 * sin(t * 1.3 + seed * 80.0);
    light += vec3(0.82, 0.88, 1.0) * star * 0.9 * uStars * smoothstep(1.5, 3.0, rm);
  }

  col = lightUp(col, light);
  col += (hash12(frag + fract(t * 7.3) * 431.0) - 0.5) * uGrain;
  gl_FragColor = vec4(col, 1.0);
}
`;

export const FLARE_FRAGMENT = `
uniform vec2 uRes;
uniform vec2 uBead;
uniform vec2 uDisc;
uniform float uBeadI;
uniform float uStreak;
${NOISE_GLSL}
float ghost(vec2 frag, vec2 at, float radius) {
  float dist = length(frag - at);
  float disc = smoothstep(radius, radius * 0.55, dist);
  float ring = exp(-pow((dist - radius) / (radius * 0.08), 2.0));
  return disc * 0.5 + ring * 0.6;
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  float s = uRes.y;
  vec2 b = frag - uBead;
  float ax = abs(b.x) / s;
  float ay = abs(b.y) / s;
  float bd = length(b) / s;
  float streak = exp(-ay * 260.0) * exp(-ax * 1.7);
  float core = exp(-ay * 1200.0) * exp(-ax * 4.5);
  float glow = exp(-bd * 150.0) * 1.3 + exp(-bd * 34.0) * 0.22 + exp(-bd * 8.0) * 0.03;
  float angle = atan(b.y, b.x);
  float spikes = pow(abs(cos(angle * 2.0 + 0.785)), 80.0) * exp(-bd * 18.0) * 0.5;
  vec3 col = (vec3(0.4, 0.68, 1.0) * streak * 0.5 + vec3(0.86, 0.95, 1.0) * core * 0.9) * uStreak;
  col += vec3(1.0, 0.97, 0.92) * (glow + spikes) * uBeadI;
  vec2 axis = uDisc - uBead;
  col += vec3(0.45, 0.9, 0.75) * ghost(frag, uBead - axis * 0.55, s * 0.014) * 0.08 * uStreak;
  col += vec3(0.95, 0.55, 0.25) * ghost(frag, uBead - axis * 0.95, s * 0.032) * 0.045 * uStreak;
  col += vec3(0.55, 0.45, 1.0) * ghost(frag, uBead - axis * 1.6, s * 0.06) * 0.022 * uStreak;
  gl_FragColor = vec4(col, 1.0);
}
`;

export const PARTICLE_VERTEX = `
uniform float uStage;
uniform float uTime;
uniform float uIntro;
uniform float uSize;
uniform float uDpr;
uniform float uAlpha;
uniform vec2 uView;
uniform vec3 uSun;
uniform float uOrbit;
uniform vec4 uMoon;
uniform vec4 uWin[${WINDOW_COUNT}];
uniform vec3 uColor;
uniform vec3 uAccent;
attribute vec3 aRing;
attribute vec4 aWin;
attribute vec4 aSeed;
attribute vec3 aOrbit;
attribute float aAccent;
varying vec3 vColor;
varying float vAlpha;

const float PI = 3.14159265;

vec2 toScene(vec2 s) {
  return vec2(s.x - uView.x * 0.5, uView.y * 0.5 - s.y);
}

vec2 orbitPos() {
  float angle = aOrbit.y + uTime * aOrbit.z;
  float wobble = sin(uTime * 0.7 + aSeed.x * 40.0) * 0.012;
  return uSun.xy + vec2(cos(angle), sin(angle)) * uSun.z * (aOrbit.x * uOrbit + wobble);
}

vec2 ringPos() {
  float c = cos(uMoon.w);
  float s = sin(uMoon.w);
  vec3 p = vec3(aRing.x * c + aRing.z * s, aRing.y, -aRing.x * s + aRing.z * c);
  float persp = 1.0 / (1.0 - p.z * 0.5);
  vec2 wobble = vec2(
    sin(uTime * 0.9 + aSeed.x * 40.0),
    cos(uTime * 0.8 + aSeed.y * 40.0)
  ) * 0.004;
  return uMoon.xy + (p.xy + wobble) * uMoon.z * persp;
}

vec2 windowPos() {
  vec4 r = uWin[int(aWin.x + 0.5)];
  float u = aWin.y;
  float v = aWin.z;
  vec2 p;
  if (aWin.w < 0.5) {
    float len = 2.0 * (r.z + r.w);
    float d = u * len;
    if (d < r.z) p = vec2(r.x + d, r.y);
    else if (d < r.z + r.w) p = vec2(r.x + r.z, r.y + d - r.z);
    else if (d < 2.0 * r.z + r.w) p = vec2(r.x + r.z - (d - r.z - r.w), r.y + r.w);
    else p = vec2(r.x, r.y + r.w - (d - 2.0 * r.z - r.w));
    p += (aSeed.zw - 0.5) * 1.4;
  } else if (aWin.w < 1.5) {
    p = vec2(r.x + u * r.z, r.y + 28.0 + (v - 0.5) * 1.2);
  } else {
    p = vec2(r.x + u * r.z, r.y + 28.0 + v * (r.w - 28.0));
  }
  return toScene(p);
}

vec2 stateAt(float i) {
  if (i < 0.5) return orbitPos();
  if (i < 1.5) return windowPos();
  return ringPos();
}

void main() {
  float st = clamp(uStage, 0.0, 2.0);
  float i0 = min(floor(st), 1.0);
  float f = st - i0;
  float order = i0 < 0.5 ? (aWin.x / ${WINDOW_COUNT}.0) * 0.82 + aSeed.y * 0.18 : aSeed.y;
  float span = i0 < 0.5 ? 0.26 : 0.55;
  float fp = clamp((f - order * (1.0 - span)) / span, 0.0, 1.0);
  fp = fp * fp * (3.0 - 2.0 * fp);
  vec2 pos = mix(stateAt(i0), stateAt(i0 + 1.0), fp);
  float swirl = sin(fp * PI) * (24.0 + aSeed.z * 120.0);
  float angle = aSeed.w * 6.2831 + fp * 2.6;
  pos += vec2(cos(angle), sin(angle)) * swirl;

  float ip = clamp((uIntro - aSeed.x * 0.45) / 0.55, 0.0, 1.0);
  ip = 1.0 - pow(1.0 - ip, 3.0);
  vec2 introFrom = uSun.xy + (aSeed.zw - 0.5) * uView * 0.9;
  pos = mix(introFrom, pos, ip);

  float winWeight = i0 < 0.5 ? fp : 1.0 - fp;
  float interior = step(1.5, aWin.w);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 0.0, 1.0);
  gl_PointSize = uSize * uDpr * (0.6 + aSeed.w * 0.75) * (1.0 + aAccent * 0.25);
  vColor = mix(uColor, uAccent, aAccent);
  vAlpha = uAlpha * ip * (0.5 + 0.5 * aSeed.z) * mix(1.0, 0.35, interior * winWeight);
}
`;

export const PARTICLE_FRAGMENT = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float disc = 1.0 - smoothstep(0.55, 1.0, d);
  if (disc <= 0.0) discard;
  gl_FragColor = vec4(vColor, disc * vAlpha);
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
float rimMask = pow(rimFacing, 4.0);
vec2 rimPlane = normal.xy / max(length(normal.xy), 1e-4);
float rimBias = 0.3 + 0.7 * clamp(dot(rimPlane, uBeadDir) * 0.5 + 0.5, 0.0, 1.0);
totalEmissiveRadiance += uRimColor * rimMask * uRimStrength * rimBias;
`;
