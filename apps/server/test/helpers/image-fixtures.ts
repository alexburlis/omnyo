import { crc32 } from "node:zlib";
import sharp from "sharp";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

interface PngChunk {
  data: Buffer;
  type: string;
}

function readPngChunks(png: Buffer): PngChunk[] {
  const chunks: PngChunk[] = [];

  for (let offset = PNG_SIGNATURE.length; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    chunks.push({
      type: png.toString("latin1", offset + 4, offset + 8),
      data: png.subarray(offset + 8, offset + 8 + length),
    });
    offset += 12 + length;
  }

  return chunks;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "latin1");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);

  return Buffer.concat([header, data, checksum]);
}

function frameControl(sequence: number, width: number, height: number) {
  const data = Buffer.alloc(26);
  data.writeUInt32BE(sequence, 0);
  data.writeUInt32BE(width, 4);
  data.writeUInt32BE(height, 8);
  data.writeUInt16BE(1, 20);
  data.writeUInt16BE(10, 22);

  return pngChunk("fcTL", data);
}

export function solidPng(width: number, height: number, red = 128) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: red, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

export async function animatedPng(
  width: number,
  height: number,
): Promise<Buffer> {
  const [first, second] = (
    await Promise.all([
      solidPng(width, height, 0),
      solidPng(width, height, 255),
    ])
  ).map(readPngChunks);

  const header = first?.find((chunk) => chunk.type === "IHDR");

  if (first === undefined || second === undefined || header === undefined)
    throw new Error("Missing PNG frame chunks");

  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2, 0);

  const firstFrame = first
    .filter((chunk) => chunk.type === "IDAT")
    .map((chunk) => pngChunk("IDAT", chunk.data));

  const secondFrame = second
    .filter((chunk) => chunk.type === "IDAT")
    .map((chunk, index) => {
      const sequence = Buffer.alloc(4);
      sequence.writeUInt32BE(index + 2, 0);

      return pngChunk("fdAT", Buffer.concat([sequence, chunk.data]));
    });

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header.data),
    pngChunk("acTL", animation),
    frameControl(0, width, height),
    ...firstFrame,
    frameControl(1, width, height),
    ...secondFrame,
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function jpegWithExtraneousScanBytes(
  png: Buffer,
): Promise<Buffer> {
  const jpeg = await sharp(png).jpeg({ quality: 90 }).toBuffer();

  for (let offset = 2; offset + 4 <= jpeg.length;) {
    if (jpeg[offset] !== 0xff) throw new Error("Malformed JPEG marker");

    if (jpeg[offset + 1] === 0xda)
      return Buffer.concat([
        jpeg.subarray(0, offset),
        Buffer.from([0, 0, 0]),
        jpeg.subarray(offset),
      ]);

    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }

  throw new Error("Missing JPEG start-of-scan marker");
}
