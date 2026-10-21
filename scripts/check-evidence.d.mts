// SPDX-License-Identifier: LicenseRef-Proprietary
/** Validate untrusted Playwright output and quarantine metadata; every problem is a refusal. */
export function checkEvidence(report: unknown, quarantine: unknown, now?: Date): string[];
