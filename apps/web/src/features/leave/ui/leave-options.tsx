// SPDX-License-Identifier: LicenseRef-Proprietary
import { Check } from "lucide-react";
import { t } from "@console/i18n";
import type { LeaveOptionKind, LeaveSpanMode } from "../domain/leave-form";

const marked = <T extends string>(items: readonly { id: T; label: string }[], chosen: T) =>
  items.map((item) => ({ ...item, icon: chosen === item.id ? <Check size={14} aria-hidden="true" /> : undefined }));

/** The leave kinds an employee files, the chosen one checked. */
export const leaveKindItems = (kind: LeaveOptionKind) => marked<LeaveOptionKind>([
  { id: "annual", label: t("leave.type.annual") },
  { id: "half_am", label: t("leave.type.halfAm") },
  { id: "half_pm", label: t("leave.type.halfPm") },
], kind);

/** One day or several, the chosen one checked. */
export const leaveSpanItems = (spanMode: LeaveSpanMode) => marked<LeaveSpanMode>([
  { id: "one", label: t("leave.date.oneDay") },
  { id: "multi", label: t("leave.date.multiDay") },
], spanMode);
