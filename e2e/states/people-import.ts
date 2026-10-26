// SPDX-License-Identifier: LicenseRef-Proprietary
export const peopleImportScreens = [{
  key: "people-import", path: "/people/import", read: "/api/v1/legal-entities",
  registry: "people-import--upload", live: "e2e/import/any-layout.spec.ts",
  states: {
    loading: "Hold legal entities; other reference reads succeed.",
    "entities-failed": "Legal entities return 503.",
    "numbers-failed": "Employee number rules return 503.",
    "reasons-failed": "Import exclusion reasons return 503.",
    refused: "Legal entities return the server's 403 refusal.",
    empty: "All references loaded; no recent runs.",
    populated: "All references loaded; one recent run.",
    "token-refresh-failed": "A reference read answers 401, then token renewal answers 503.",
  },
}] as const;
export type PeopleImportState = keyof typeof peopleImportScreens[number]["states"];
