// SPDX-License-Identifier: LicenseRef-Proprietary
import { ALIGN_COORDS, formatInfoBits, versionInfoBits, type EcLevel } from "./tables";

export function createFunctionGrid(version: number): { grid: Uint8Array[]; reserved: Uint8Array[] } {
  const size = 17 + 4 * version;
  const grid = Array.from({ length: size }, () => new Uint8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));
  const setFunc = (r: number, c: number, dark: boolean) => {
    grid[r]![c] = dark ? 1 : 0;
    reserved[r]![c] = 1;
  };
  const placeFinder = (top: number, left: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = top + r;
        const cc = left + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inOuter = r === 0 || r === 6 || c === 0 || c === 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const inBox = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        setFunc(rr, cc, inBox && (inOuter || inCore));
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }
  const coords = ALIGN_COORDS[version - 1] ?? [];
  for (const r0 of coords) {
    for (const c0 of coords) {
      const inFinder =
        (r0 <= 7 && c0 <= 7) ||
        (r0 <= 7 && c0 >= size - 8) ||
        (r0 >= size - 8 && c0 <= 7);
      if (inFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunc(r0 + dr, c0 + dc, dark);
        }
      }
    }
  }
  setFunc(4 * version + 9, 8, true);
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[8]![i] = 1;
      reserved[i]![8] = 1;
    }
  }
  for (let i = 0; i < 8; i++) reserved[8]![size - 1 - i] = 1;
  for (let i = 0; i < 7; i++) reserved[size - 1 - i]![8] = 1;
  if (version >= 7) {
    const vBits = versionInfoBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = Boolean((vBits >> i) & 1);
      const a = Math.floor(i / 3);
      const b = i % 3;
      setFunc(a, size - 11 + b, dark);
      setFunc(size - 11 + b, a, dark);
    }
  }
  return { grid, reserved };
}

export function maskMatches(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

export function writeFormat(grid: Uint8Array[], ecLevel: EcLevel, mask: number): void {
  const size = grid.length;
  const bits = formatInfoBits(ecLevel, mask);
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) as 0 | 1;
    // Vertical strip (col 8): Copy 1 bits 0..7 at (0..5,8),(7,8),(8,8); Copy 2 bits 8..14 at (size-7..size-1,8)
    if (i < 6) grid[i]![8] = dark;
    else if (i < 8) grid[i + 1]![8] = dark;
    else grid[size - 15 + i]![8] = dark;

    // Horizontal strip (row 8): Copy 2 bits 0..7 at (8,size-1..size-8); Copy 1 bits 8..14 at (8,7),(8,5..0)
    if (i < 8) grid[8]![size - 1 - i] = dark;
    else if (i < 9) grid[8]![15 - i] = dark;
    else grid[8]![14 - i] = dark;
  }
}

export function penaltyScore(grid: Uint8Array[]): number {
  const size = grid.length;
  let score = 0;
  let darkCount = 0;
  for (let r = 0; r < size; r++) {
    let rowRun = 1;
    let colRun = 1;
    for (let c = 0; c < size; c++) {
      if (grid[r]![c]) darkCount++;
      if (c > 0) {
        if (grid[r]![c] === grid[r]![c - 1]) rowRun++;
        else {
          if (rowRun >= 5) score += 3 + (rowRun - 5);
          rowRun = 1;
        }
        if (grid[c]![r] === grid[c - 1]![r]) colRun++;
        else {
          if (colRun >= 5) score += 3 + (colRun - 5);
          colRun = 1;
        }
      }
      if (r < size - 1 && c < size - 1) {
        const v = grid[r]![c]!;
        if (v === grid[r]![c + 1] && v === grid[r + 1]![c] && v === grid[r + 1]![c + 1]) score += 3;
      }
      if (c <= size - 11) {
        const matchH =
          (grid[r]![c] === 1 && grid[r]![c + 1] === 0 && grid[r]![c + 2] === 1 && grid[r]![c + 3] === 1 && grid[r]![c + 4] === 1 && grid[r]![c + 5] === 0 && grid[r]![c + 6] === 1 && grid[r]![c + 7] === 0 && grid[r]![c + 8] === 0 && grid[r]![c + 9] === 0 && grid[r]![c + 10] === 0) ||
          (grid[r]![c] === 0 && grid[r]![c + 1] === 0 && grid[r]![c + 2] === 0 && grid[r]![c + 3] === 0 && grid[r]![c + 4] === 1 && grid[r]![c + 5] === 0 && grid[r]![c + 6] === 1 && grid[r]![c + 7] === 1 && grid[r]![c + 8] === 1 && grid[r]![c + 9] === 0 && grid[r]![c + 10] === 1);
        if (matchH) score += 40;
      }
      if (r <= size - 11) {
        const matchV =
          (grid[r]![c] === 1 && grid[r + 1]![c] === 0 && grid[r + 2]![c] === 1 && grid[r + 3]![c] === 1 && grid[r + 4]![c] === 1 && grid[r + 5]![c] === 0 && grid[r + 6]![c] === 1 && grid[r + 7]![c] === 0 && grid[r + 8]![c] === 0 && grid[r + 9]![c] === 0 && grid[r + 10]![c] === 0) ||
          (grid[r]![c] === 0 && grid[r + 1]![c] === 0 && grid[r + 2]![c] === 0 && grid[r + 3]![c] === 0 && grid[r + 4]![c] === 1 && grid[r + 5]![c] === 0 && grid[r + 6]![c] === 1 && grid[r + 7]![c] === 1 && grid[r + 8]![c] === 1 && grid[r + 9]![c] === 0 && grid[r + 10]![c] === 1);
        if (matchV) score += 40;
      }
    }
    if (rowRun >= 5) score += 3 + (rowRun - 5);
    if (colRun >= 5) score += 3 + (colRun - 5);
  }
  const percent = (darkCount * 100) / (size * size);
  const k = Math.floor(Math.abs(percent - 50) / 5);
  return score + k * 10;
}
