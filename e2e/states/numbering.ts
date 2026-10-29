// SPDX-License-Identifier: LicenseRef-Proprietary
const states = {
  operating: "After go-live, replace bulk renumbering with the one-person path and no controls.",
  setup: "Keep the SETUP renumber form, preview, apply and undo.",
  "phase-loading": "Hold the phase read; show the shared loading state without assuming either phase.",
  "phase-500": "Fail the phase read; offer the shared retry and recover from a fresh server answer.",
} as const;
export const numberingScreens = [
  { key: "numbering", path: "/people/numbering", read: "/api/v1/onboarding/checklist", states, registry: "people-numbering--numbering-rules-card-operating", live: "e2e/import/identifiers.spec.ts" },
] as const;
export type NumberingState = keyof typeof states;
