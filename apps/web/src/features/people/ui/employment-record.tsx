import { useState } from "react";
import type { components } from "@console/api/schema";
import { ContractsCard, type ContractEdit } from "./contracts-card";
import { FactsCard } from "./facts-card";
import { LifecycleTrail } from "./lifecycle-trail";

type Employee = components["schemas"]["Employee"];

/** The hire's administrative trail, employment facts and contract history share the employee's record. */
export function EmploymentRecord({ e, editable = true, calm = false, onContract }: { e: Employee; editable?: boolean; calm?: boolean; onContract?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [contract, setContract] = useState<ContractEdit>(null);
  return (
    <>
      <LifecycleTrail employeeId={e.id} caseKind="HIRE" onRecord={editable ? (target) => { if (target === "contract") { if (onContract) onContract(); else setContract({ kind: "new" }); } else setEditing(true); } : undefined} />
      <FactsCard e={e} readOnly={!editable} calm={calm} editing={editing} onEdit={setEditing} />
      {!onContract && <ContractsCard e={e} editable={editable} open={contract} onOpen={setContract} />}
    </>
  );
}
