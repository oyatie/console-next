export const EXPORT_PURPOSES = ["AUDIT_RESPONSE", "INTERNAL_REVIEW", "DISPUTE_RESPONSE", "DATA_SUBJECT_REQUEST", "OTHER"] as const;
export type ExportPurpose = (typeof EXPORT_PURPOSES)[number];
