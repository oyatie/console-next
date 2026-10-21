import type { components } from "@console/api/schema";

// The Form No.16 sections' row grammar (MR-31/33): which fields one row takes, in column order, and how a typed row
// becomes the server's `fields`. Pure; the screen names each field `empCard.rec.<section>.<key>`.

type Fields = components["schemas"]["PersonRecordFields"];
export type Segment = components["schemas"]["PersonRecordSectionSegment"];
export type RowField = { key: string; kind: "text" | "date" | "month" | "choice"; options?: readonly string[]; required?: boolean };

export const ROW_SPEC: Partial<Record<Segment | "career", readonly RowField[]>> = {
  career: [
    { key: "employer_name", kind: "text", required: true },
    // The register's career period is by month (YYYY-MM; the server refuses a day).
    { key: "from", kind: "month", required: true },
    { key: "to", kind: "month" },
    { key: "position", kind: "text" },
    { key: "duty", kind: "text" },
    { key: "leave_reason", kind: "text" },
  ],
  education: [
    { key: "school", kind: "text", required: true },
    { key: "level", kind: "choice", options: ["HIGH_SCHOOL", "ASSOCIATE", "BACHELOR", "MASTER", "DOCTORATE", "OTHER"], required: true },
    { key: "major", kind: "text" },
    { key: "entered_on", kind: "date" },
    { key: "ended_on", kind: "date" },
    { key: "status", kind: "choice", options: ["GRADUATED", "EXPECTED", "ENROLLED", "ON_LEAVE", "COMPLETED", "WITHDRAWN"], required: true },
  ],
  qualification: [
    { key: "name", kind: "text", required: true },
    { key: "kind", kind: "choice", options: ["NATIONAL_TECHNICAL", "NATIONAL_PROFESSIONAL", "PRIVATE", "DRIVER_LICENSE", "FOREIGN", "OTHER"], required: true },
    { key: "issuer", kind: "text" },
    { key: "acquired_on", kind: "date" },
    { key: "expires_on", kind: "date" },
    { key: "number", kind: "text" },
  ],
  military: [
    { key: "status", kind: "choice", options: ["COMPLETED", "SERVING", "NOT_COMPLETED", "EXEMPT", "NOT_APPLICABLE"], required: true },
    { key: "branch", kind: "choice", options: ["ARMY", "NAVY", "AIR_FORCE", "MARINE_CORPS", "SOCIAL_SERVICE", "ALTERNATIVE", "OTHER"] },
    { key: "rank", kind: "text" },
    { key: "served_from", kind: "date" },
    { key: "served_to", kind: "date" },
  ],
  language: [
    { key: "language", kind: "text", required: true },
    { key: "test", kind: "text" },
    { key: "score", kind: "text" },
    { key: "taken_on", kind: "date" },
  ],
  training: [
    { key: "course", kind: "text", required: true },
    { key: "provider", kind: "text" },
    { key: "started_on", kind: "date", required: true },
    { key: "ended_on", kind: "date" },
    { key: "status", kind: "choice", options: ["COMPLETED", "IN_PROGRESS", "NOT_COMPLETED"], required: true },
  ],
  award: [
    { key: "title", kind: "text", required: true },
    { key: "decided_on", kind: "date", required: true },
    { key: "issuer", kind: "text" },
  ],
  family: [
    { key: "relation", kind: "choice", options: ["SPOUSE", "CHILD", "PARENT", "PARENT_IN_LAW", "SIBLING", "GRANDPARENT", "GRANDCHILD", "OTHER"], required: true },
    { key: "name", kind: "text", required: true },
    { key: "birth_date", kind: "date" },
  ],
};

export type RowDraft = Record<string, string>;

/** The required fields a draft still lacks (in column order): the first one gets focus. */
export const missing = (spec: readonly RowField[], d: RowDraft) => spec.filter((f) => f.required && !d[f.key]?.trim()).map((f) => f.key);

/** A typed row as the server's fields: blanks are left out, text trimmed. */
export function toFields(spec: readonly RowField[], d: RowDraft): Fields {
  const out: Record<string, string> = {};
  for (const f of spec) {
    const v = d[f.key]?.trim();
    if (v) out[f.key] = v;
  }
  return out as unknown as Fields;
}

/** The lower-case path segment of an entry's section. */
export const segmentOf = (section: string) => section.toLowerCase() as Segment;

/** An entry's stored fields as a draft its editor opens with (the inverse of toFields for the spec's keys). */
export function fromFields(spec: readonly RowField[], fields: unknown): RowDraft {
  const f = (fields ?? {}) as Record<string, unknown>;
  return Object.fromEntries(spec.filter((x) => f[x.key] != null && f[x.key] !== "").map((x) => [x.key, String(f[x.key])]));
}
