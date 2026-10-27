// A minimal .xlsx reader (the org sheet import, S7, and any other sheet read in the browser): the file is read in the browser and only the mapped
// columns reach the server. Native only: the zip directory by hand, DecompressionStream("deflate-raw") for the
// parts, and the cell XML by pattern. Text values only (numbers as typed; dates as their serial, which the
// org sheet never needs).
// regex over SpreadsheetML — fine for the cell/shared-string shapes Excel and LibreOffice write;
// switch to a DOM parse if a producer with namespaced prefixes (x:c) shows up.

export type Sheet = { name: string; rows: string[][] };

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Every file of the zip by name, read lazily. Throws on a file that is not a zip. */
function entries(zip: Uint8Array): Map<string, () => Promise<string>> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (u32(zip, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not_xlsx");
  const out = new Map<string, () => Promise<string>>();
  const dec = new TextDecoder();
  let p = u32(zip, eocd + 16);
  for (let n = u16(zip, eocd + 10); n > 0; n--) {
    if (u32(zip, p) !== 0x02014b50) throw new Error("not_xlsx");
    const method = u16(zip, p + 10), size = u32(zip, p + 20), nameLen = u16(zip, p + 28), extra = u16(zip, p + 30), comment = u16(zip, p + 32);
    const local = u32(zip, p + 42);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
    const raw = zip.subarray(start, start + size);
    out.set(name, async () => dec.decode(method === 0 ? raw : await inflate(raw)));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

const unescape = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e.toLowerCase()]!,
  );
/** The text of every <t> inside a fragment (rich text runs joined). */
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1]!)).join("");
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
/** "BC12" → column index 54 (0-based). */
const colOf = (ref: string) => [...ref.replace(/\d+$/, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** Every sheet of the workbook with its rows of text cells (row and column gaps kept as empty strings). */
export async function readXlsx(file: ArrayBuffer): Promise<Sheet[]> {
  const zip = entries(new Uint8Array(file));
  const read = async (path: string) => (await zip.get(path)?.()) ?? "";
  const shared = [...(await read("xl/sharedStrings.xml")).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!));
  const rels = new Map([...(await read("xl/_rels/workbook.xml.rels")).matchAll(/<Relationship\s[^>]*>/g)].map((m) => [attr(m[0], "Id")!, attr(m[0], "Target")!]));
  const sheets: Sheet[] = [];
  for (const m of (await read("xl/workbook.xml")).matchAll(/<sheet\s[^>]*>/g)) {
    const target = rels.get(attr(m[0], "r:id") ?? "") ?? "";
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    const rows: string[][] = [];
    for (const r of (await read(path)).matchAll(/<row\s([^>]*)>([\s\S]*?)<\/row>/g)) {
      const at = Number(attr(` ${r[1]}`, "r")) - 1;
      const row: string[] = [];
      for (const c of r[2]!.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = ` ${c[1]}`, body = c[2] ?? "";
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        const type = attr(tag, "t");
        const text = type === "s" ? (shared[Number(v)] ?? "") : type === "inlineStr" ? texts(body) : v !== undefined ? unescape(v) : "";
        row[colOf(attr(tag, "r") ?? "A1")] = text;
      }
      rows[at] = Array.from(row, (x) => x ?? "");
    }
    sheets.push({ name: unescape(attr(m[0], "name") ?? ""), rows: Array.from(rows, (x) => x ?? []) });
  }
  return sheets;
}

export { readDelimited } from "./pure/sheet-text";

/** BOM-declared Unicode, otherwise strict UTF-8 then CP949 (the platform's euc-kr label). */
export function decodeSheetText(bytes: Uint8Array | ArrayBuffer): { text: string; encoding: string } {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const bom = data[0] === 0xff && data[1] === 0xfe ? "utf-16le"
    : data[0] === 0xfe && data[1] === 0xff ? "utf-16be"
    : data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? "utf-8" : undefined;
  const decode = (encoding: string) => ({ text: new TextDecoder(encoding, { fatal: true }).decode(data), encoding });
  if (bom) return decode(bom);
  try {
    return decode("utf-8");
  } catch {
    return decode("euc-kr");
  }
}
