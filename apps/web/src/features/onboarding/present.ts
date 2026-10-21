import { t } from "@console/i18n";

/** Stable refusal codes with the action that lets this viewer continue. */
const OWN = ["terms_text_changed", "terms_version_already_accepted", "terms_not_published", "step_already_skipped", "step_not_skippable", "phase_not_setup", "preview_stale", "go_live_blocked"] as const;
export function onboardingError(code: string) {
  const known = OWN.find((c) => c === code);
  return known ? t(`setup.error.${known}`) : undefined;
}
