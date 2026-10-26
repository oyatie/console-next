// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import { isMessageId, t } from "@console/i18n";
import { announce, focusSoon } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { reasonCodesQuery, reasonOptions } from "../../../lib/reason-codes";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { Button } from "../../../ui/button/button";
import { TextInput } from "../../../ui/field/field";
import { PopoverButton } from "../../../ui/popover/popover-button";
import { Masked } from "../../../ui/record/masked";
import s from "./card.module.css";

type Props = { masked: string; field: string; who: string; reveal?: (reason: string, note: string) => Promise<{ value: string; displaySeconds: number }> };

/** A field stays closed unless its server can return an audited reveal. */
export function MaskedValue(props: Props) {
  return props.reveal ? <RevealValue {...props} reveal={props.reveal} /> : <Masked>{props.masked}</Masked>;
}

function RevealValue({ masked, field, who, reveal }: Props & { reveal: NonNullable<Props["reveal"]> }) {
  const scope = useId();
  const [why, setWhy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [shown, setShown] = useState<{ value: string; until: number } | null>(null);
  const [seconds, setSeconds] = useState(0);
  const hide = useCallback(() => {
    const ownsFocus = document.getElementById(scope)?.contains(document.activeElement);
    setShown(null);
    announce(t("empCard.reveal.remasked", { field }));
    if (ownsFocus) focusSoon(scope);
  }, [field, scope]);
  const options = reasonOptions("rrn_reveal", useQuery(reasonCodesQuery("rrn_reveal")).data?.items);
  const picked = options.find((o) => o.value === why);
  const command = useCommand({
    run: async () => {
      const result = await reveal(why!, note.trim());
      if (!Number.isFinite(result.displaySeconds) || result.displaySeconds <= 0) throw new Error("invalid_reveal_duration");
      return result;
    }, forget: true,
    onSuccess: (r) => {
      setShown({ value: r.value, until: Date.now() + r.displaySeconds * 1000 });
      setSeconds(r.displaySeconds);
      announce(t("empCard.reveal.shown", { field, seconds: r.displaySeconds }));
      focusSoon(scope);
      setWhy(null); setNote("");
    },
  });
  useEffect(() => {
    if (!shown) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const left = Math.max(0, shown.until - Date.now());
      if (!left) hide();
      else { setSeconds(Math.ceil(left / 1000)); timer = setTimeout(tick, Math.min(1000, left)); }
    };
    timer = setTimeout(tick, Math.min(1000, Math.max(0, shown.until - Date.now())));
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    document.addEventListener("keydown", escape);
    return () => { clearTimeout(timer); document.removeEventListener("keydown", escape); };
  }, [shown, hide]);
  const ready = picked && (!picked.requiresNote || note.trim());
  return (
    <span className={s.reveal} id={scope} tabIndex={-1}>
      {shown ? <code className={s.revealValue}>{shown.value}</code> : <Masked>{masked}</Masked>}
      <output role={shown ? "timer" : undefined} data-hidden={!shown || undefined} aria-hidden={!shown}>{t("empCard.reveal.remaining", { seconds })}</output>
      {shown ? <Button variant="ghost" onClick={hide}><EyeOff size={13} aria-hidden /> {t("empCard.reveal.hide")}</Button> : (
      <PopoverButton wide label={t("empCard.reveal.open", { field })} trigger={<><Eye size={13} aria-hidden />{t("empCard.reveal.show")}</>} title={<><Eye size={14} aria-hidden />{t("empCard.reveal.title", { field, who })}</>}>
        {(close) => <>
          <ReasonCodeField domain="rrn_reveal" label={t("empCard.rrn.why")} value={why} onChange={setWhy} look="chips" />
          {picked?.requiresNote && <TextInput aria-label={t("empCard.rrn.note")} placeholder={t("empCard.rrn.note")} value={note} onChange={(e) => setNote(e.target.value)} />}
          <p className={s.note}>{t("empCard.rrn.logLine", { person: who, field, reason: picked?.label ?? t("empCard.rrn.logPending") })}</p>
          <CommandError error={command.error} own={code => { const key = `empCard.reveal.error.${code}`; return isMessageId(key) ? t(key) : undefined; }} />
          <div className={s.popActs}>
            <Button variant="ghost" onClick={close}>{t("empCard.reveal.cancel")}</Button>
            <Button variant="primary" disabled={!ready || command.isPending} onClick={() => command.mutate(undefined, { onSuccess: close })}>{t("empCard.reveal.primary")}</Button>
          </div>
        </>}
      </PopoverButton>
      )}
    </span>
  );
}
