import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { peopleRefusal } from "../present";
import { branchesQuery } from "../../../reference/org/api";
import { assignmentsRef, entitiesRef } from "../../../reference/entity/api";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { ConflictPanel, type ConflictChoice } from "../../../ui/conflict/field-conflict";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { assignHomeBranch, employeeQuery, isStale } from "../api";
import { Muted } from "../../../ui/muted/muted";

type Employee = components["schemas"]["Employee"];

/** Above this many branches the choice is a search picker, not a list (ui/choice). */
const LIST_MAX = 15;

/**
 * The home branch (attendance and leave routing). The current one is a fact; a new one is chosen from
 * the open branches, none preselected. If someone changed the employee meanwhile (409), the record is
 * re-read and the user keeps their pick or takes the current value.
 */
export function HomeBranchCard({ e, manage }: { e: Employee; manage: boolean }) {
  const branches = useQuery(branchesQuery);
  const detail = useQuery(employeeQuery(e.id));
  const assignments = useQuery(assignmentsRef(e.id));
  const entities = useQuery(entitiesRef);
  const today = todayKst();
  const workplace = assignments.data?.items.find((a) => a.valid_from <= today && (!a.valid_to || a.valid_to > today))?.workplace_id;
  const requiredBranch = entities.data?.items.flatMap((entity) => entity.workplaces).find((w) => w.id === workplace)?.default_branch_id;
  const open = assignments.isSuccess && entities.isSuccess ? branches.data?.filter((b) => !b.deactivated_at && b.id !== e.home_branch_id && (!requiredBranch || b.id === requiredBranch)) ?? [] : [];
  const [branch, setBranch] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stale, setStale] = useState<string | null>(null);
  const [choice, setChoice] = useState<ConflictChoice>();
  const name = (id: string | null) => branches.data?.find((b) => b.id === id)?.name ?? "";
  const assign = useCommand({
    run: (id: string) => assignHomeBranch(e.id, id, e.updated_at),
    invalidates: ["/api/v1/employees"],
    onSuccess: () => {
      setBranch(null);
      setStale(null);
      setChoice(undefined);
    },
    announce: (_, id) => t("people.homeBranch.assigned", { branch: name(id) }),
  });
  const commit = (id: string) =>
    assign.mutate(id, {
      onError: (err) => {
        if (!isStale(err)) return;
        setStale(id);
        setChoice(undefined);
        void detail.refetch();
      },
    });
  const current = e.home_branch_name ? <span>{t("person.homeBranch.current", { branch: e.home_branch_name })}</span> : <Chip tone="warn">{t("person.homeBranch.missing")}</Chip>;
  return (
    <section className="card panel" aria-labelledby="home-branch">
      <h2 id="home-branch" className="panel__title">{t("people.homeBranch.title")}</h2>
      <div className="row">{current}</div>
      {manage && branches.isSuccess && branches.data.every((b) => b.deactivated_at) && (
        <>
          <Muted>{t("people.homeBranch.none")}</Muted>
          <div className="row">
            <Link className="btn" to="/org/entities">{t("people.homeBranch.createBranch")}</Link>
          </div>
        </>
      )}
      {manage && stale && (
        <ConflictPanel
          kind="stale_facts"
          conflicts={[{ field: "home_branch", label: t("people.homeBranch.title"), mine: name(stale), current: e.home_branch_name, at: fmtDateTime(e.updated_at) }]}
          choices={{ home_branch: choice }}
          onChoose={(_, c) => {
            setChoice(c);
            if (c === "theirs") {
              setStale(null);
              setBranch(null);
              assign.reset();
            }
          }}
        />
      )}
      {manage && !stale && open.length > 0 && (
        open.length <= LIST_MAX ? (
          <ChoiceField label={t("people.homeBranch.branch")} required options={open.map((b) => ({ value: b.id, label: b.name }))} value={branch} onChange={setBranch} />
        ) : (
          <ServerPicker
            label={t("people.homeBranch.branch")}
            group={t("people.homeBranch.branch")}
            query={query}
            onQueryChange={setQuery}
            // the branch list is read whole (one request), so it is filtered here; search on the server if it grows past a page.
            options={open.filter((b) => query.trim() !== "" && b.name.includes(query.trim())).map((b) => ({ id: b.id, name: b.name }))}
            value={branch}
            onChange={setBranch}
            empty={t("person.homeBranch.none")}
            isRequired
          />
        )
      )}
      {manage && open.some((b) => b.id === (stale ?? branch)) && (stale ? choice === "mine" : branch) && (
        <div className="row">
          <Button variant="primary" disabled={assign.isPending} onClick={() => commit(stale ?? branch!)}>{t("person.homeBranch.assign", { branch: name(stale ?? branch) })}</Button>
        </div>
      )}
      <CommandError error={stale ? null : assign.error} own={peopleRefusal} />
    </section>
  );
}
