// What the typed business registration number and dates already say about the certificate (worst-case-25, company-37). Pure: the
// widely used check digit (no primary source: a mismatch is held for a second look, never refused outright) and
// cross-field consistency read from the number itself.
import type { BizKind } from "@console/api/pending";
import { bizRegNoChecksumOk, FORMATS } from "../../../lib/pure/formats";

/** The fields these checks read; `brnConfirmed` is the number the user said is printed as typed. */
export type BrnFacts = { brn: string; brnConfirmed: string; bizKind: BizKind | null; openedOn: string; incorporatedOn: string };

/** Complete and its check digit does not match. */
export const brnChecksumOff = (brn: string) => brn.length === FORMATS.bizRegNo.max && !bizRegNoChecksumOk(brn);
/** Held: the check digit does not match and the user has not said the certificate prints it so. */
export const brnNeedsLook = (d: Pick<BrnFacts, "brn" | "brnConfirmed">) => brnChecksumOff(d.brn) && d.brnConfirmed !== d.brn;

/** NTS classes are supplied by the versioned reference endpoint, never inferred from literals. */
export type BrnClass = { code: string; biz_kinds?: readonly string[] };
export function kindsOfBrn(brn: string, classes: readonly BrnClass[] = []): readonly string[] {
  if (brn.length !== FORMATS.bizRegNo.max) return [];
  const mid = Number(brn.slice(3, 5));
  const row = classes.find((r) => {
    const [start, end = start] = r.code.split("-");
    return Number(start) <= mid && mid <= Number(end);
  });
  return row?.biz_kinds ?? [];
}

export type BrnWarning = "kindMismatch" | "openedBeforeIncorporated";
/** Soft signals: the number reads as another kind; a corporation opened business before it was incorporated. */
export function brnWarnings(d: BrnFacts, classes: readonly BrnClass[] = []): BrnWarning[] {
  const out: BrnWarning[] = [];
  const kinds = kindsOfBrn(d.brn, classes);
  if (kinds.length && d.bizKind && !kinds.includes(d.bizKind)) out.push("kindMismatch");
  if (d.bizKind === "CORPORATION" && d.openedOn && d.incorporatedOn && d.openedOn < d.incorporatedOn) out.push("openedBeforeIncorporated");
  return out;
}
