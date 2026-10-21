import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { CHECKLIST_ITEM, CHECKLIST_STATE, labeled, label } from "../../../lib/labels";
import { focusSoon } from "../../../lib/react/announce";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { checklistQuery } from "../api";
import { ContractsCard, type ContractEdit } from "./contracts-card";
import { FactsCard } from "./facts-card";
import { Muted } from "../../../ui/muted/muted";

type Employee = components["schemas"]["Employee"];

/**
 * The employment record's three cards (EMP-MODEL): what is still missing for this hire, the facts, and the contract
 * history. A missing item opens the form that records it, so the checklist is never a dead end.
 */
export function EmploymentRecord({ e, onContract }: { e: Employee; onContract?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [contract, setContract] = useState<ContractEdit>(null);
  const fix = (item: string) => {
    if (item === "CONTRACT_RECORDED") {
      // Mounted in the personnel card, the contract history is its own section: the item opens the form there.
      if (onContract) return onContract();
      setContract({ kind: "new" });
      focusSoon("contracts");
    } else {
      setEditing(true);
      focusSoon("facts");
    }
  };
  return (
    <>
      {e.status !== "EXITED" && <Onboarding id={e.id} onFix={fix} />}
      <FactsCard e={e} editing={editing} onEdit={setEditing} />
      {!onContract && <ContractsCard e={e} open={contract} onOpen={setContract} />}
    </>
  );
}

/** Items the server derives from recorded facts, never ticked here (#3); what it cannot track yet says so. */
function Onboarding({ id, onFix }: { id: string; onFix: (item: string) => void }) {
  const list = useQuery(checklistQuery(id));
  return (
    <section className="card panel" aria-labelledby="onboarding">
      <h2 id="onboarding" className="panel__title">{t("facts.checklist.title")}</h2>
      <QueryState q={list}>
        {({ items }) => (
          <>
            <p className="muted num">{t("facts.checklist.done", { done: items.filter((i) => i.state === "DONE").length, total: items.length })}</p>
            <ul className="form">
              {items.map((i) => {
                const s = labeled(CHECKLIST_STATE, i.state);
                const name = label(CHECKLIST_ITEM, i.item);
                return (
                  <li key={i.item} className="row">
                    <Chip tone={s.tone}>{s.label}</Chip>
                    <span>{name}</span>
                    {(i.state === "OPEN" || i.state === "FOLLOW_UP") && (
                      <Button variant="ghost" aria-label={`${name} ${t("facts.checklist.fix")}`} onClick={() => onFix(i.item)}>{t("facts.checklist.fix")}</Button>
                    )}
                    {i.state === "NOT_TRACKED" && <Muted>{t("facts.checklist.notTracked")}</Muted>}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </QueryState>
    </section>
  );
}
