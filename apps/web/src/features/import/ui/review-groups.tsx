import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { ReasonField } from "../../../ui/reason/reason-field";
import { reasonProblem, type Reason } from "../../../ui/reason/reason";
import { Card } from "../../../ui/card/card";
import { excludeReasonsQuery, EXCLUDE_REASONS, NOTE_MAX, OTHER } from "../api";
import type { ImportDryRun } from "../domain/contract";
import { GROUP_ANSWERS, isAnsweredPattern, withGroupAnswer, withGroupExclusion, type AnsweredPattern, type Picks } from "../domain/steps";
import { fieldLabel, reasonLabel, refusalLabel } from "../present";
import s from "./import.module.css";

type Group = ImportDryRun["review"]["groups"][number];

/**
 * Rows refused for the same reason, left out together (BE-MIG W05): one reason (BW-07 import_exclude) for all of them,
 * taken back the same way; a row answered on its own keeps its own answer. Nothing is left out before the press.
 */
export function ReviewGroups({ dry, picks, busy, onResolve }: { dry: ImportDryRun; picks: Picks; busy: boolean; onResolve: (c: Picks) => void }) {
  const groups = dry.review.groups;
  const answered = Object.entries(picks.group_answers ?? {}) as [AnsweredPattern, string][];
  if (groups.length === 0 && answered.length === 0) return null;
  const title = t("importReview.groups.title", { count: groups.length });
  return (
    <Card titleId="import-groups" title={title}>
      {/* r3:hire-19: a pattern answered once, for every row; taken back the same way. */}
      {answered.map(([pattern, answer]) => (
        <div key={pattern} className={`row ${s.inset}`}>
          <Chip tone="info">{t(`importReview.answer.${pattern}.${answer}` as "importReview.answer.status_conflict.pre_hire")}</Chip>
          <Button disabled={busy} onClick={() => onResolve(withGroupAnswer(picks, pattern, null))}>{t("importReview.answer.undo")}</Button>
        </div>
      ))}
      {groups.map((g) => <GroupRow key={g.key} g={g} picks={picks} busy={busy} onResolve={onResolve} />)}
    </Card>
  );
}

function GroupRow({ g, picks, busy, onResolve }: { g: Group; picks: Picks; busy: boolean; onResolve: (c: Picks) => void }) {
  const reasons = useQuery(excludeReasonsQuery);
  const held = picks.group_exclusions[g.key];
  const [reason, setReason] = useState<Reason>({ code: held?.reason_code || null, memo: held?.note ?? "" });
  const [tried, setTried] = useState(false);
  const codes = (reasons.data?.items ?? []).filter((x) => x.active).map((x) => ({ code: x.code, label: reasonLabel(EXCLUDE_REASONS, x) }));
  const label = t("importReview.groups.row", { why: refusalLabel(g.reason), field: fieldLabel(g.field), rows: g.rows });
  return (
    <div className={s.resolve} role="group" aria-label={label}>
      <div className="row">
        <b className="grow">{label}</b>
        {held ? <Chip tone="info">{t("importReview.groups.done")}</Chip> : g.blocking && <Chip tone="danger">{t("importReview.blocking")}</Chip>}
      </div>
      {isAnsweredPattern(g.reason) && (
        <div className={s.choices} role="group" aria-label={t("importReview.answer.group", { what: label })}>
          {GROUP_ANSWERS[g.reason].map((answer) => (
            <Button key={answer} variant="primary" disabled={busy} onClick={() => onResolve(withGroupAnswer(picks, g.reason as AnsweredPattern, answer))}>
              {t(`importReview.answer.${g.reason}.${answer}.run` as "importReview.answer.status_conflict.pre_hire.run", { rows: g.rows })}
            </Button>
          ))}
        </div>
      )}
      <ReasonField label={t("import.decide.reasonFor", { what: label })} codes={codes} other={OTHER} value={reason} onChange={setReason} memoMax={NOTE_MAX} showErrors={tried} />
      <div className="form__actions">
        {held && <Button disabled={busy} onClick={() => onResolve(withGroupExclusion(picks, g.key, null))}>{t("importReview.groups.undo")}</Button>}
        <Button
          variant="primary"
          aria-disabled={busy || undefined}
          onClick={() => {
            setTried(true);
            if (busy || reasonProblem(reason, OTHER)) return;
            onResolve(withGroupExclusion(picks, g.key, { reason_code: reason.code!, ...(reason.memo ? { note: reason.memo } : {}) }));
          }}
        >
          {t("importReview.groups.run", { rows: g.rows })}
        </Button>
      </div>
    </div>
  );
}
