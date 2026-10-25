import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { failureText } from "../../../lib/refusal";
import { useCommand } from "../../../lib/react/command";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { QueryState } from "../../../lib/react/query-state";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { ReasonField } from "../../../ui/reason/reason-field";
import { reasonProblem, type Reason } from "../../../ui/reason/reason";
import { Table } from "../../../ui/table";
import { ACCESS_READS, accountsQuery, applyGrants, grantsQuery, previewGrants, removeRole, rolesQuery, type AccessGrant, type AccessRole, type GrantOp } from "../api";
import { grantPerson, periodText, storedScope } from "../present";
import { PersonLabel } from "../../../reference/person/ui/person-label";
import { AccountText } from "./holder";
import { RolePick } from "./role-pick";
import { Refused, refusalsOf } from "./use-grant-batch";
import { useOrgRoots } from "./use-org-roots";
import { useReasons } from "./use-reasons";

const OTHER = "OTHER";

/** ROL-M1-roles-delete-partial: the grants were revoked, then the role's retire was refused; the role stays with 0 holders. */
class Partial extends Error {
  constructor(readonly revoked: number, readonly cause: unknown) {
    super("role_delete_partial");
  }
}

/** What retiring a held role does to its grants: each revoked, or (moving) revoked and granted again on `to` with the same scope, end and start. */
const opsFor = (live: readonly AccessGrant[], to: string | null): GrantOp[] =>
  live.flatMap((g): GrantOp[] => [
    { op: "revoke", grant_id: g.id },
    ...(to ? [{ op: "grant" as const, account_id: g.account_id, role_id: to, scope: g.scope, valid_to: g.valid_to ?? null, effective_in_setup: g.effective_in_setup }] : []),
  ]);

/**
 * Deleting a role (mockup M1). The holders come first, with their scope and period, because their grants end with the role:
 * one press revokes them (previewed, then the passkey) and retires the role, or moves every holder to another role with the
 * same scope and end first, so a held role never dead-ends in a refusal. The role stays in the record; it leaves the list.
 */
export function RoleDelete({ role, onClose, onDeleted }: { role: AccessRole | null; onClose: () => void; onDeleted: (message: string) => void }) {
  const [reason, setReason] = useState<Reason>({ code: null, memo: "" });
  const [tried, setTried] = useState(false);
  const [moving, setMoving] = useState(false);
  const [to, setTo] = useState<string | null>(null);
  const reasons = useReasons();
  const roots = useOrgRoots();
  const grants = useQuery({ ...grantsQuery({ role_id: role?.id ?? "" }), enabled: !!role });
  const accounts = useQuery(accountsQuery);
  const roles = useQuery(rolesQuery);
  const others = (roles.data?.items ?? []).filter((r) => r.id !== role?.id);
  const target = moving ? others.find((r) => r.id === to) : undefined;
  const run = useCommand({
    run: async (r: AccessRole, key: string) => {
      const live = grants.data?.items ?? [];
      const why = { reason_code: reason.code!, reason_note: reason.memo.trim() || null };
      try {
        if (live.length) {
          const p = await previewGrants({ operations: opsFor(live, target?.id ?? null), ...why });
          if (p.refused) throw new Refused(p);
          await applyGrants(p.receipt_id,key);
        }
        // A retry after a partial run finds no holder left and only retires the role.
        await removeRole(r, why).catch((e: unknown) => {
          throw live.length ? new Partial(live.length, e) : e;
        });
      } finally {
        void grants.refetch();
      }
      return r;
    },
    invalidates: ACCESS_READS,
    onSuccess: (r) => onDeleted(target ? t("access.roles.moved", { name: r.name_ko, to: target.name_ko, count: r.holder_count }) : t("access.roles.deleted", { name: r.name_ko })),
  });
  if (!role) return null;
  const n = grants.data?.items.length ?? 0;
  const close = () => (setReason({ code: null, memo: "" }), setTried(false), setMoving(false), setTo(null), onClose());
  const commit = () => (reasonProblem(reason, OTHER) || (moving && !target) ? setTried(true) : run.mutate(role));
  const refused = [...refusalsOf(run.error).values()];
  const who = (g: AccessGrant) => accounts.data?.items.find((a) => a.id === g.account_id);
  const commitText = moving ? t("access.roles.move.commit", { count: n }) : t(n ? "access.roles.delete.commit.holders" : "access.roles.delete.commit", { count: n });
  return (
    <Dialog open read title={t("access.roles.delete.title", { name: role.name_ko })} onClose={close}>
      <QueryState q={grants}>
        {(d) =>
          d.items.length ? (
            <>
              <Banner tone="danger">{t("access.roles.delete.holders", { count: d.items.length })}</Banner>
              <Table
                label={t("access.roles.delete.holders.table")}
                rows={d.items}
                rowId={(g) => g.id}
                columns={[
                  { header: t("access.col.holder"), cell: (g) => { const a = who(g); return a ? <AccountText a={a} peers={accounts.data?.items} /> : <PersonLabel person={grantPerson(g, accounts.data?.items ?? [])} peers={accounts.data?.items} />; } },
                  { header: t("access.col.scope"), cell: (g) => storedScope(g.scope, roots) },
                  { header: t("access.col.until"), fit: true, cell: (g) => periodText(g) },
                ]}
              />
            </>
          ) : (
            <p className="muted">{t("access.roles.delete.none")}</p>
          )
        }
      </QueryState>
      {moving && <RolePick roles={others} value={to} onChange={setTo} label={t("access.roles.move.to")} error={tried && !target ? t("access.roles.move.missing") : undefined} />}
      <ReasonField label={t("access.roles.delete.reason")} codes={reasons.codes} other={OTHER} value={reason} onChange={setReason} memoMax={200} showErrors={tried} />
      <ActionBar
        notice={
          run.error instanceof Partial ? (
            <Banner tone="warn" live="assertive">
              {t("accessGrants.roleDelete.partial", { revoked: run.error.revoked })} · {t("accessGrants.roleDelete.partial.why", { reason: failureText(run.error.cause) })}{" "}
              <Button size="sm" onClick={() => run.mutate(role)} disabled={run.isPending}>{t("accessGrants.roleDelete.retry")}</Button>
            </Banner>
          ) : refused.length > 0 ? <Banner tone="danger" live="assertive">{refused.join(" · ")}</Banner> : <PasskeyError error={run.error} />
        }
        consequence={
          target ? t("access.roles.move.consequence", { name: role.name_ko, to: target.name_ko, count: n })
          : t(n ? "access.roles.delete.consequence.holders" : "access.roles.delete.consequence", { name: role.name_ko, count: n })
        }
        actions={
          <>
            <Button variant="ghost" onClick={close}>{t("access.cancel")}</Button>
            {n > 0 && others.length > 0 && <Button onClick={() => (setMoving(!moving), setTo(null))}>{t(moving ? "access.roles.move.back" : "access.roles.move")}</Button>}
            <Button variant={moving ? "primary" : "danger"} disabled={run.isPending || grants.isPending} onClick={commit}>{commitText}</Button>
          </>
        }
      />
    </Dialog>
  );
}
