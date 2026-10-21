import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { reasonCodesQuery, useNeedsNote } from "../../../lib/reason-codes";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { NOTE_MAX, revealRrn, rrnQuery } from "../api";
import { identifiersError } from "../present";

const DOMAIN = "rrn_reveal";
/** How long a revealed number stays on screen before it is masked again. */
const SHOWN_MS = 60_000;

/**
 * The resident registration number (decisions #25): masked (birth date and the gender digit) by default; the whole
 * number only after a reason is recorded (the access log names the reason, never the number). The revealed number is
 * held in this card's memory only, never in a cache, the URL or storage, and is masked again after a minute.
 */
export function RrnCard({ employeeId }: { employeeId: string }) {
  const status = useQuery(rrnQuery(employeeId));
  // The reasons are read with the card, so the form opens whole instead of growing under the pointer.
  useQuery(reasonCodesQuery(DOMAIN));
  const [shown, setShown] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const needsNote = useNeedsNote(DOMAIN, reason);
  const reveal = useCommand({
    run: () => revealRrn(employeeId, { code: reason!, note: note.trim() }),
    forget: true,
    onSuccess: (r) => (setShown(r.rrn), setAsking(false), setReason(null), setNote("")),
  });
  useEffect(() => {
    if (!shown) return;
    const id = setTimeout(() => setShown(null), SHOWN_MS);
    return () => clearTimeout(id);
  }, [shown]);
  const s = status.data;
  const problem = !reason ? t("identifiers.rrn.needReason") : needsNote && !note.trim() ? t("identifiers.rrn.needNote") : null;
  const go = t("identifiers.rrn.reveal");
  return (
    <Card
      title={t("identifiers.rrn.title")}
      meta={<span className="code" aria-live="polite">{shown ?? (s?.recorded ? s.masked : t("identifiers.rrn.none"))}</span>}
      tools={
        <>
          {s?.recorded && !shown && !asking && <Button onClick={() => setAsking(true)}>{t("identifiers.rrn.ask")}</Button>}
          {shown && <Button onClick={() => setShown(null)}>{t("identifiers.rrn.hide")}</Button>}
        </>
      }
    >
      <p className="muted">
        {s?.recorded && s.recorded_at ? t("identifiers.rrn.recorded", { at: fmtDateTime(s.recorded_at), source: t(`identifiers.rrn.source.${s.source ?? "IMPORT"}`) }) : t("identifiers.rrn.why")}
      </p>
      {asking && (
        <div className="form">
          <ReasonCodeField domain={DOMAIN} label={t("identifiers.rrn.reason")} value={reason} onChange={setReason} hint={t("identifiers.rrn.reasonHint")} />
          {needsNote && (
            <Field label={t("identifiers.rrn.note")} required>
              {(p) => <TextArea {...p} value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} />}
            </Field>
          )}
          <ActionBar
            actions={
              <>
                <Button onClick={() => setAsking(false)}>{t("identifiers.cancel")}</Button>
                {problem ? (
                  <DisabledReason control={(p) => <Button {...p} variant="primary">{go}</Button>} reason={problem} />
                ) : (
                  <Button variant="primary" disabled={reveal.isPending} onClick={() => reveal.mutate(undefined)}>{go}</Button>
                )}
              </>
            }
          />
          <CommandError error={reveal.error} own={identifiersError} />
        </div>
      )}
    </Card>
  );
}
