// SPDX-License-Identifier: LicenseRef-Proprietary
const states = {
  loading: "Hold the primary read; supporting reads succeed.",
  failed: "Return the common 503 envelope on every primary-read attempt.",
  empty: "Return zero setup records, retaining unmet go-live prerequisites.",
  refused: "Return the common 403 envelope; access facts and granters succeed.",
} as const;

export const onboardingScreens = [
  { key: "setup-go-live", path: "/setup/go-live", read: "/api/v1/onboarding/go-live/preview", destination: "/setup/go-live", states },
  { key: "setup-company-names", path: "/setup/company-names", read: "/api/v1/legal-entities", destination: "/org?tab=entities", states },
  { key: "setup-org", path: "/setup/org", read: "/api/v1/org-structure", destination: "/org", states },
] as const;
export type OnboardingScreen = (typeof onboardingScreens)[number];
export type OnboardingState = keyof typeof states;
