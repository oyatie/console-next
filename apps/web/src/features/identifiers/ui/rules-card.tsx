import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Table } from "../../../ui/table";
import { removeRule, rulesQuery, setRule } from "../api";
import { ruleOf, scopeKey, type Scope } from "../domain/numbering";
import { identifiersError } from "../present";
import { RuleForm } from "./rule-form";

/**
 * The numbering rule of each scope and the number it would give next (a preview: nothing is reserved). A scope with
 * no rule follows the one above it; with none at all the server numbers E- and six digits.
 */
export function RulesCard({ scopes }: { scopes: readonly Scope[] }) {
  const rules = useQuery(rulesQuery);
  const [open, setOpen] = useState<string | null>(null);
  const save = useCommand({
    run: (r: { scope: Scope; prefix: string; width: number }) => setRule({ scope_kind: r.scope.kind, ...(r.scope.id ? { scope_id: r.scope.id } : {}), prefix: r.prefix, width: r.width }),
    invalidates: ["/api/v1/employee-number-rules"],
    announce: (r) => t("identifiers.rules.saved", { next: r.next_number }),
    onSuccess: () => setOpen(null),
  });
  const remove = useCommand({
    run: (s: Scope) => removeRule(s.kind, s.id),
    invalidates: ["/api/v1/employee-number-rules"],
    announce: () => t("identifiers.rules.removed"),
  });
  const all = rules.data ?? [];
  const current = scopes.find((s) => scopeKey(s) === open);
  const title = t("identifiers.rules.title");
  return (
    <Card title={title}>
      <Table
        label={title}
        rows={[...scopes]}
        rowId={scopeKey}
        columns={[
          { header: t("identifiers.rules.col.scope"), cell: (s) => s.label },
          { header: t("identifiers.rules.col.rule"), cell: (s) => { const r = ruleOf(all, s); return r ? <span className="code">{t("identifiers.rules.rule", { prefix: r.prefix || "—", width: r.width })}</span> : <span className="muted">{t("identifiers.rules.inherit")}</span>; } },
          { header: t("identifiers.rules.col.next"), cell: (s) => <span className="code">{ruleOf(all, s)?.next_number ?? "—"}</span>, fit: true },
          {
            header: t("identifiers.rules.col.act"),
            fit: true,
            cell: (s) => (
              <span className="row">
                <Button aria-expanded={open === scopeKey(s)} onClick={() => setOpen(open === scopeKey(s) ? null : scopeKey(s))}>{t(ruleOf(all, s) ? "identifiers.rules.edit" : "identifiers.rules.set", { scope: s.label })}</Button>
                {ruleOf(all, s) && <Button disabled={remove.isPending} onClick={() => remove.mutate(s)}>{t("identifiers.rules.remove", { scope: s.label })}</Button>}
              </span>
            ),
          },
        ]}
      />
      <CommandError error={save.error ?? remove.error} own={identifiersError} />
      {current && (
        <RuleForm
          key={scopeKey(current)}
          scope={current}
          rule={ruleOf(all, current)}
          busy={save.isPending}
          onSave={(prefix, width) => save.mutate({ scope: current, prefix, width })}
          onCancel={() => setOpen(null)}
        />
      )}
    </Card>
  );
}
