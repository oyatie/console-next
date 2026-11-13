// SPDX-License-Identifier: LicenseRef-Proprietary
export const enAccountLinkRefusals = {
  "account_link.refuse.review_ineligible": "An independent person with account management permission must review this binding.",
  "account_link.refuse.review_stale": "This binding has changed or this decision has already been recorded. Refresh and check the current binding.",
  "account_link.refuse.solo_ineligible": "You can link your own account only while you are the sole eligible operator and your account is unlinked. Ask another account manager to link it.",
  "account_link.refuse.employee_taken": "This employee is already linked to another account. Choose another employee.",
  "account_link.refuse.identity_unbound": "The requester or decider identity could not be verified. Ask someone with account management permission to link the account to its personnel record or complete its identity review.",
} as const;
