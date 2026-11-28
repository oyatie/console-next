// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";

export const risk = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const frameworkKinds = ["LEGAL_BASELINE", "INTERNAL_CONTROL", "CUSTOMER_CONTROL", "SECURITY_STANDARD", "SAFETY_STANDARD", "AUDIT_PROGRAM"] as const;
export const controlTypes = ["PREVENTIVE", "DETECTIVE", "CORRECTIVE", "DIRECTIVE", "COMPENSATING"] as const;
export const obligationTypes = ["LEGAL", "REGULATORY", "CONTRACTUAL", "INTERNAL_POLICY", "CONTROL_REQUIREMENT"] as const;
export const relationships = ["DERIVED_FROM", "AMENDED_BY", "SUPERSEDED_BY", "INTERPRETS", "EVIDENCES"] as const;
export const coverage = ["PRIMARY", "PARTIAL", "SUPPORTING", "COMPENSATING"] as const;
const states = ["DRAFT", "ACTIVE", "RETIRED", "ARCHIVED", "WAIVED", "SUPERSEDED"] as const;
type Code = typeof risk[number] | typeof frameworkKinds[number] | typeof controlTypes[number] | typeof obligationTypes[number] | typeof relationships[number] | typeof coverage[number] | typeof states[number];
export const complianceCode = (code: Code) => t(`compliance.code.${code}`);
