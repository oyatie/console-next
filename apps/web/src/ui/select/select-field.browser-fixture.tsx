// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { loadCatalog, t } from "@console/i18n";
import { Button, Form } from "../button/button";
import { Dialog } from "../dialog";
import { SelectField } from "./select-field";
import "../../app.css";

await loadCatalog("ko");
const which = new URLSearchParams(location.search).get("case");
const RESOLUTIONS = [{ id: "COMPLETE", label: t("statutory.complete") }, { id: "NOT_APPLICABLE", label: t("statutory.notApplicable") }, { id: "ASSESS", label: t("statutory.assess") }];
// Names typed with no space and no hyphen, 60 syllables and 64 letters: neither has a point where a line may break.
const UNBROKEN = { label: t("statutory.notApplicable").replace(/\s/g, "").repeat(20), description: "Unbroken".repeat(8) };
// The shape of a loss-code option: a code, a long label and a hold mark in one line.
const CODES = [
  { id: "11", label: "11 · Voluntary resignation for personal reasons such as relocation or study · Legal review pending" },
  { id: "23", label: "23 · Dismissal for managerial reasons, recommended resignation or workforce reduction" },
  { id: "32", label: "32 · End of the contract term or completion of the construction work", description: "Counted from the day after the last working day" },
  { id: "41", ...UNBROKEN },
];

/** The picks of the filing completion dialog: nothing chosen, checked when the form is committed, cleared by a pick. */
function Filing() {
  const [action, setAction] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  return <Dialog open read title="Record a filing" onClose={() => {}}>
    <Form className="form" noValidate onSubmit={() => setTried(true)}>
      <SelectField label={t("statutory.resolution")} placeholder={t("statutory.pickResolution")} value={action} onChange={setAction} options={RESOLUTIONS}
        error={tried && !action ? t("statutory.requiredResolution") : undefined} />
      <SelectField label={t("statutory.lossCode")} placeholder={t("statutory.pickCode")} value={code} onChange={setCode} options={CODES}
        error={tried && !code ? t("statutory.requiredCode") : undefined} />
      <div className="row"><Button type="submit" variant="primary">{t("statutory.preview")}</Button></div>
    </Form>
  </Dialog>;
}

/** A filter in a toolbar row: the label is hidden and the trigger is only as wide as its text. */
function Filter() {
  const [value, setValue] = useState("ALL");
  return <main><div className="row" role="group" aria-label="Filters">
    <SelectField hideLabel label="Source" placeholder="All sources" value={value} onChange={setValue} options={[{ id: "ALL", label: "All sources" }, { id: "LEAVE", label: "Leave" }]} />
  </div></main>;
}

export const Fixture = () => (which === "filter" ? <Filter /> : <Filing />);
createRoot(document.getElementById("root")!).render(<Fixture />);
