// SPDX-License-Identifier: LicenseRef-Proprietary
import {
  ALPHANUMERIC_CHARS,
  GF_EXP,
  RS_TABLE,
  gfMul,
  type EcLevel,
  type RsSpec,
} from "./tables";
import { createFunctionGrid, maskMatches, penaltyScore, writeFormat } from "./matrix";

type QrMatrix = {
  readonly version: number;
  readonly size: number;
  readonly modules: readonly Uint8Array[];
};

const utf8 = new TextEncoder();

function rsGenerator(ecCount: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < ecCount; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, root);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGenerator(ecCount);
  const work = new Uint8Array(data.length + ecCount);
  work.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = work[i]!;
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      work[i + j] = work[i + j]! ^ gfMul(gen[j]!, factor);
    }
  }
  return work.slice(data.length);
}

function dataCodewordCount(spec: RsSpec): number {
  return spec[1] * spec[2] + spec[3] * spec[4];
}

function isAlphanumeric(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (!ALPHANUMERIC_CHARS.includes(text[i]!)) return false;
  }
  return true;
}

function pickVersion(text: string, ecLevel: EcLevel): { version: number; alpha: boolean; payload: Uint8Array } {
  const alpha = isAlphanumeric(text);
  const bytes = alpha ? new Uint8Array(0) : utf8.encode(text);
  const specs = RS_TABLE[ecLevel];
  for (let v = 1; v <= specs.length; v++) {
    const capacityBits = dataCodewordCount(specs[v - 1]!) * 8;
    const countBits = alpha ? (v >= 10 ? 11 : 9) : v >= 10 ? 16 : 8;
    const dataBits = alpha
      ? Math.floor(text.length / 2) * 11 + (text.length % 2) * 6
      : bytes.length * 8;
    if (4 + countBits + dataBits <= capacityBits) {
      return { version: v, alpha, payload: bytes };
    }
  }
  throw new RangeError(`QR payload exceeds version 10 capacity (${ecLevel})`);
}

function buildDataCodewords(text: string, version: number, alpha: boolean, payload: Uint8Array, totalDataBytes: number): Uint8Array {
  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let b = len - 1; b >= 0; b--) bits.push((val >> b) & 1);
  };
  if (alpha) {
    push(0b0010, 4);
    push(text.length, version >= 10 ? 11 : 9);
    for (let i = 0; i < text.length; i += 2) {
      const a = ALPHANUMERIC_CHARS.indexOf(text[i]!);
      if (i + 1 < text.length) push(a * 45 + ALPHANUMERIC_CHARS.indexOf(text[i + 1]!), 11);
      else push(a, 6);
    }
  } else {
    push(0b0100, 4);
    push(payload.length, version >= 10 ? 16 : 8);
    for (const byte of payload) push(byte, 8);
  }
  const capacityBits = totalDataBytes * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const out = new Uint8Array(totalDataBytes);
  let byteIdx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let j = 0; j < 8; j++) val = (val << 1) | bits[i + j]!;
    out[byteIdx++] = val;
  }
  const pads = [0xec, 0x11];
  for (let padIdx = 0; byteIdx < totalDataBytes; padIdx++) out[byteIdx++] = pads[padIdx % 2]!;
  return out;
}

function interleaveBlocks(data: Uint8Array, spec: RsSpec): Uint8Array {
  const [ecCount, g1Count, g1Size, g2Count, g2Size] = spec;
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < g1Count; i++) {
    const slice = data.slice(offset, offset + g1Size);
    dataBlocks.push(slice);
    ecBlocks.push(rsRemainder(slice, ecCount));
    offset += g1Size;
  }
  for (let i = 0; i < g2Count; i++) {
    const slice = data.slice(offset, offset + g2Size);
    dataBlocks.push(slice);
    ecBlocks.push(rsRemainder(slice, ecCount));
    offset += g2Size;
  }
  const maxData = Math.max(g1Size, g2Size);
  const result = new Uint8Array(data.length + (g1Count + g2Count) * ecCount);
  let pos = 0;
  for (let col = 0; col < maxData; col++) {
    for (const block of dataBlocks) {
      if (col < block.length) result[pos++] = block[col]!;
    }
  }
  for (let col = 0; col < ecCount; col++) {
    for (const block of ecBlocks) result[pos++] = block[col]!;
  }
  return result;
}

/** Encodes a string into an ISO/IEC 18004 QR matrix (versions 1..10). */
export function encodeQr(text: string, ecLevel: EcLevel = "M"): QrMatrix {
  const { version, alpha, payload } = pickVersion(text, ecLevel);
  const spec = RS_TABLE[ecLevel][version - 1]!;
  const data = buildDataCodewords(text, version, alpha, payload, dataCodewordCount(spec));
  const codewords = interleaveBlocks(data, spec);
  const { grid, reserved } = createFunctionGrid(version);
  const size = grid.length;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (reserved[r]![c]) continue;
        const bit = bitIndex < totalBits ? (codewords[bitIndex >> 3]! >> (7 - (bitIndex & 7))) & 1 : 0;
        bitIndex++;
        grid[r]![c] = bit;
      }
    }
    upward = !upward;
  }
  let bestMask = 0;
  let bestScore = Infinity;
  let bestGrid = grid;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = grid.map((row, r) => row.map((cell, c) => (reserved[r]![c] ? cell : cell ^ (maskMatches(mask, r, c) ? 1 : 0))));
    writeFormat(candidate, ecLevel, mask);
    const score = penaltyScore(candidate);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestGrid = candidate;
    }
  }
  void bestMask;
  return { version, size, modules: bestGrid };
}

/** Converts a QR matrix into an SVG path string with row run-length merging and quiet zone. */
export function toSvgPath(matrix: QrMatrix, quietZone = 4): { size: number; total: number; path: string } {
  const { size, modules } = matrix;
  const total = size + quietZone * 2;
  const segments: string[] = [];
  for (let r = 0; r < size; r++) {
    const row = modules[r]!;
    let c = 0;
    while (c < size) {
      if (!row[c]) {
        c++;
        continue;
      }
      const start = c;
      while (c < size && row[c]) c++;
      const run = c - start;
      segments.push(`M${start + quietZone},${r + quietZone}h${run}v1h-${run}z`);
    }
  }
  return { size, total, path: segments.join("") };
}
