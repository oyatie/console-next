import { useState } from "react";
import type { components } from "@console/api/schema";
import { ContractsCard, type ContractEdit } from "./contracts-card";
import { FactsCard } from "./facts-card";
import { LifecycleTrail } from "./lifecycle-trail";

type Employee = components["schemas"]["Employee"];

/** The hire's administrative trail, employment facts and contract history share the employee's record. */
export function EmploymentRecord({ e, onContract }: { e: Employee; onContract?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [contract, setContract] = useState<ContractEdit>(null);
  return (
    <>
      <LifecycleTrail employeeId={e.id} caseKind="HIRE" onRecord={(target) => { if (target === "contract") { if (onContract) onContract(); else setContract({ kind: "new" }); } else setEditing(true); }} />
      <FactsCard e={e} editing={editing} onEdit={setEditing} />
      {!onContract && <ContractsCard e={e} open={contract} onOpen={setContract} />}
    </>
  );
}
