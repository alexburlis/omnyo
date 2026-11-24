export const WINDOW_COUNT = 7;

export const RAIN_SPAN = 0.22;

export const STREAM_REACH_SPAN = 42;

const MARK_PATH =
  "M46.85 12.3a24.7 24.7 0 1 0 5.45 5.45L43.2 26.85a12.15 12.15 0 1 1-6.05-6.05Z";

const MARK_CENTER = 32;

const MARK_SPAN = 49.6;

export type Vec4 = [number, number, number, number];

export interface ParticleFrame {
  stage: number;
  time: number;
  intro: number;
  alpha: number;
  colIn: [number, number, number];
  colOut: [number, number, number];
  veil: [number, number, number];
  markA: Vec4;
  markB: Vec4;
  markC: Vec4;
  windows: Vec4[];
  stream: Vec4;
  pointer: [number, number];
  pointerOn: number;
}

const VERTEX = `
precision highp float;
uniform float uStage;
uniform float uTime;
uniform float uIntro;
uniform float uSize;
uniform float uDpr;
uniform float uAlpha;
uniform float uPointerOn;
uniform vec2 uView;
uniform vec2 uPointer;
uniform vec4 uMarkA;
uniform vec4 uMarkB;
uniform vec4 uMarkC;
uniform vec4 uWin[${WINDOW_COUNT}];
uniform vec4 uStream;
uniform vec4 uChrome;
uniform vec3 uColIn;
uniform vec3 uColOut;
uniform vec3 uVeil;
uniform vec3 uAccent;
attribute vec3 aMark;
attribute vec4 aWin;
attribute vec4 aSeed;
attribute float aAccent;
varying vec3 vColor;
varying float vAlpha;

const float PI = 3.14159265;

vec2 toScene(vec2 s) {
  return vec2(s.x - uView.x * 0.5, uView.y * 0.5 - s.y);
}

vec2 markPos(vec4 m) {
  float c = cos(m.w);
  float s = sin(m.w);
  vec3 p = vec3(aMark.x * c + aMark.z * s, aMark.y, -aMark.x * s + aMark.z * c);
  float persp = 1.0 / (1.0 - p.z * 0.6);
  vec2 wobble = vec2(
    sin(uTime * 0.9 + aSeed.x * 40.0),
    cos(uTime * 0.8 + aSeed.y * 40.0)
  ) * 0.0022;
  return m.xy + (p.xy + wobble) * m.z * persp;
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
    vec2 inner = clamp(p, r.xy + uChrome.w, r.xy + r.zw - uChrome.w);
    vec2 bend = p - inner;
    float reach = length(bend);
    if (reach > 0.001) p = inner + bend / reach * uChrome.w;
    p += (aSeed.zw - 0.5) * 1.4;
  } else if (aWin.w < 1.5) {
    p = vec2(r.x + u * r.z, r.y + 30.0 + (v - 0.5) * 1.2);
  } else if (aWin.w < 2.5) {
    p = vec2(r.x + uChrome.w + u * (r.z - 2.0 * uChrome.w), r.y + 3.0 + v * 24.0);
  } else {
    float light = floor(u * 3.0);
    float a = fract(u * 3.0) * 2.0 * PI;
    float rad = sqrt(v) * uChrome.z;
    p = vec2(
      r.x + uChrome.x + light * uChrome.y + cos(a) * rad,
      r.y + 15.0 + sin(a) * rad
    );
  }
  return toScene(p);
}

vec2 fieldPos() {
  vec2 base = (aSeed.xy - 0.5) * uView * 1.12;
  base += vec2(
    sin(uTime * 0.13 + aSeed.z * 30.0),
    cos(uTime * 0.11 + aSeed.w * 30.0)
  ) * 28.0;
  return base;
}

float streamGlow = 1.0;
float streamHeat = 0.0;

vec2 streamPos() {
  float w = uStream.y - uStream.x;
  float reach = clamp(uStream.w / ${STREAM_REACH_SPAN.toFixed(1)}, 0.0, 1.0);
  float wide = uView.x < 720.0 ? 20.0 : 42.0;
  float t = fract(aSeed.x + uTime * (0.034 + aSeed.y * 0.05));
  float ends = smoothstep(0.0, 1.0, min(t, 1.0 - t) * 4.0);
  float middle = mix(0.4, 1.0, smoothstep(0.0, 1.0, abs(t - 0.5) * 4.0));
  float feed = smoothstep(0.0, 0.1, reach - t) * 0.85 + 0.15;
  float open = ends * middle * mix(feed, 1.0, step(0.999, reach));
  float spread = (aSeed.z + aSeed.w - 1.0) * wide;
  float y = uStream.z + spread * (0.05 + 0.95 * open)
    + sin(t * 18.0 + aSeed.w * 6.2831 + uTime * 0.8) * min(4.0, wide * 0.1) * open;
  vec2 flowing = vec2(uStream.x + t * w, y);

  float head = uStream.x + reach * w;
  float queued = step(reach, t) * (1.0 - step(0.999, reach));
  float orbit = aSeed.w * 6.2831 + uTime * (1.1 + aSeed.y * 2.4);
  float radius = wide * 0.62 * pow(fract(aSeed.x * 7.31 + aSeed.z), 1.7);
  vec2 core = vec2(
    head - radius * 0.35 + cos(orbit) * radius * 1.35,
    uStream.z + sin(orbit) * radius * 0.8
  );
  float lead = smoothstep(0.0, 0.04, reach - t) * (1.0 - queued);
  streamGlow = mix(1.0, step(aSeed.z, 0.16) * 0.95, queued);
  streamHeat = max(queued, (1.0 - lead) * step(t, reach) * 0.85) * (1.0 - step(0.999, reach));
  return mix(flowing, core, queued);
}

vec2 stateAt(float i) {
  if (i < 0.5) return markPos(uMarkA);
  if (i < 1.5) return windowPos();
  if (i < 2.5) return markPos(uMarkB);
  if (i < 3.5) return fieldPos();
  if (i < 4.5) return streamPos();
  return markPos(uMarkC);
}

void main() {
  float st = clamp(uStage, 0.0, 5.0);
  float i0 = min(floor(st), 4.0);
  float f = st - i0;
  float order = i0 < 0.5 ? (aWin.x / ${WINDOW_COUNT}.0) * 0.85 + aSeed.y * 0.15 : aSeed.y;
  float span = i0 < 0.5 ? ${RAIN_SPAN.toFixed(2)} : 0.55;
  float fp = clamp((f - order * (1.0 - span)) / span, 0.0, 1.0);
  fp = fp * fp * (3.0 - 2.0 * fp);
  vec2 pos = mix(stateAt(i0), stateAt(i0 + 1.0), fp);
  float swirl = sin(fp * PI) * (30.0 + aSeed.z * 150.0);
  float angle = aSeed.w * 6.2831 + fp * 2.6;
  pos += vec2(cos(angle), sin(angle)) * swirl;

  float ip = clamp((uIntro - aSeed.x * 0.5) / 0.5, 0.0, 1.0);
  ip = 1.0 - pow(1.0 - ip, 3.0);
  vec2 introFrom = fieldPos() * 1.25;
  pos = mix(introFrom, pos, ip) + vec2(cos(angle), sin(angle)) * sin(ip * PI) * 60.0 * aSeed.z;

  vec2 away = pos - uPointer;
  float dist = length(away);
  pos += away / max(dist, 1.0) * uPointerOn * 38.0 * smoothstep(130.0, 0.0, dist);

  float winWeight = i0 < 0.5 ? fp : (i0 < 1.5 ? 1.0 - fp : 0.0);
  float interior = step(1.5, aWin.w) * step(aWin.w, 2.5);
  float fieldWeight = i0 > 1.5 && i0 < 2.5 ? fp : (i0 > 2.5 && i0 < 3.5 ? 1.0 - fp : 0.0);
  float streamWeight = i0 > 2.5 && i0 < 3.5 ? fp : (i0 > 3.5 ? 1.0 - fp : 0.0);

  gl_Position = vec4(pos / (uView * 0.5), 0.0, 1.0);
  gl_PointSize = uSize * uDpr * (0.6 + aSeed.w * 0.75) * (1.0 + aAccent * 0.2) * (1.0 - fieldWeight * 0.25);
  float inside = 1.0 - smoothstep(uVeil.z - 1.5, uVeil.z + 1.5, length(pos - uVeil.xy));
  float light = floor(aWin.y * 3.0);
  vec3 lightColor = light < 0.5
    ? vec3(1.0, 0.373, 0.341)
    : (light < 1.5 ? vec3(0.996, 0.737, 0.18) : vec3(0.157, 0.784, 0.251));
  vec3 accent = mix(uAccent, lightColor, winWeight * step(2.5, aWin.w));
  vColor = mix(mix(uColOut, uColIn, inside), accent, max(aAccent, streamHeat * streamWeight));
  vAlpha = uAlpha * (0.55 + 0.45 * aSeed.z) * mix(1.0, 0.42, interior * winWeight)
    * mix(1.0, streamGlow, streamWeight);
  if (vAlpha <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FRAGMENT = `
precision mediump float;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  gl_FragColor = vec4(vColor, (1.0 - smoothstep(0.55, 1.0, d)) * vAlpha);
}
`;

function sampleMark(count: number, accentShare: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext("2d");

  if (!ctx) throw new Error("2D canvas is unavailable");
  const ring = new Path2D(MARK_PATH);
  const dot = { x: 49.5, y: 14.5, r: 6.5 };
  const marks = new Float32Array(count * 3);
  const accents = new Float32Array(count);
  const accentCount = Math.round(count * accentShare);

  const store = (index: number, x: number, y: number) => {
    marks[index * 3] = (x - MARK_CENTER) / MARK_SPAN;
    marks[index * 3 + 1] = -(y - MARK_CENTER) / MARK_SPAN;
    marks[index * 3 + 2] = (Math.random() - 0.5) * 0.09;
  };

  for (let i = 0; i < accentCount; i++) {
    const a = Math.random() * Math.PI * 2;

    const r =
      Math.random() < 0.3
        ? dot.r - Math.random() * 0.3
        : Math.sqrt(Math.random()) * dot.r;

    store(i, dot.x + Math.cos(a) * r, dot.y + Math.sin(a) * r);
    accents[i] = 1;
  }

  for (let i = accentCount; i < count; i++) {
    const edge = Math.random() < 0.3;

    for (;;) {
      let x: number;
      let y: number;

      if (edge) {
        const a = Math.random() * Math.PI * 2;
        const outer = Math.random() < 0.62;

        const r = outer
          ? 24.7 - Math.random() * 0.35
          : 12.15 + Math.random() * 0.35;

        x = MARK_CENTER + Math.cos(a) * r;
        y = MARK_CENTER + Math.sin(a) * r;
      } else {
        x = 7 + Math.random() * 50;
        y = 7 + Math.random() * 50;
      }

      if (ctx.isPointInPath(ring, x, y)) {
        store(i, x, y);
        break;
      }
    }
  }

  return { marks, accents };
}

const STRIDE = 12;

const UNIFORMS = [
  "uStage",
  "uTime",
  "uIntro",
  "uSize",
  "uDpr",
  "uAlpha",
  "uPointerOn",
  "uView",
  "uPointer",
  "uMarkA",
  "uMarkB",
  "uMarkC",
  "uWin",
  "uStream",
  "uChrome",
  "uColIn",
  "uColOut",
  "uVeil",
  "uAccent",
] as const;

type UniformName = (typeof UNIFORMS)[number];

export function createParticles(canvas: HTMLCanvasElement, count: number) {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });

  if (!gl) throw new Error("WebGL is unavailable");

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);

    if (!shader) throw new Error("Shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? "Shader failed");
    }

    return shader;
  };

  const vertex = compile(gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();

  if (!program) throw new Error("Program allocation failed");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "Program failed");
  }

  gl.useProgram(program);

  const { marks, accents } = sampleMark(count, 0.1);
  const data = new Float32Array(count * STRIDE);

  for (let i = 0; i < count; i++) {
    const roll = Math.random();
    const accent = accents[i] === 1;
    const o = i * STRIDE;
    data[o] = marks[i * 3] ?? 0;
    data[o + 1] = marks[i * 3 + 1] ?? 0;
    data[o + 2] = marks[i * 3 + 2] ?? 0;
    data[o + 3] = accent
      ? i % WINDOW_COUNT
      : Math.floor(Math.random() * WINDOW_COUNT);
    data[o + 4] = Math.random();
    data[o + 5] = Math.random();
    data[o + 6] = accent ? 3 : roll < 0.6 ? 0 : roll < 0.7 ? 1 : 2;
    data[o + 7] = Math.random();
    data[o + 8] = Math.random();
    data[o + 9] = Math.random();
    data[o + 10] = Math.random();
    data[o + 11] = accent ? 1 : 0;
  }

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

  const attribute = (name: string, size: number, offset: number) => {
    const location = gl.getAttribLocation(program, name);

    if (location < 0) return;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(
      location,
      size,
      gl.FLOAT,
      false,
      STRIDE * 4,
      offset * 4,
    );
  };

  attribute("aMark", 3, 0);
  attribute("aWin", 4, 3);
  attribute("aSeed", 4, 7);
  attribute("aAccent", 1, 11);

  const at = Object.fromEntries(
    UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]),
  ) as Record<UniformName, WebGLUniformLocation | null>;

  const windows = new Float32Array(WINDOW_COUNT * 4);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(
    gl.SRC_ALPHA,
    gl.ONE_MINUS_SRC_ALPHA,
    gl.ONE,
    gl.ONE_MINUS_SRC_ALPHA,
  );
  gl.clearColor(0, 0, 0, 0);
  gl.uniform3f(at.uAccent, 1, 0.32, 0.1);

  const resize = (width: number, height: number, dpr: number) => {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(at.uView, width, height);
    gl.uniform1f(at.uDpr, dpr);
    gl.uniform1f(at.uSize, width < 720 ? 1.7 : 2.1);

    if (width <= 820) gl.uniform4f(at.uChrome, 13, 13, 3, 8);
    else gl.uniform4f(at.uChrome, 15, 16, 3.8, 10);
  };

  const render = (frame: ParticleFrame) => {
    gl.uniform1f(at.uStage, frame.stage);
    gl.uniform1f(at.uTime, frame.time);
    gl.uniform1f(at.uIntro, frame.intro);
    gl.uniform1f(at.uAlpha, frame.alpha);
    gl.uniform3fv(at.uColIn, frame.colIn);
    gl.uniform3fv(at.uColOut, frame.colOut);
    gl.uniform3fv(at.uVeil, frame.veil);
    gl.uniform4fv(at.uMarkA, frame.markA);
    gl.uniform4fv(at.uMarkB, frame.markB);
    gl.uniform4fv(at.uMarkC, frame.markC);
    frame.windows.forEach((rect, index) => windows.set(rect, index * 4));
    gl.uniform4fv(at.uWin, windows);
    gl.uniform4fv(at.uStream, frame.stream);
    gl.uniform2fv(at.uPointer, frame.pointer);
    gl.uniform1f(at.uPointerOn, frame.pointerOn);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, count);
  };

  const dispose = () => {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
  };

  return { resize, render, dispose };
}
