import type { koCapture } from "../ko/capture";

export const enCapture: Record<keyof typeof koCapture, string> = {
  "capture.headcount.label": "Regular headcount",
  "capture.headcount.value": "{count, number}",
  "capture.headcount.held": "Not computed yet",
  "capture.headcount.hold": "Before labor attorney review",
  "capture.headcount.live": "Employed now: {count, number} (the regular headcount is computed separately under the Enforcement Decree of the Labor Standards Act art. 7-2)",
  "capture.headcount.missing": "Needed to compute it:",
  "capture.headcount.missing.labor_attorney_review": "labor attorney review",
  "capture.headcount.missing.statutory_rule_rows": "statutory thresholds",
  "capture.headcount.missing.operating_day_calendar": "operating-day calendar",
  "capture.list.ksic": "Korean Standard Industrial Classification",
  "capture.list.insurance_branch": "NHIS branch office",
  "capture.list.admin_region": "administrative district",
  "capture.field.nhisOffice": "NHIS branch office",
  "capture.field.district": "Administrative district",
  "capture.docs.col.original": "Original",
  "capture.docs.open": "Open",
  "capture.docs.openLabel": "Open the original of {file}",
  "capture.list.brn_classification": "Registration number classification",
  "capture.list.workplace_not_registered_reason": "Reason for exemption from business registration",
};
