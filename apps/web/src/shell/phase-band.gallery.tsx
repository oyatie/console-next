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
  const [receipt, setReceipt] = useState(true);
  return <PageHeadingLevel value={2}><Section title={tg("section.pageHead")}>
    <div data-phase-example="loading"><PageHead title={t("common.loading")} /><PhaseSlot loading /></div>
    <div data-phase-example="setup"><PageHead title={t("shell.phase.setup")} />
      <PhaseSlot phase="setup" text={`${t("shell.phase.setup")} · ${t("setup.step.entity")}`} />
    </div>
    <div data-phase-example="receipt"><PageHead title={t("setup.receipt.started.title")} />
      <PhaseSlot phase={receipt ? "started" : undefined} dismiss={() => setReceipt(false)} />
    </div>
  </Section></PageHeadingLevel>;
}
