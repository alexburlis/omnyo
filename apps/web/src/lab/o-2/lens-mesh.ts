export type LensMesh = {
  positions: Float32Array;
  normals: Float32Array;
  index: Uint32Array;
  innerRadius: number;
};

const HEADER_BYTES = 40;

const POSITION_STEPS = 65535;

const NORMAL_STEPS = 4095;

function readHeader(bytes: ArrayBuffer) {
  const view = new DataView(bytes, 0, HEADER_BYTES);

  return {
    vertexCount: view.getUint32(0, true),
    coarseCount: view.getUint32(4, true),
    faceCount: view.getUint32(8, true),
    innerRadius: view.getFloat32(12, true),
    low: [
      view.getFloat32(16, true),
      view.getFloat32(20, true),
      view.getFloat32(24, true),
    ],
    high: [
      view.getFloat32(28, true),
      view.getFloat32(32, true),
      view.getFloat32(36, true),
    ],
  };
}

function decodePositions(
  payload: Uint8Array,
  count: number,
  low: number[],
  high: number[],
) {
  const total = count * 3;
  const positions = new Float32Array(total);

  for (let axis = 0; axis < 3; axis++) {
    const scale = (high[axis] - low[axis]) / POSITION_STEPS;

    for (let vertex = 0; vertex < count; vertex++) {
      const at = axis * count + vertex;
      const step = payload[at] | (payload[total + at] << 8);
      positions[vertex * 3 + axis] = low[axis] + step * scale;
    }
  }

  return positions;
}

function decodeNormals(payload: Uint8Array, count: number) {
  const normals = new Float32Array(count * 3);

  for (let vertex = 0; vertex < count; vertex++) {
    const at = vertex * 3;
    const packedU = payload[at] | ((payload[at + 1] & 15) << 8);
    const packedV = (payload[at + 1] >> 4) | (payload[at + 2] << 4);
    const u = (packedU / NORMAL_STEPS) * 2 - 1;
    const v = (packedV / NORMAL_STEPS) * 2 - 1;
    let x = u;
    let y = v;
    const z = 1 - Math.abs(u) - Math.abs(v);

    if (z < 0) {
      x = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
      y = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
    }

    const inverse = 1 / Math.hypot(x, y, z);
    normals[at] = x * inverse;
    normals[at + 1] = y * inverse;
    normals[at + 2] = z * inverse;
  }

  return normals;
}

function decodeIndex(
  payload: Uint8Array,
  faceCount: number,
  coarseCount: number,
) {
  const total = faceCount * 3;
  const coarse = new Uint32Array(total);

  for (let corner = 0; corner < total; corner++) {
    coarse[corner] = payload[corner] | (payload[total + corner] << 8);
  }

  const stride = coarseCount + 1;
  const edgeIds = new Map<number, number>();
  const index = new Uint32Array(faceCount * 12);

  const edge = (a: number, b: number) => {
    const key = a < b ? a * stride + b : b * stride + a;
    let id = edgeIds.get(key);

    if (id === undefined) {
      id = edgeIds.size;
      edgeIds.set(key, id);
    }

    return coarseCount + id;
  };

  for (let face = 0; face < faceCount; face++) {
    const a = coarse[face * 3];
    const b = coarse[face * 3 + 1];
    const c = coarse[face * 3 + 2];
    const ab = edge(a, b);
    const bc = edge(b, c);
    const ca = edge(c, a);
    index.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], face * 12);
  }

  return index;
}

export async function decodeLensMesh(bytes: ArrayBuffer): Promise<LensMesh> {
  const header = readHeader(bytes);
  const body = new Blob([bytes.slice(HEADER_BYTES)]);

  const stream = body
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));

  const payload = new Uint8Array(await new Response(stream).arrayBuffer());

  const positionBytes = header.vertexCount * 6;
  const normalBytes = header.vertexCount * 3;

  return {
    positions: decodePositions(
      payload.subarray(0, positionBytes),
      header.vertexCount,
      header.low,
      header.high,
    ),
    normals: decodeNormals(
      payload.subarray(positionBytes, positionBytes + normalBytes),
      header.vertexCount,
    ),
    index: decodeIndex(
      payload.subarray(positionBytes + normalBytes),
      header.faceCount,
      header.coarseCount,
    ),
    innerRadius: header.innerRadius,
  };
}
