// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Section } from "../gallery/Section";
import { PageHead } from "../ui/page-head/page-head";
import { PageHeadingLevel } from "../ui/page/page-scope";
import { PhaseSlot } from "./phase-band";

export const order = 128;

export default function PhaseBandGallery() {
  const [failed, setFailed] = useState(true);
  const [receipt, setReceipt] = useState(true);
  return <PageHeadingLevel value={2}><Section title={tg("section.pageHead")}>
    <div data-phase-example="loading"><PageHead title={t("common.loading")} /><PhaseSlot loading /></div>
    <div data-phase-example="failed">
      <PageHead title={t("setup.phase.checklistFailed")} />
      <PhaseSlot loading={false} phase="operating" text={t("setup.phase.operating")}
        fault={failed ? { text: `${t("setup.phase.checklistFailed")} ${t("common.read.failedReason")}`, retry: () => setFailed(false) } : undefined} />
    </div>
    <div data-phase-example="receipt"><PageHead title={t("setup.phase.started.title")} />
      <PhaseSlot loading={false} phase="operating" text={t("setup.phase.operating")} dismiss={receipt ? () => setReceipt(false) : undefined} />
    </div>
  </Section></PageHeadingLevel>;
}
