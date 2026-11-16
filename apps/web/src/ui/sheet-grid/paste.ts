// SPDX-License-Identifier: LicenseRef-Proprietary
export type SheetGridPasteResult = { applied: number; readOnly: number; outside: number; kept: number };
type PasteCell = { readOnly?: boolean; keepOnPaste?: boolean };

/** Writes a pasted block from (r, c) and counts what it skips; a block of more than one cell leaves a kept cell. */
export function pasteBlock<R>(block: readonly (readonly string[])[], r: number, c: number, rows: readonly R[],
  cellAt: (row: R, r: number, c: number) => PasteCell | undefined, write: (row: R, c: number, value: string) => void) {
  const result: SheetGridPasteResult = { applied: 0, readOnly: 0, outside: 0, kept: 0 };
  const many = block.length > 1 || (block[0]?.length ?? 0) > 1;
  block.forEach((line, dr) => line.forEach((v, dc) => {
    if (v.trim() === "") return;
    const row = rows[r + dr], cell = row === undefined ? undefined : cellAt(row, r + dr, c + dc);
    if (!cell) result.outside++;
    else if (cell.readOnly) result.readOnly++;
    else if (many && cell.keepOnPaste) result.kept++;
    else { write(row!, c + dc, v); result.applied++; }
  }));
  return result;
}
