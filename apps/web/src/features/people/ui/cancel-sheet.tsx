import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { UserX } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button, Check } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Composer } from "../../../ui/composer/composer";
import { ownRefusal, refusalText } from "../../../reference/crud/present";
import { CANCEL_REASONS, cancelRegistration, endOptionsQuery } from "../api";
import { whoLine } from "../present";

type Employee = components["schemas"]["Employee"];

/**
 * registration cancel (`?act=cancel` on the record; CRUD): only for a registration nobody worked under — the server's end-options read
 * says so before anything is asked. Refused (an exit case, an applied appointment, attendance or payroll), the sheet says why and
 * offers exit instead, never a dead end. During setup it is the setup delete (personal data destroyed, employee number freed); after
 * go-live the governed void (attested, the record kept hidden with its employee number).
 */
export function CancelHost({ e, act, onClose, onAct }: { e: Employee; act?: string; onClose: () => void; onAct: (act: string) => void }) {
  if (act !== "cancel") return null;
  return <CancelSheet e={e} onClose={onClose} onAct={onAct} />;
}

function CancelSheet({ e, onClose, onAct }: { e: Employee; onClose: () => void; onAct: (act: string) => void }) {
  const q = useQuery({ ...endOptionsQuery(e.id), refetchOnMount: "always" });
  const navigate = useNavigate();
  const [why, setWhy] = useState<string | null>(null);
  const [attest, setAttest] = useState(false);
  const [kept, setKept] = useState(false);
  const run = useCommand({
    run: () => cancelRegistration(e.id, q.data!, why!, attest, kept),
    invalidates: ["/api/v1/employees", "/api/v1/org-structure", "/api/v1/hr/exit-cases"],
    announce: () => t("crud.person.cancelled", { name: e.name }),
    onSuccess: (out) => void (out.status === "PENDING" ? onClose() : navigate({ to: "/people", search: {} })),
  });
  const o = q.data;
  // The sheet opens once the server has answered, so its actions land with it (no shift under the pointer).
  const missing = !o ? null : !why ? "cancel-why" : o.attestation_required && !attest ? "cancel-attest" : o.register_confirmation_required && !kept ? "cancel-kept" : null;
  const ready = o?.cancel.allowed && o.can_cancel;
  return (
    <Composer
      commitId="crud-person-cancel"
      kicker={<><UserX size={14} aria-hidden />{whoLine(e)}</>}
      title={t("crud.person.cancelTitle", { name: e.name })}
      subtitle={o ? t(o.cancel_route === "DELETE" ? "crud.person.cancelSetup" : "crud.person.cancelOperating") : undefined}
      onClose={onClose}
      pending={run.isPending}
      notice={<CommandError error={run.error} own={ownRefusal} />}
      consequence={<span>{ready ? t(o!.cancel_route === "DELETE" ? "crud.person.cancelConsequenceSetup" : "crud.person.cancelConsequence", { name: e.name }) : t("crud.person.cancelNo")}</span>}
      action={{ kind: "registration", mode: o?.cancel_route === "DELETE" ? "remove" : "cancel", count: 1 }}
      tone="danger"
      incomplete={Boolean(missing)}
      onSubmit={() => { if (ready) { if (missing) document.getElementById(missing)?.querySelector<HTMLElement>("input")?.focus(); else run.mutate(undefined); } }}
      blocked={!ready ? { reason: t("crud.person.cancelNo") } : undefined}
      secondary={!ready && o?.exit.allowed && <Button id="crud-person-exit-instead" onClick={() => onAct("exit.report")}>{t("crud.person.exitInstead")}</Button>}

    >
      <QueryState q={q}>
        {(read) =>
          !read.cancel.allowed || !read.can_cancel ? (
            <p role="status">{read.can_cancel ? refusalText(read.cancel.refusal) : t("crud.noPermission")}</p>
          ) : (
            <>
              <div id="cancel-why">
                <ChoiceField
                  label={t("crud.person.cancelWhy")}
                  required
                  value={why}
                  onChange={setWhy}
                  options={CANCEL_REASONS.map((r) => ({ value: r, label: t(`crud.person.reason.${r}`) }))}
                />
              </div>
              {read.attestation_required && <div id="cancel-attest"><Check checked={attest} onChange={setAttest}>{read.void_basis === "ATTESTED_WITHIN_WINDOW" && read.recorded_hire_date && read.recorded_hire_date < todayKst() ? t("crud.person.attestRecorded", { date: fmtDate(read.recorded_hire_date) }) : t("crud.person.attest")}</Check></div>}
              {read.register_confirmation_required && <div id="cancel-kept"><Check checked={kept} onChange={setKept}>{t("crud.person.registerKept")}</Check></div>}
            </>
          )
        }
      </QueryState>
    </Composer>
  );
}
