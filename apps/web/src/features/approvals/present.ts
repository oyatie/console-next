// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { codeText } from "../../lib/labels";
import { catalogRefusal } from "../../lib/refusal";

export const decisionRefusalText = (code: string) =>
  code === "approval_decision_unavailable" ? t("approvals.viewer.unavailable") : catalogRefusal(code) ?? codeText(`requestOutcome.code.${code}`, t("approvals.viewer.blockedHint"));
