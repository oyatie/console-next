import { Button } from "../../../ui/button/button";
import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { Chip } from "../../../ui/chip";
import { Composer } from "../../../ui/composer/composer";
import { correctEmployee, type Correction, type CorrectionChanges } from "../api";
import { FIX_REASONS, routeOf, type FixField } from "../domain/fix";
import { currentOf, draftText, toChange, type Draft } from "./use-fix-draft";
import { FixValue } from "./fix-value";
import type { Card } from "./use-card";
import { Card as Surface } from "../../../ui/card/card";
import s from "./card.module.css";
import { Who } from "./card-who";

const FIELDS: FixField[] = ["name", "sex", "birth_date", "hire_date", "job", "employee_number"];
const TONE = { now: "ok", second: "info", act: "neutral" } as const;

/**
 * multi-field correction (E4-multi): several fields fixed against one source document, each routed by its own class (applied at
 * once, waiting for a second person, or handed to a personnel action) with one shared reason. Every field keeps its own history row.
 * department is never corrected: its row hands over to the transfer sheet.
 */
export function FixMulti({ c, onClose, onDone, onAct }: { c: Card; onClose: () => void; onDone: (out: Correction) => void; onAct: (act: string) => void }) {
  const [v, setV] = useState<Partial<Record<FixField, Draft>>>({});
  const [why, setWhy] = useState<string | null>(null);
  const changes = FIELDS.map((f) => [f, toChange(f, v[f] ?? null, c)] as const).filter(([, x]) => x);
  const merged = Object.assign({}, ...changes.map(([, x]) => x)) as CorrectionChanges;
  const counts = { now: changes.filter(([f]) => routeOf(f) === "now").length, second: changes.filter(([f]) => routeOf(f) === "second").length };
  const run = useCommand({
    run: () => correctEmployee(c.e.id, c.e.updated_at, merged, why!),
    invalidates: ["/api/v1/employees", "/api/v1/change-requests"],
    settle: true,
    onSuccess: onDone,
  });
  const missing = !changes.length ? "multi-fields" : !why ? "multi-why" : null;
  const press = () => (missing ? document.getElementById(missing)?.querySelector<HTMLElement>("input")?.focus() : run.mutate(undefined));
  return (
    <Composer
      open
      kicker={<Who c={c} />}
      title={t("empFix.multi.title", { count: changes.length })}
      onClose={onClose}
      pending={run.isPending}
      notice={run.isError && <CommandError error={run.error} />}
      consequence={
        <>
          <span><b>{t("empFix.multi.cons", counts)}</b></span>
          <span className={s.s12}>{t("empFix.multi.rule")}</span>
        </>
      }
      action={{ kind: "profile", mode: "correct", count: 1 }}
      incomplete={Boolean(missing)}
      onSubmit={press}
    >
      <Surface id="multi-fields" look="outline">
        {/* A field being changed says before → after and how it is recorded (E4-multi); the order never moves under typing. */}
        {FIELDS.map((f) => {
          const typed = toChange(f, v[f] ?? null, c);
          return (
            <div key={f} className={s.stackRow}>
              <span className={s.stackHead}>
                <b>{t(`empFix.field.${f}`)}</b>
                {typed && <Chip tone={TONE[routeOf(f)]}>{t(`empFix.multi.route.${routeOf(f)}`)}</Chip>}
                <span className={s.s12}>{t("empFix.multi.now", { value: currentOf(c, f).text })}</span>
              </span>
              {typed && <span className={s.s12}>{t("empFix.multi.change", { from: currentOf(c, f).text, to: draftText(f, v[f] ?? null, c) })}</span>}
              <FixValue c={c} field={f} value={v[f] ?? null} onChange={(x) => setV({ ...v, [f]: x })} />
            </div>
          );
        })}
        <div className={s.stackRow}>
          <span className={s.stackHead}><b>{t("empCard.f.unit")}</b><Chip>{t("empFix.multi.route.act")}</Chip><span className={s.s12}>{t("empFix.multi.unit")}</span></span>
          <Button variant="ghost" onClick={() => onAct("TRANSFER")}>{t("empFix.multi.toTransfer")}</Button>
        </div>
      </Surface>
      <div id="multi-why"><ChipChoice label={t("empFix.multi.why")} options={FIX_REASONS.map((r) => ({ value: r, label: t(`empFix.reason.${r}`) }))} value={why} onChange={setWhy} /></div>
    </Composer>
  );
}
