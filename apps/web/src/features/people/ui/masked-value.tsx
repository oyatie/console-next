import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { PopoverButton } from "../../../ui/popover/popover-button";
import { Masked } from "../../../ui/record/record-section";
import s from "./card.module.css";

const REASONS = ["LEGAL_FILING", "SELF_REQUEST", "CORRECTION", "DISPUTE", "OTHER"] as const;

/**
 * A masked value and its "show" (E2-reveal): a reveal asks why first (no default). The server already sends this value
 * to this reader, so it opens on screen; the reveal log is not served yet (POST /reveals, backend-followups EMP-UI),
 * which the panel says instead of implying the reason was kept. The correction sheet stays offered beside it.
 */
export function MaskedValue({ masked, value, field, who, onAlternative }: { masked: string; value: string; field: string; who: string; onAlternative?: () => void }) {
  const [why, setWhy] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  if (shown)
    return (
      <span className={s.reveal}>
        <span>{value}</span>
        <Button variant="ghost" onClick={() => setShown(false)}><EyeOff size={13} aria-hidden /> {t("empCard.reveal.hide")}</Button>
      </span>
    );
  return (
    <span className={s.reveal}>
      <Masked>{masked}</Masked>
      <PopoverButton
        link
        label={t("empCard.reveal.open", { field })}
        trigger={<><Eye size={13} aria-hidden />{t("empCard.reveal.show")}</>}
        title={<><Eye size={14} aria-hidden />{t("empCard.reveal.title", { field, who })}</>}
      >
        {(close) => (
          <>
            <ChipChoice id="reveal-why" label={t("empCard.reveal.why")} options={REASONS.map((r) => ({ value: r, label: t(`empCard.reveal.reason.${r}`) }))} value={why} onChange={setWhy} />
            <p className={s.note}>{t("empCard.reveal.unserved")}</p>
            <div className={s.popActs}>
              <Button variant="ghost" onClick={close}>{t("empCard.reveal.cancel")}</Button>
              {onAlternative && <Button onClick={() => (close(), onAlternative())}>{t("empCard.reveal.alternative")}</Button>}
              <Button variant="primary" aria-disabled={why ? undefined : true} onClick={() => (why ? (close(), setShown(true)) : document.getElementById("reveal-why")?.querySelector<HTMLElement>("input")?.focus())}>{t("empCard.reveal.primary")}</Button>
            </div>
          </>
        )}
      </PopoverButton>
    </span>
  );
}
