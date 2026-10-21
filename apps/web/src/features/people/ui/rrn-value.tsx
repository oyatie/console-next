import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { reasonCodesQuery, reasonOptions } from "../../../lib/reason-codes";
import { Button } from "../../../ui/button/button";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { TextInput } from "../../../ui/field/field";
import { PopoverButton } from "../../../ui/popover/popover-button";
import { Kbd, Masked } from "../../../ui/record/record-section";
import { revealRrn } from "../api/record";
import type { Card } from "./use-card";
import { Card as Surface } from "../../../ui/card/card";
import s from "./card.module.css";

/** How long a revealed number stays on screen before it is masked again (as on the identifiers page). */
const SHOWN_MS = 60_000;

/**
 * The resident registration number on the card (E2-reveal, decisions #25): masked; "show" asks why (no default), says the access-log line
 * it leaves, and the server returns the number for that reason (and logs it). Held in memory for a minute, never cached.
 */
export function RrnValue({ c, masked }: { c: Card; masked: string }) {
  const options = reasonOptions("rrn_reveal", useQuery(reasonCodesQuery("rrn_reveal")).data?.items);
  const [why, setWhy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const picked = options.find((o) => o.value === why);
  const reveal = useCommand({ run: () => revealRrn(c.e.id, why!, note.trim()), forget: true, onSuccess: (r) => setShown(r.rrn) });
  useEffect(() => {
    if (!shown) return;
    const id = setTimeout(() => setShown(null), SHOWN_MS);
    return () => clearTimeout(id);
  }, [shown]);
  const field = t("empCard.f.rrn");
  if (shown)
    return (
      <span className={s.reveal}>
        <span className={s.num}>{shown}</span>
        <Button variant="ghost" onClick={() => setShown(null)}><EyeOff size={13} aria-hidden /> {t("empCard.reveal.hide")}</Button>
      </span>
    );
  const missing = !why ? "rrn-why" : picked?.requiresNote && !note.trim() ? "rrn-note" : null;
  return (
    <span className={s.reveal}>
      {/* The server masks with *; shown as the design's ● (decision #25: YYMMDD-d●●●●●●). */}
      <Masked>{masked.replace(/\*/g, "●")}</Masked>
      <PopoverButton link wide label={t("empCard.reveal.open", { field })} trigger={<><Eye size={13} aria-hidden />{t("empCard.reveal.show")}</>} title={<><Eye size={14} aria-hidden />{t("empCard.reveal.title", { field, who: `${c.e.name} ${c.e.employee_number ?? ""}` })}</>}>
        {(close) => (
          <>
            <ChipChoice id="rrn-why" label={t("empCard.rrn.why")} options={options} value={why} onChange={setWhy} />
            {picked?.requiresNote && <span id="rrn-note"><TextInput aria-label={t("empCard.rrn.note")} placeholder={t("empCard.rrn.note")} value={note} onChange={(e) => setNote(e.target.value)} /></span>}
            <Surface look="muted"><p className={s.logText}>{t("empCard.rrn.logLine", { person: `${c.e.name} ${c.e.employee_number ?? ""}`, reason: picked?.label ?? t("empCard.rrn.logPending") })}</p></Surface>
            <p className={s.note}>{t("empCard.rrn.rule")}</p>
            {reveal.isError && <CommandError error={reveal.error} />}
            <div className={s.popActs}>
              <Button variant="ghost" onClick={close}>{t("empCard.reveal.cancel")}</Button>
              <Button variant="primary" aria-disabled={missing ? true : undefined} onClick={() => (missing ? document.getElementById(missing)?.querySelector<HTMLElement>("input")?.focus() : reveal.mutate(undefined, { onSuccess: close }))}>
                {t("empCard.reveal.primary")} <Kbd k="Enter" />
              </Button>
            </div>
          </>
        )}
      </PopoverButton>
    </span>
  );
}
