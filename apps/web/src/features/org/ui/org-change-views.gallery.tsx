// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { OrgChangeViews } from "./org-change-views";
import { Section } from "../../../gallery/Section";

export const order = 153;
const totals = { open: 2, mine: 3, approval: 0, ready: 1, done: 1, closed: 0, all: 3 };
export default function OrgChangeViewsGallery() {
  return <Section title={t("orgChange.list.title")}>
    <div role="group" aria-label={t("orgChange.list.views")}><OrgChangeViews className="row" view="open" routed={false} totals={totals} failed={false} redrafts={0} onPick={() => {}} /></div>
    <div role="group" aria-label={t("orgChange.list.views")}><OrgChangeViews className="row" view="open" routed={false} failed={false} redrafts={undefined} unavailable={t("common.loading")} onPick={() => {}} /></div>
    <div role="group" aria-label={t("orgChange.list.views")}><OrgChangeViews className="row" view="all" routed={false} failed redrafts={0} onPick={() => {}} /></div>
  </Section>;
}
