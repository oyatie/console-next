// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { buildInviteUrl } from "../../lib/pure/invite-link";
import { encodeQr, toSvgPath } from "./encode";
import { createFunctionGrid, writeFormat } from "./matrix";
import { ALIGN_COORDS, formatInfoBits, type EcLevel } from "./tables";
import { QrCode } from "./qr-code";

const hasFinderAt = (modules: readonly Uint8Array[], top: number, left: number) => {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const expected = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4) ? 1 : 0;
      if (modules[top + r]![left + c] !== expected) return false;
    }
  }
  return true;
};

const hasAlignAt = (modules: readonly Uint8Array[], r0: number, c0: number) => {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const expected = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
      if (modules[r0 + dr]![c0 + dc] !== expected) return false;
    }
  }
  return true;
};

const readCopy1 = (modules: readonly Uint8Array[]) => {
  const coords: [number, number][] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  let bits = 0;
  for (const [r, c] of coords) bits = (bits << 1) | modules[r]![c]!;
  return bits;
};

const readCopy2 = (modules: readonly Uint8Array[]) => {
  const size = modules.length;
  let bits = 0;
  for (let r = size - 1; r >= size - 7; r--) bits = (bits << 1) | modules[r]![8]!;
  for (let c = size - 8; c <= size - 1; c++) bits = (bits << 1) | modules[8]![c]!;
  return bits;
};

describe("ISO-18004 pure TS QR encoder", () => {
  test("places 7x7 finder patterns, separators, timing stripes, and dark module", () => {
    const qr = encodeQr("https://console.example.test/login#otp=ABCDE-FGHJK");
    expect(qr.size).toBe(17 + 4 * qr.version);
    expect(hasFinderAt(qr.modules, 0, 0)).toBe(true);
    expect(hasFinderAt(qr.modules, 0, qr.size - 7)).toBe(true);
    expect(hasFinderAt(qr.modules, qr.size - 7, 0)).toBe(true);
    // 1-module separators around top-left finder
    for (let i = 0; i < 8; i++) {
      expect(qr.modules[7]![i]).toBe(0);
      expect(qr.modules[i]![7]).toBe(0);
    }
    // Timing stripes on row 6 and col 6
    for (let i = 8; i < qr.size - 8; i++) {
      expect(qr.modules[6]![i]).toBe((i + 1) % 2);
      expect(qr.modules[i]![6]).toBe((i + 1) % 2);
    }
    // Dark module at (4*version + 9, 8)
    expect(qr.modules[4 * qr.version + 9]![8]).toBe(1);
  });

  test("encodes both standard 10-char OTP and 47-char cop_ operator invite URLs deterministically", () => {
    const stdUrl = buildInviteUrl("https://console.example.test", "ABCDE-FGHJK");
    const copUrl = buildInviteUrl("https://console.example.test", "cop_AbCdEf0123456789_xyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ".slice(0, 47));
    const a = encodeQr(stdUrl, "M");
    const b = encodeQr(stdUrl, "M");
    expect(a.modules.map((r) => [...r])).toEqual(b.modules.map((r) => [...r]));
    const cop = encodeQr(copUrl, "M");
    expect(cop.version).toBeGreaterThanOrEqual(4);
    expect(cop.size).toBe(17 + 4 * cop.version);
  });

  test("supports alphanumeric mode and rejects payloads exceeding version 10 capacity", () => {
    const alpha = encodeQr("HELLO WORLD 123");
    expect(alpha.version).toBe(1);
    expect(() => encodeQr("A".repeat(400), "H")).toThrow(RangeError);
  });

  test("computes valid BCH(15,5) format bits and renders accessible SVG with quiet zone", () => {
    // ISO/IEC 18004 example: EC M (00), mask 5 (101) -> 0x5412 ^ 0x10a7 = ...
    expect(formatInfoBits("M", 0)).toBe(0x5412);
    const qr = encodeQr("https://console.example.test/login#otp=ABCDE-FGHJK");
    const { total, path } = toSvgPath(qr, 4);
    expect(total).toBe(qr.size + 8);
    expect(path.startsWith("M4,4")).toBe(true);
    const html = renderToStaticMarkup(<QrCode value="https://console.example.test/login#otp=ABCDE-FGHJK" label="Sign-in QR" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Sign-in QR"');
    expect(html).toContain(`viewBox="0 0 ${total} ${total}"`);
    expect(html).toContain('shape-rendering="crispEdges"');
  });

  test("writes ISO-18004 Figure 19 format copies identically without overwriting dark module across all 32 (ecLevel, mask) pairs", () => {
    const levels: EcLevel[] = ["L", "M", "Q", "H"];
    let bit7ZeroCount = 0;
    let bit7OneCount = 0;
    for (const version of [1, 4, 7, 10]) {
      for (const ecLevel of levels) {
        for (let mask = 0; mask < 8; mask++) {
          const { grid } = createFunctionGrid(version);
          writeFormat(grid, ecLevel, mask);
          const expected = formatInfoBits(ecLevel, mask);
          expect(readCopy1(grid)).toBe(expected);
          expect(readCopy2(grid)).toBe(expected);
          expect(grid[4 * version + 9]![8]).toBe(1);
          if (version === 1) {
            if ((expected >> 7) & 1) bit7OneCount++;
            else bit7ZeroCount++;
          }
        }
      }
    }
    expect(bit7ZeroCount).toBe(16);
    expect(bit7OneCount).toBe(16);
  });

  test("end-to-end encodeQr matches formatInfoBits on both copies and keeps dark module across bit7=0 and bit7=1 payloads", () => {
    const payloads = [
      "A",
      "https://console.example.test/login#otp=ABCDE-FGHJK",
      buildInviteUrl("https://console.example.test", "cop_AbCdEf0123456789_xyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ".slice(0, 47)),
      "한글 테스트",
    ];
    const seenBit7 = new Set<number>();
    for (const value of payloads) {
      const qr = encodeQr(value, "M");
      const copy1 = readCopy1(qr.modules);
      const copy2 = readCopy2(qr.modules);
      expect(copy2).toBe(copy1);
      expect(qr.modules[4 * qr.version + 9]![8]).toBe(1);
      const matchingMasks = Array.from({ length: 8 }, (_, m) => m).filter((m) => formatInfoBits("M", m) === copy1);
      expect(matchingMasks).toHaveLength(1);
      seenBit7.add((copy1 >> 7) & 1);
    }
    expect(seenBit7.has(0) && seenBit7.has(1)).toBe(true);
  });

  test("places and reserves alignment patterns on row 6 and col 6 for versions 7 through 10", () => {
    const cases: { value: string; ecLevel: EcLevel }[] = [
      { value: "a".repeat(160), ecLevel: "M" },
      { value: "a".repeat(260), ecLevel: "L" },
      { value: buildInviteUrl("https://console.example.test", "cop_AbCdEf0123456789_xyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ".slice(0, 47)), ecLevel: "H" },
    ];
    for (const { value, ecLevel } of cases) {
      const qr = encodeQr(value, ecLevel);
      expect(qr.version).toBeGreaterThanOrEqual(7);
      const coords = ALIGN_COORDS[qr.version - 1]!;
      const mid = coords[1]!;
      expect(hasAlignAt(qr.modules, 6, mid)).toBe(true);
      expect(hasAlignAt(qr.modules, mid, 6)).toBe(true);
      const { reserved } = createFunctionGrid(qr.version);
      for (const r0 of coords) {
        for (const c0 of coords) {
          const inFinder =
            (r0 <= 7 && c0 <= 7) ||
            (r0 <= 7 && c0 >= qr.size - 8) ||
            (r0 >= qr.size - 8 && c0 <= 7);
          if (inFinder) continue;
          expect(hasAlignAt(qr.modules, r0, c0)).toBe(true);
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              expect(reserved[r0 + dr]![c0 + dc]).toBe(1);
            }
          }
        }
      }
    }
  });

  test("QrCode falls back to EC level L above 213 bytes and renders nothing without throwing above version 10 capacity", () => {
    expect(() => encodeQr("a".repeat(240), "M")).toThrow(RangeError);
    const fallbackHtml = renderToStaticMarkup(<QrCode value={"a".repeat(240)} label="L fallback" ecLevel="M" />);
    expect(fallbackHtml).toContain("<svg");
    expect(fallbackHtml).toContain('aria-label="L fallback"');

    const overflowHtml = renderToStaticMarkup(<QrCode value={"a".repeat(300)} label="Overflow" ecLevel="M" />);
    expect(overflowHtml).toBe("");
  });
});
