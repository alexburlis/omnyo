import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { OpusDecoder } from "opus-decoder";
import { type AudioDiagnostics } from "./contract";

const run = promisify(execFile);

const sampleRate = 16_000;

const webmMagic = [0x1a, 0x45, 0xdf, 0xa3];

const webmContainers = new Set([0x18538067, 0x1654ae6b, 0xae, 0xe1, 0x1f43b675, 0xa0]);

type Vint = { value: number; length: number; unknown: boolean };

type OpusStream = { head: Uint8Array; packets: Uint8Array[] };

type Block = { track: number; frames: Uint8Array[] };

export class AudioDecodeFailure extends Error {
  constructor(readonly audio: AudioDiagnostics) {
    super("audio_decode_failed");
  }
}

export function audioDiagnostics(encodedBytes: number): AudioDiagnostics {
  return {
    encodedBytes,
    decodedDurationMs: null,
    decodedSamples: null,
    decodedSampleRate: null,
    decodedChannels: null,
    nonFiniteSamples: null,
    clippedSamples: null,
    signalLevelBucket: null,
    opusErrorCount: null,
  };
}

function measurePcm(
  samples: Iterable<number>,
  frames: number,
  rate: number,
  channels: number,
  diagnostics: AudioDiagnostics,
): void {
  let nonFinite = 0;
  let clipped = 0;
  let sumSquares = 0;

  for (const sample of samples) {
    if (!Number.isFinite(sample)) nonFinite += 1;
    else {
      if (Math.abs(sample) >= 1) clipped += 1;
      sumSquares += sample * sample;
    }
  }

  const finiteSamples = frames * channels - nonFinite;
  const rms = finiteSamples > 0 ? Math.sqrt(sumSquares / finiteSamples) : 0;
  const thresholds = [0, 0.0001, 0.001, 0.01, 0.1];
  diagnostics.decodedDurationMs = Math.round((frames * 1000) / rate);
  diagnostics.decodedSamples = frames;
  diagnostics.decodedSampleRate = rate;
  diagnostics.decodedChannels = channels;
  diagnostics.nonFiniteSamples = nonFinite;
  diagnostics.clippedSamples = clipped;
  diagnostics.signalLevelBucket =
    finiteSamples > 0 ? thresholds.filter((threshold) => rms > threshold).length : null;
}

function* channelSamples(channels: Float32Array[]): Generator<number> {
  for (const channel of channels) yield* channel;
}

function measureWav(bytes: Buffer, diagnostics: AudioDiagnostics): void {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("invalid_wav");

  let rate = 0;
  let channels = 0;
  let data: Buffer | undefined;

  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;

    if (end > bytes.length) throw new Error("truncated_wav");

    if (kind === "fmt ") {
      if (length < 16 || bytes.readUInt16LE(start) !== 3 || bytes.readUInt16LE(start + 14) !== 32)
        throw new Error("unsupported_wav");
      channels = bytes.readUInt16LE(start + 2);
      rate = bytes.readUInt32LE(start + 4);
    } else if (kind === "data") data = bytes.subarray(start, end);
    offset = end + (length % 2);
  }

  if (!data || channels < 1 || rate < 1 || data.length % (4 * channels) !== 0)
    throw new Error("invalid_wav");
  const pcm = data;

  function* samples(): Generator<number> {
    for (let offset = 0; offset < pcm.length; offset += 4) yield pcm.readFloatLE(offset);
  }

  measurePcm(samples(), pcm.length / (4 * channels), rate, channels, diagnostics);
}

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

function startsWith(bytes: Uint8Array, prefix: number[], at = 0): boolean {
  return prefix.every((value, index) => bytes[at + index] === value);
}

function byteAt(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset];

  if (value === undefined) throw new Error("truncated_audio");

  return value;
}

function readVint(bytes: Uint8Array, offset: number, keepMarker: boolean): Vint {
  const first = byteAt(bytes, offset);
  const length = Math.clz32(first) - 23;

  if (length < 1 || length > 8) throw new Error("invalid_webm");
  const mask = 0xff >> length;
  let value = keepMarker ? first : first & mask;
  let unknown = (first & mask) === mask;

  for (let index = 1; index < length; index++) {
    const next = byteAt(bytes, offset + index);
    value = value * 256 + next;
    unknown &&= next === 0xff;
  }

  return { value, length, unknown };
}

function readUint(bytes: Uint8Array): number {
  let value = 0;

  for (const byte of bytes) value = value * 256 + byte;

  return value;
}

function blockFrames(block: Uint8Array): Block {
  const track = readVint(block, 0, false);
  let offset = track.length + 2;
  const lacing = (byteAt(block, offset) >> 1) & 3;
  offset += 1;

  if (lacing === 0) return { track: track.value, frames: [block.subarray(offset)] };
  const count = byteAt(block, offset) + 1;
  offset += 1;
  const sizes: number[] = [];

  if (lacing === 1) {
    for (let index = 0; index < count - 1; index++) {
      let size = 0;
      let lace = 255;

      while (lace === 255) {
        lace = byteAt(block, offset);
        offset += 1;
        size += lace;
      }

      sizes.push(size);
    }
  } else if (lacing === 3) {
    const first = readVint(block, offset, false);
    offset += first.length;
    sizes.push(first.value);

    for (let index = 1; index < count - 1; index++) {
      const delta = readVint(block, offset, false);
      offset += delta.length;
      sizes.push((sizes[index - 1] ?? 0) + delta.value - (2 ** (7 * delta.length - 1) - 1));
    }
  } else {
    const size = (block.length - offset) / count;

    for (let index = 0; index < count - 1; index++) sizes.push(size);
  }

  sizes.push(block.length - offset - sizes.reduce((sum, size) => sum + size, 0));
  const frames: Uint8Array[] = [];

  for (const size of sizes) {
    if (size < 0 || offset + size > block.length) throw new Error("invalid_webm");
    frames.push(block.subarray(offset, offset + size));
    offset += size;
  }

  return { track: track.value, frames };
}

function demuxWebm(bytes: Uint8Array): OpusStream {
  const tracks: { number: number; codec: string; head: Uint8Array | null }[] = [];
  const blocks: Block[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const id = readVint(bytes, offset, true);
    const size = readVint(bytes, offset + id.length, false);
    offset += id.length + size.length;

    if (webmContainers.has(id.value)) {
      if (id.value === 0xae) tracks.push({ number: 0, codec: "", head: null });
      continue;
    }

    if (size.unknown) throw new Error("invalid_webm");
    const end = offset + size.value;

    if (end > bytes.length) break;
    const data = bytes.subarray(offset, end);
    const track = tracks.at(-1);
    offset = end;

    if (id.value === 0xa3 || id.value === 0xa1) blocks.push(blockFrames(data));
    else if (track && id.value === 0xd7) track.number = readUint(data);
    else if (track && id.value === 0x86) track.codec = new TextDecoder().decode(data);
    else if (track && id.value === 0x63a2) track.head = data;
  }

  const audio = tracks.find((track) => track.codec === "A_OPUS" && track.head !== null);

  if (!audio?.head) throw new Error("unsupported_webm_codec");
  const packets: Uint8Array[] = [];

  for (const block of blocks) if (block.track === audio.number) packets.push(...block.frames);

  return { head: audio.head, packets };
}

function oggPackets(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packets: Uint8Array[] = [];
  let pending: Uint8Array[] = [];
  let serial: number | undefined;
  let offset = 0;

  while (offset + 27 <= bytes.length) {
    if (!startsWith(bytes, ascii("OggS"), offset)) throw new Error("invalid_ogg");
    const pageSerial = view.getUint32(offset + 14, true);
    const count = byteAt(bytes, offset + 26);
    let body = offset + 27 + count;
    serial ??= pageSerial;

    for (let index = 0; index < count; index++) {
      const lace = byteAt(bytes, offset + 27 + index);

      if (pageSerial === serial) pending.push(bytes.subarray(body, body + lace));
      body += lace;

      if (lace < 255 && pageSerial === serial) {
        packets.push(Buffer.concat(pending));
        pending = [];
      }
    }

    offset = body;
  }

  return packets;
}

function isOggOpus(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, ascii("OggS")) && startsWith(bytes, ascii("OpusHead"), 27 + byteAt(bytes, 26))
  );
}

function demuxOgg(bytes: Uint8Array): OpusStream {
  const [head, , ...packets] = oggPackets(bytes);

  if (!head || !startsWith(head, ascii("OpusHead"))) throw new Error("unsupported_ogg_codec");

  return { head, packets };
}

async function decodeOpus(
  { head, packets }: OpusStream,
  diagnostics: AudioDiagnostics,
): Promise<Float32Array> {
  if (head.length < 19 || !startsWith(head, ascii("OpusHead")))
    throw new Error("invalid_opus_header");
  const channels = byteAt(head, 9);
  const preSkip = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(10, true);
  const family = byteAt(head, 18);

  const decoder = new OpusDecoder({
    sampleRate,
    channels,
    preSkip: Math.round((preSkip * sampleRate) / 48_000),
    streamCount: family === 0 ? 1 : byteAt(head, 19),
    coupledStreamCount: family === 0 ? (channels === 2 ? 1 : 0) : byteAt(head, 20),
    channelMappingTable:
      family === 0 ? (channels === 2 ? [0, 1] : [0]) : [...head.subarray(21, 21 + channels)],
  });

  await decoder.ready;

  try {
    const decoded = decoder.decodeFrames(packets);
    diagnostics.opusErrorCount = decoded.errors.length;
    measurePcm(
      channelSamples(decoded.channelData),
      decoded.samplesDecoded,
      decoded.sampleRate,
      decoded.channelData.length,
      diagnostics,
    );

    if (decoded.samplesDecoded === 0) throw new Error("empty_audio");
    const mono = new Float32Array(decoded.samplesDecoded);

    for (const channel of decoded.channelData)
      for (let index = 0; index < mono.length; index++)
        mono[index] = (mono[index] ?? 0) + (channel[index] ?? 0) / decoded.channelData.length;

    return mono;
  } finally {
    decoder.free();
  }
}

function wav(samples: Float32Array): Buffer {
  const header = Buffer.alloc(44);
  const dataBytes = samples.length * 4;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);

  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, dataBytes)]);
}

export async function writeSpeechWav(input: string, output: string, signal: AbortSignal) {
  const bytes = new Uint8Array(await readFile(input));
  const diagnostics = audioDiagnostics(bytes.length);
  signal.throwIfAborted();

  try {
    if (startsWith(bytes, webmMagic) || isOggOpus(bytes)) {
      const stream = startsWith(bytes, webmMagic) ? demuxWebm(bytes) : demuxOgg(bytes);
      await writeFile(output, wav(await decodeOpus(stream, diagnostics)), { mode: 0o600 });

      return diagnostics;
    }

    await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEF32@16000", "-c", "1", input, output], {
      signal,
    });
    measureWav(await readFile(output), diagnostics);

    return diagnostics;
  } catch {
    signal.throwIfAborted();
    throw new AudioDecodeFailure(diagnostics);
  }
}
