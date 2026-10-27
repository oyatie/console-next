// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Card } from "../../../ui/card/card";
import { GroupedQueue } from "./grouped-queue";

export const order = 402;

export default function GroupedQueueGallery() {
  const item = (id: string, extra: Partial<components["schemas"]["ActionInboxItem"]> = {}): components["schemas"]["ActionInboxItem"] => ({
    id, title: tg("search.person"), kind: "register_review", ref: "", lane: "turn", urg: "wait", dueTone: "neutral", days_remaining: null, done: false, links: [], ...extra,
  });
  return <Card title={t("home.inbox.title")}>
    <GroupedQueue items={[
      item("overdue", { due: "2026-10-25T00:00:00Z", days_remaining: -1, dueTone: "danger" }),
      item("today", { kind: "hr_exit_confirm", due: "2026-10-26T00:00:00Z", days_remaining: 0, dueTone: "danger", links: [{ kind: "exit_case", id: "gallery-exit" }] }),
      item("later", { due: "2026-11-26T00:00:00Z", days_remaining: 31 }),
      item("filing-a", { kind: "insurance_filing", fold_key: "gallery-case", links: [{ kind: "statutory", id: "gallery-case" }] }),
      item("filing-b", { kind: "insurance_filing", fold_key: "gallery-case", links: [{ kind: "statutory", id: "gallery-case" }] }),
      item("missing", { context: { register: { missing_fields: ["birth", "address"] } } }),
    ]} />
  </Card>;
}
