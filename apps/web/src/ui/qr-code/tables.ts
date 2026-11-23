// SPDX-License-Identifier: LicenseRef-Proprietary

export type EcLevel = "L" | "M" | "Q" | "H";

/** [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] per ISO/IEC 18004 Table 9 for versions 1..10. */
export type RsSpec = readonly [ecPerBlock: number, g1Blocks: number, g1Data: number, g2Blocks: number, g2Data: number];

export const RS_TABLE: Readonly<Record<EcLevel, readonly RsSpec[]>> = {
  L: [
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
  ],
  Q: [
    [13, 1, 13, 0, 0],
    [22, 1, 22, 0, 0],
    [18, 2, 17, 0, 0],
    [26, 2, 24, 0, 0],
    [18, 2, 15, 2, 16],
    [24, 4, 19, 0, 0],
    [18, 2, 14, 4, 15],
    [22, 4, 18, 2, 19],
    [20, 4, 16, 4, 17],
    [24, 6, 19, 2, 20],
  ],
  H: [
    [17, 1, 9, 0, 0],
    [28, 1, 16, 0, 0],
    [22, 2, 13, 0, 0],
    [16, 4, 9, 0, 0],
    [22, 2, 11, 2, 12],
    [28, 4, 15, 0, 0],
    [26, 4, 13, 1, 14],
    [26, 4, 14, 2, 15],
    [24, 4, 12, 4, 13],
    [28, 6, 15, 2, 16],
  ],
};

/** Alignment center coordinates per ISO/IEC 18004 Table E.1 (versions 1..10). */
export const ALIGN_COORDS: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

export const ALPHANUMERIC_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

const EC_FORMAT_BITS: Readonly<Record<EcLevel, number>> = {
  L: 1,
  M: 0,
  Q: 3,
  H: 2,
};

export const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** BCH(15, 5) format information bits masked with 0x5412. */
export function formatInfoBits(ecLevel: EcLevel, mask: number): number {
  const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask;
  let rem = data << 10;
  const poly = 0x537;
  for (let bit = 14; bit >= 10; bit--) {
    if (rem & (1 << bit)) rem ^= poly << (bit - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

/** Golay(18, 6) version information bits for versions >= 7. */
export function versionInfoBits(version: number): number {
  let rem = version << 12;
  const poly = 0x1f25;
  for (let bit = 17; bit >= 12; bit--) {
    if (rem & (1 << bit)) rem ^= poly << (bit - 12);
  }
  return (version << 12) | rem;
}
