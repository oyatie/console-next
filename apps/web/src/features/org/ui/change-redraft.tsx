import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { landed } from "../../../lib/react/landed";
import { todayKst } from "../../../lib/pure/today";
import { ORG_READS } from "../../../reference/org/api";
import { Composer } from "../../../ui/composer/composer";
import { DateField } from "../../../ui/date/date-field";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { changeCommands, changeQuery, redraftChange, refusalOf } from "../api";
import { datePresets } from "../present";
import css from "./org-change.module.css";

type Detail = components["schemas"]["OrgChangeDetail"];

/**
 * A rejected change is not a dead end (D7): the same content becomes a new draft that names the rejected one
 * (`supersedesId`), with a date chosen again (empty, never the old one) and the old reason to rework.
 */
export function ChangeRedraft({ d, title, memo, onClose }: { d: Detail; title: string; memo?: string; onClose: () => void }) {
  const navigate = useNavigate();
  const today = todayKst();
  const [date, setDate] = useState("");
  const [reason, setReason] = useState(d.reason);
  const [tried, setTried] = useState(false);
  const dateRef = useRef<HTMLDivElement>(null);
  const redraft = useCommand({
    run: async (submit: boolean, key: string) => {
      const draft = await redraftChange(d, { effectiveDate: date, reason: reason.trim() }, key);
      if (!submit) return { id: draft.id, done: "drafted" as const };
      // Refused by preflight, the draft still exists: its page shows why (the unsent receipt).
      const reread = () => changeQuery(draft.id).queryFn().then((data) => ({ data }));
      const sent = await landed(() => changeCommands(draft.id).submit(), reread, (x) => x.status === "IN_APPROVAL").then(
        () => true,
        (e: unknown) => {
          if (refusalOf(e) === "preflight_blocked") return false;
          throw e;
        },
      );
      return { id: draft.id, done: sent ? ("redrafted" as const) : undefined, unsent: !sent || undefined };
    },
    invalidates: ORG_READS,
    onSuccess: ({ id, ...search }) => void navigate({ to: "/org/changes/$id", params: { id }, search }),
  });
  const errors = { date: tried && !date ? t("orgChange.date.required") : refusalOf(redraft.error) === "date" ? t("orgChange.date.min") : undefined, reason: tried && !reason.trim() ? t("orgChange.reason.required") : undefined };
  const press = (submit: boolean) => {
    setTried(true);
    const count = [!date, !reason.trim()].filter(Boolean).length;
    if (count === 0) return redraft.mutate(submit);
    announce(t("orgChange.errors", { count }));
    dateRef.current?.querySelector<HTMLElement>(date ? "textarea" : "input")?.focus();
  };
  return (
    <Composer title={t("orgChange.redraft")} subtitle={title} dirty={date !== "" || reason !== d.reason} onClose={onClose}
      pending={redraft.isPending} action={{ kind: "orgChange", mode: "request" }} onSubmit={() => press(true)} onSaveDraft={() => press(false)}
      consequence={t("orgChange.next.draft.consequence")}
    ><div className={css.form}>
      {memo && <blockquote className={css.quote}>{t("orgChange.rejected.memo", { memo })}</blockquote>}
      <div ref={dateRef} className={css.fix}>
        <DateField
          label={t("orgChange.date")}
          required
          value={date}
          onChange={setDate}
          today={today}
          min={today}
          basis={t("orgChange.redraft.prevDate", { date: fmtDate(d.effectiveDate) })}
          presets={datePresets(today)}
          suggestWeekday
          error={errors.date}
        />
        <Field label={t("orgChange.reason")} required error={errors.reason}>
          {(p) => <TextArea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
      <CommandError error={refusalOf(redraft.error) === "date" ? undefined : redraft.error} />
    </div></Composer>
  );
}
