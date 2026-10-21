// What a chosen file is, from its first bytes, so a protected workbook gets its own answer before any upload.
// An .xlsx is a zip; Office password encryption and most DRM wrappers store it inside an OLE compound file instead,
// which no reader can open without the key. The server checks again (error code workbook_encrypted).

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export type WorkbookKind = "xlsx" | "protected" | "unreadable";

const startsWith = (bytes: Uint8Array, magic: readonly number[]) => bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);

export function workbookKind(head: Uint8Array): WorkbookKind {
  if (startsWith(head, ZIP)) return "xlsx";
  if (startsWith(head, OLE)) return "protected";
  return "unreadable";
}

/** How many leading bytes `workbookKind` reads. */
export const HEAD_BYTES = OLE.length;
