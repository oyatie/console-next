// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { codeText } from "../../lib/labels";
import { catalogRefusal } from "../../lib/refusal";

export const decisionRefusalText = (code: string) =>
  catalogRefusal(code) ?? codeText(`requestOutcome.code.${code}`, t("approvals.viewer.blockedHint"));
