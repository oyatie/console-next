import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { BindingEvidence } from "./binding-evidence";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Field, TextInput } from "../../../ui/field/field";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { PersonLabel } from "../../../reference/person/ui/person-label";
import { personOption } from "../../../reference/person/ui/person-option";
import { personLabel } from "../../../reference/person/present";
import { personBindingReviewsQuery, resolveIdentity, samePersonQuery, type Resolution } from "../api";
import { Composer } from "../../../ui/composer/composer";
import s from "./lifecycle.module.css";

type Detail = components["schemas"]["EmployeeDetail"];
const REASON_MAX = 100;

/**
 * Settles an identity review (BW-18): either these are different people (the flag clears), or this record is the
 * same person as another one, which it is merged into. A merge is irreversible, so it asks for the user's passkey
 * bound to this record and the record kept, and waits for a second person when one exists.
 */
export function IdentitySheet({ d, onClose, onDone }: { d: Detail; onClose: () => void; onDone: (out: Resolution) => void }) {
  const e = d.employee;
  const evidence = useQuery(personBindingReviewsQuery(e.id));
  const [verdict, setVerdict] = useState<"SAME" | "DIFFERENT" | null>(null);
  const [query, setQuery] = useState(e.name);
  const [keep, setKeep] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const found = useQuery({ ...samePersonQuery(query), enabled: verdict === "SAME" && query.trim().length > 0 });
  const others = (found.data?.items ?? []).filter((x) => x.id !== e.id);
  const missing = { verdict: !verdict, keep: verdict === "SAME" && !keep, reason: !reason.trim() };
  const count = Object.values(missing).filter(Boolean).length;
  const run = useCommand({
    run: () => resolveIdentity(e.id, { verdict: verdict!, keep: verdict === "SAME" ? keep! : undefined, reason: reason.trim() }),
    invalidates: ["/api/v1/employees", "/api/v1/change-requests", "/api/v1/person-binding-reviews"],
    onSuccess: onDone,
  });
  const kept = others.find((x) => x.id === keep);
  const cancelled = run.error instanceof Error && run.error.message === "passkey_cancelled";
  return (
    <Composer
      title={t("identity.title", { name: e.name })}
      subtitle={[e.employee_number, e.org_unit, e.hire_date && fmtDate(e.hire_date)].filter(Boolean).join(" · ")}
      onClose={onClose}
      pending={run.isPending}
      notice={cancelled ? <p className={s.changed} role="alert">{t("identity.passkeyCancelled")}</p> : run.isError && <CommandError error={run.error} />}
      consequence={<span>{verdict === "SAME" ? t("identity.same.consequence", { name: e.name, keep: kept ? personLabel(kept, others).text : t("identity.keep.placeholder") }) : verdict === "DIFFERENT" ? t("identity.different.consequence", { name: e.name }) : t("identity.none.consequence")}</span>}
      action={{ kind: verdict === "SAME" ? "identityMerge" : "identityDifferent", mode: "apply", count: 1 }}
      tone={verdict === "SAME" ? "danger" : "primary"}
      missing={tried ? count : 0}
      onSubmit={() => {
        setTried(true);
        if (count > 0) return false;
        run.mutate(undefined);
      }}
    >
      {evidence.isPending ? <QueryState q={evidence} layout="form">{() => null}</QueryState> : <>
      <p>{t("identity.fact")}</p>
      <BindingEvidence subjectId={e.id} employeeId={e.id} />
      <ChoiceField
        label={t("identity.verdict")}
        required
        options={[
          { value: "DIFFERENT", label: t("identity.different"), description: t("identity.different.note") },
          { value: "SAME", label: t("identity.same"), description: t("identity.same.note") },
        ]}
        value={verdict}
        onChange={(x) => (run.reset(), setVerdict(x as "SAME" | "DIFFERENT"))}
        error={tried && missing.verdict ? t("identity.verdict.missing") : undefined}
      />
      {verdict === "SAME" && (
        <>
          <ServerPicker
            label={t("identity.keep")}
            isRequired
            query={query}
            onQueryChange={setQuery}
            loading={found.isFetching}
            options={others.map((x) => ({ ...personOption(x, others), context: x.hire_date && fmtDate(x.hire_date) }))}
            value={keep}
            onChange={(id) => (run.reset(), setKeep(id))}
            group={t("identity.keep.group")}
            empty={t("identity.keep.none")}
          />
          {kept && <PersonLabel person={{ ...kept, employee_id: kept.id }} peers={others} />}
          {tried && missing.keep && <p className={s.error}>{t("identity.keep.missing")}</p>}
        </>
      )}
      <Field label={t("profile.reason")} required hint={t("lifecycle.reason.count", { count: reason.length, max: REASON_MAX })} error={tried && missing.reason ? t("lifecycle.reason.missing") : undefined}>
        {(p) => <TextInput {...p} value={reason} maxLength={REASON_MAX} onChange={(x) => (run.reset(), setReason(x.target.value))} />}
      </Field>
      </>}
    </Composer>
  );
}
