import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { todayKst } from "../../../lib/pure/today";
import { inOrder } from "../../../lib/pure/in-order";
import { Banner } from "../../../ui/banner/banner";
import { Button, ToggleButton } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { SearchField } from "../../../ui/search/search-field";
import { LongTable, type LongColumn } from "../../../ui/long-table/long-table";
import { NO_SELECTION, type Selection } from "../../../ui/long-table/selection";
import { SelectField } from "../../../ui/select/select-field";
import { orgStructureRef } from "../../../reference/entity/api";
import { grantOp, missing, ready, blankLine, type DraftLine } from "../domain/grants";
import { flatten, type OrgNode } from "../domain/scope";
import { ACCESS_READS, applyGrants, previewGrants, type AccessGrantPreview, type Account, type Batch } from "../api";
import { scopeLabel } from "../present";
import { AccessHead } from "./access-head";
import { BulkForm, type BulkDraft } from "./bulk-form";
import { BulkPreview } from "./bulk-preview";
import { ScopeSheet } from "./scope-picker";
import { useAccessContext } from "./use-access-context";
import s from "./access.module.css";

const ALL = "*";

/**
 * bulk grant (mockup M5): pick accounts from the list (namesakes marked and told apart by employee number and placement), one
 * role, scope and end for all, then the server's per-person preview, then one passkey applies all or none. A refused person
 * can be dropped and the rest previewed again, so a batch never dead-ends. Ops and the actor are not offered.
 */
export function BulkPage() {
  const ctx = useAccessContext();
  const tree = useQuery(orgStructureRef);
  const today = todayKst();
  const [sel, setSel] = useState<Selection>(NO_SELECTION);
  const [find, setFind] = useState("");
  const [unit, setUnit] = useState(ALL);
  const [withPasskey, setWithPasskey] = useState(false);
  const [d, setD] = useState<BulkDraft>({ line: blankLine(crypto.randomUUID()), when: null, reason: { code: null, memo: "" } });
  const [tried, setTried] = useState(false);
  const [picking, setPicking] = useState(false);
  const [preview, setPreview] = useState<{ p: AccessGrantPreview; ids: string[] } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const offered = ctx.accounts.filter((a) => a.is_active && a.id !== ctx.ops && a.id !== ctx.me);
  const names = offered.map((a) => a.display_name);
  const namesake = (a: Account) => names.indexOf(a.display_name) !== names.lastIndexOf(a.display_name);
  const roots = (tree.data?.entities ?? []) as OrgNode[];
  // The chart's order (one order for every list and picker); a name the tree does not hold follows, by name.
  const units = inOrder([...new Set(offered.map((a) => a.employee_org_unit).filter((u): u is string => !!u))].sort(), flatten(roots).map((r) => r.node.name));
  const term = find.trim().toLowerCase();
  const rows = offered.filter(
    (a) =>
      (!term || a.display_name.toLowerCase().includes(term) || (a.employee_number ?? "").toLowerCase().includes(term)) &&
      (unit === ALL || a.employee_org_unit === unit) &&
      (!withPasskey || a.has_passkey),
  );
  const ids = sel.kind === "ids" ? [...sel.ids] : [];
  const batch = (who: string[], line: DraftLine): Batch => ({
    operations: ready(line) ? who.map((id) => grantOp(id, line, ctx.setup && d.when === "SETUP")) : [],
    reason_code: d.reason.code!,
    reason_note: d.reason.memo.trim() || null,
  });
  const check = useCommand({ run: (who: string[]) => previewGrants(batch(who, d.line)), onSuccess: (p, who) => setPreview({ p, ids: who }) });
  const apply = useCommand({
    run: (_: undefined, key: string) => applyGrants(preview!.p.receipt_id,key),
    invalidates: ACCESS_READS,
    onSuccess: (out) => (setDone(t("access.bulk.done", { count: out.items.length })), setPreview(null), setSel(NO_SELECTION)),
  });
  const gaps = missing(d.line, [d.line], today);
  const bad = !ids.length || gaps.length > 0 || (ctx.setup && !d.when) || !d.reason.code || (d.reason.code === "OTHER" && !d.reason.memo.trim());
  const columns: LongColumn<Account>[] = [
    { id: "name", header: t("access.col.name"), rowHeader: true, cell: (a: Account) => <span className={s.chips}>{a.display_name}{namesake(a) && <Chip>{t("access.bulk.namesake")}</Chip>}</span> },
    { id: "no", header: t("access.col.number"), width: 120, cell: (a: Account) => a.employee_number ?? "" },
    { id: "org", header: t("access.col.placement"), width: "2fr", cell: (a: Account) => [a.employee_company, a.employee_org_unit].filter(Boolean).join(" · ") },
    { id: "pk", header: t("access.col.passkey"), width: 96, cell: (a: Account) => <Chip tone={a.has_passkey ? "ok" : "neutral"}>{t(a.has_passkey ? "access.account.passkey.yes" : "access.account.passkey.no")}</Chip> },
  ];
  const role = ctx.roles.find((r) => r.id === d.line.role_id);
  return (
    <div className="page">
      <AccessHead />
      <div className={s.titleRow}>
        <h2 className="page__title">{t(preview ? "access.bulk.title.preview" : "access.bulk.title")}</h2>
      </div>
      {done && <Banner live="polite">{done}{apply.data?.operation_id && <Link to="/requests/$id" params={{id:apply.data.operation_id}}>{t("requestOutcome.open")}</Link>}</Banner>}
      {preview ? (
        <BulkPreview
          preview={preview.p}
          accounts={ctx.accounts}
          role={role?.name_ko ?? ""}
          scope={d.line.scope ? scopeLabel(roots, d.line.scope) : ""}
          end={d.line.end ?? ""}
          pending={apply.isPending || check.isPending}
          error={<PasskeyError error={apply.error ?? check.error} />}
          onBack={() => setPreview(null)}
          onDropRefused={() => {
            const keep = preview.ids.filter((_, i) => !preview.p.items.some((it) => it.index === i && it.outcome === "REFUSED"));
            setSel({ kind: "ids", ids: new Set(keep) });
            check.mutate(keep);
          }}
          onApply={() => apply.mutate(undefined)}
        />
      ) : (
        <div className={s.editor}>
          <Card flush>
            {/* One toolbar (mockup M5): find by name or number, narrow by placement, or to people who can sign in. */}
            <div className={s.filters}>
              <SearchField label={t("access.bulk.find")} value={find} onChange={setFind} />
              {units.length > 0 && (
                <SelectField label={t("access.bulk.unit")} hideLabel required={false} options={[{ id: ALL, label: t("access.bulk.unit.all") }, ...units.map((u) => ({ id: u, label: u }))]} value={unit} onChange={setUnit} placeholder={t("access.bulk.unit.all")} />
              )}
              <ToggleButton size="sm" pressed={withPasskey} onClick={() => setWithPasskey(!withPasskey)}>{t("access.bulk.withPasskey")}</ToggleButton>
            </div>
            <LongTable
              label={t("access.bulk.pick")}
              caption={t("accounts.count", { count: offered.length })}
              columns={columns}
              rows={rows}
              rowId={(a) => a.id}
              hasMore={false}
              onLoadMore={() => {}}
              loading={ctx.accountsQ.isPending}
              empty={<EmptyState title={t("access.bulk.empty")} reason={t("access.bulk.empty.reason")} />}
              selection={sel}
              onSelectionChange={(next) => setSel(next.kind === "ids" ? next : { kind: "ids", ids: new Set(rows.map((a) => a.id)) })}
              countUnit="person"
            />
          </Card>
          {ctx.cat.data && (
            <BulkForm roles={ctx.roles} setup={ctx.setup} today={today} value={d} onChange={setD} tried={tried} gaps={gaps} picked={ids.length} onPickScope={() => setPicking(true)}>
              <PasskeyError error={check.error} />
              <Button variant="primary" className={s.wide} disabled={check.isPending} onClick={() => (bad ? setTried(true) : check.mutate(ids))}>{t("access.bulk.preview", { count: ids.length })}</Button>
            </BulkForm>
          )}
        </div>
      )}
      {picking && ctx.cat.data && (
        <ScopeSheet
          rules={ctx.cat.data.scope_kinds}
          value={d.line.scope}
          subtitle={t("access.bulk.scopeFor", { count: ids.length })}
          onDone={(scope) => (setD({ ...d, line: { ...d.line, scope } }), setPicking(false))}
          onCancel={() => setPicking(false)}
        />
      )}
    </div>
  );
}
