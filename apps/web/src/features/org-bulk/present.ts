// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { CHANGE_MODE, ORG_CHANGE_KIND, ORG_HISTORY_ACTION, labeled } from "../../lib/labels";
import type { FeedRow } from "./domain/feed";

export const historyActions = (row: FeedRow) => row.kind === "UNDO"
  ? t("orgHistory.kind.UNDO")
  : row.actions?.length ? row.actions.map(action => labeled(ORG_HISTORY_ACTION, action).label).join(" · ") : t("orgHistory.kind.APPLY");

export function historyKind(row: FeedRow): string {
  if (row.source === "change") return t("orgHistory.kind.change", { action: labeled(ORG_CHANGE_KIND, row.change!.kind ?? "").label });
  if (row.registration) return t(row.registration === "legal_entity.create" ? "orgHistory.kind.entityRegistration" : "orgHistory.kind.workplaceRegistration");
  return t(`orgHistory.kind.${row.source}`, { actions: historyActions(row) });
}

export const historyMode = (row: FeedRow) => row.mode ? labeled(CHANGE_MODE, row.mode).label : t("orgHistory.how.unknown");
