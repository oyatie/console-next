// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { DecisionPane } from "./decision-pane";

export const order = 93;

/** Side-by-side approval decision area with optional comment on approve and required comment on reject or return. */
export default function DecisionPaneGallery() {
  const [opinion, setOpinion] = useState("");
  const [lastOutcome, setLastOutcome] = useState("");

  return (
    <section className="card gallery__section" data-decision-pane-gallery="" data-outcome={lastOutcome}>
      <h2 className="toolbar__title">{t("uiWorklist.approve")}</h2>
      <DecisionPane
        opinion={opinion}
        onOpinionChange={setOpinion}
        onApprove={() => setLastOutcome("approved")}
        onReject={() => setLastOutcome("rejected")}
        onReturn={() => setLastOutcome("returned")}
      />
    </section>
  );
}
