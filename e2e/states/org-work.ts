// SPDX-License-Identifier: LicenseRef-Proprietary
import { id } from "../mock/fixtures";

const states = {
  loading: "Hold the structure read; keep the page heading and close action.",
  failed: "Fail the structure read with one referenced error card.",
  refused: "Refuse the structure read; retain the heading above the shared refusal.",
  empty: "Return an empty setup structure.",
  populated: "Return a setup structure with a legal entity, workplace and departments.",
} as const;
export const orgWorkScreens = [
  { key: "org-move", path: `/org/move?ids=${id(100)}`, read: "/api/v1/org-structure", states, title: "bulkMove.title", registry: "org-move", live: "e2e/structure-dept.spec.ts" },
  { key: "org-paste", path: `/org/paste?workplace=${id(4)}`, read: "/api/v1/org-structure", states: { ...states, operating: "Offer department creation on the chart; omit the paste editor." }, title: "orgBulk.paste.title", registry: "org-paste--parse-preview-errors", live: "e2e/crud-structure.spec.ts" },
  { key: "org-import", path: "/org/import", read: "/api/v1/org-structure", states, title: "orgBulk.import.title", registry: "org-import", live: "e2e/org-import.spec.ts" },
] as const;
export type OrgWorkState = keyof typeof states | "operating";
