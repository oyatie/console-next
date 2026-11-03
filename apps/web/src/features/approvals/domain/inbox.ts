// SPDX-License-Identifier: LicenseRef-Proprietary
export const APPROVAL_BOXES = ["pending", "upcoming", "requested", "reference", "completed"] as const;
export type ApprovalBox = typeof APPROVAL_BOXES[number];

export const approvalBox = (value: unknown): ApprovalBox =>
  typeof value === "string" && APPROVAL_BOXES.includes(value as ApprovalBox) ? value as ApprovalBox : "pending";
