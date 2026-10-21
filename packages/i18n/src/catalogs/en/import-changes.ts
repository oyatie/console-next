import type { koImportChanges } from "../ko/import-changes";

export const enImportChanges: Record<keyof typeof koImportChanges, string> = {
  "importChanges.title": "Changed cells {cells, number} · people {people, number}",
  "importChanges.changed": "Changed {n, number}",
  "importChanges.same": "As is {n, number}",
  "importChanges.open": "To select {n, number}",
  "importChanges.col.number": "Employee no.",
  "importChanges.col.name": "Name",
  "importChanges.col.field": "Field",
  "importChanges.col.now": "Now",
  "importChanges.col.file": "File",
  "importChanges.col.record": "Recorded as",
  "importChanges.correction": "Correction",
  "importChanges.route": "via {route}",
};
