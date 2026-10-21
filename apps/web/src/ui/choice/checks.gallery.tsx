import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Checks } from "./checks";

export const order = 111;

const ITEMS = (["korean_labor_law_ack", "payroll_cutoff_ack"] as const).map((k) => ({ id: k, label: t(`people.lifecycle.ack.change.${k}`) }));

export default function ChecksGallery() {
  const [fresh, setFresh] = useState<string[]>([]);
  const [tried, setTried] = useState<string[]>([ITEMS[0]!.id]);
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.checks")}</h2>
      <div className="grid-3">
        <Checks label={t("lifecycle.signoffs")} items={ITEMS} value={fresh} onChange={setFresh} />
        <Checks label={t("lifecycle.signoffs")} items={ITEMS} value={tried} onChange={setTried} error={tried.length < ITEMS.length ? t("lifecycle.signoffs.missing") : undefined} />
        <Checks label={t("lifecycle.signoffs")} items={ITEMS} value={ITEMS.map((i) => i.id)} onChange={() => {}} isDisabled />
      </div>
    </section>
  );
}
