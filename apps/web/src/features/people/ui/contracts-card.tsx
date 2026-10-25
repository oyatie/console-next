import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { CONTRACT_KIND, PAY_UNIT, label } from "../../../lib/labels";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import type { Contract } from "../domain/facts";
import { contractsQuery } from "../api";
import { ContractForm } from "./contract-form";

type Employee = components["schemas"]["Employee"];
/** Which form is open: a new contract, or a correction of one row. */
export type ContractEdit = { kind: "new" } | { kind: "correct"; id: string } | null;

/**
 * The contract history (EMP-MODEL G1), newest start first, the row in force marked. Rows are never edited: a
 * correction is a new row, and the corrected one leaves the live history (shown on request, marked corrected).
 */
export function ContractsCard({ e, open, onOpen, editable = true }: { e: Employee; editable?: boolean; open: ContractEdit; onOpen: (edit: ContractEdit) => void }) {
  const list = useQuery(contractsQuery(e.id));
  const [old, setOld] = useState(false);
  return (
    <section className="card panel" aria-labelledby="contracts">
      <h2 id="contracts" className="panel__title" tabIndex={-1}>{t("facts.contracts.title")}</h2>
      <QueryState q={list}>
        {({ items }) => {
          const live = items.filter((c) => !c.superseded_by);
          const corrected = items.length - live.length;
          const fixing = open?.kind === "correct" ? items.find((c) => c.id === open.id) : undefined;
          if (open && editable) return <ContractForm key={fixing?.id ?? "new"} employeeId={e.id} name={e.name} of={fixing} onClose={() => onOpen(null)} onCorrect={(id) => onOpen({ kind: "correct", id })} />;
          return (
            <>
              {live.length === 0 && <p className="muted">{t("facts.contracts.empty")}</p>}
              <ul className="form" aria-label={t("facts.contracts.title")}>
                {(old ? items : live).map((c) => <Row key={c.id} c={c} onCorrect={!editable || c.superseded_by ? undefined : () => onOpen({ kind: "correct", id: c.id })} />)}
              </ul>
              <div className="row">
                {editable && <Button variant={live.length ? "secondary" : "primary"} onClick={() => onOpen({ kind: "new" })}>{t("facts.contracts.record")}</Button>}
                {corrected > 0 && (
                  <Button variant="ghost" aria-expanded={old} onClick={() => setOld(!old)}>
                    {old ? t("facts.contracts.hideSuperseded") : t("facts.contracts.showSuperseded", { count: corrected })}
                  </Button>
                )}
              </div>
            </>
          );
        }}
      </QueryState>
    </section>
  );
}

function Row({ c, onCorrect }: { c: Contract; onCorrect?: () => void }) {
  const end = c.end_date ? fmtDate(c.end_date) : t("facts.contracts.openEnd");
  return (
    <li className="row">
      <span>{label(CONTRACT_KIND, c.kind)}</span>
      {c.in_force && <Chip tone="ok">{t("facts.contracts.inForce")}</Chip>}
      {c.supersedes_id && <Chip tone="info">{t("facts.contracts.supersedes")}</Chip>}
      {c.superseded_by && <Chip tone="neutral">{t("facts.contracts.superseded")}</Chip>}
      <span className="num muted">{t("facts.contracts.period", { start: fmtDate(c.start_date), end })}</span>
      <span className="num">{t("facts.contracts.wage", { unit: label(PAY_UNIT, c.pay_unit), amount: fmtNumber(c.wage_won) })}</span>
      {c.weekly_minutes != null && <span className="num muted">{t("facts.contracts.weekly", { hours: c.weekly_minutes / 60 })}</span>}
      {onCorrect && <Button variant="ghost" onClick={onCorrect}>{t("facts.contracts.correct")}</Button>}
    </li>
  );
}
