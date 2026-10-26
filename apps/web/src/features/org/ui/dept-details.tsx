import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { get } from "../../../lib/query";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { useFocusInside } from "../../../lib/react/use-focus-inside";
import { STRUCTURE_READS } from "../../../reference/org/api";
import type { Node } from "../../../reference/org/domain/structure";
import { Composer } from "../../../ui/composer/composer";
import { Button } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { PersonLabel } from "../../../reference/person/ui/person-label";
import { personOption } from "../../../reference/person/ui/person-option";
import { ownRefusal } from "../../../reference/crud/present";
import { appointHead } from "../api";
import css from "../../../reference/org/ui/structure.module.css";

/** The code rule the server checks (the org change's): 1–30 letters, digits, '.', '_' or '-'. */
const CODE = /^[A-Za-z0-9._-]{1,30}$/;
const LIVE: ("ACTIVE" | "ON_LEAVE")[] = ["ACTIVE", "ON_LEAVE"];

/**
 * A department's head and code (G5, D19; CRUD: in either phase): both sent as their full new values, applied at once — in
 * setup undoable, after go-live recorded as a governed change while the tenant does not route org changes (else 409
 * org_change_routed, said in words). The head is anyone who has not left; someone from another unit keeps their placement
 * and is shown as concurrent. The unit's own members are offered first; typing searches everyone.
 */
export function DeptDetails({ node, onDone, appoint = false }: { node: Node; onDone: () => void; appoint?: boolean }) {
  const [code, setCode] = useState(node.code ?? "");
  const [head, setHead] = useState<string | null>(node.head?.employee_id ?? null);
  const [query, setQuery] = useState("");
  const box = useFocusInside<HTMLDivElement>();
  const q = query.trim();
  const people = useQuery(get("/api/v1/employees", { params: { query: q ? { search: q, status: LIVE, limit: 20 } : { org_unit_id: node.id, status: LIVE, limit: 20 } } }));
  const peers = people.data?.items ?? [];
  const selected = peers.find((p) => p.id === head);
  const options = peers.map((e) => ({
    ...personOption(e, peers),
    context: e.org_unit_id === node.id ? e.org_unit ?? undefined : t("orgUnit.head.otherUnit", { unit: e.org_unit ?? "—" }),
  }));
  if (node.head && !options.some((o) => o.id === node.head!.employee_id)) options.unshift({ ...personOption({ id: node.head.employee_id, name: node.head.name }, peers), context: t("orgUnit.head.current") });
  const v = code.trim();
  const bad = v !== "" && !CODE.test(v);
  const same = v === (node.code ?? "") && head === (node.head?.employee_id ?? null);
  const save = useCommand({
    run: (_: undefined, key: string) => appointHead(key, node.id, head, { expected_version: node.version ?? 1, code: v || null }),
    invalidates: STRUCTURE_READS,
    awaitFirstRead: true,
    announce: () => t("orgUnit.details.done", { name: node.name }),
    onSuccess: onDone,
  });
  return (
    <Composer kicker={appoint ? node.name : undefined} title={t(appoint ? "structure.head.appoint" : "orgUnit.details.title")} layout={appoint ? "drawer" : "inline"} headingLevel={appoint ? 2 : 3} action={{ kind: "orgDetails", mode: "change", count: 1 }} pending={save.isPending} onClose={onDone} blocked={same ? { reason: t("orgChange.edit.nothing") } : undefined} consequence={appoint && head && t("structure.head.effective", { date: fmtDate(todayKst()) })} onSubmit={() => { if (!bad && !same) save.mutate(undefined); }}>
      <div ref={box} className={css.stack}>
        <ServerPicker
          label={t("orgUnit.fact.head")}
          query={query}
          onQueryChange={setQuery}
          options={options}
          value={head}
          onChange={setHead}
          group={t(q ? "orgUnit.head.found" : "orgUnit.head.members")}
          loading={people.isPending}
          empty={t("orgUnit.head.none")}
        />
        {head && <PersonLabel person={{ ...selected, id: head, employee_id: head, name: selected?.name ?? (node.head?.employee_id === head ? node.head.name : undefined) }} peers={peers} />}
        {head && <Button variant="ghost" className="btn--sm" onClick={() => setHead(null)}>{t("orgUnit.head.clear")}</Button>}
        {!appoint && <Field label={t("orgUnit.fact.code")} required={null} hint={t("orgUnit.code.hint")} error={bad ? t("orgUnit.code.invalid") : undefined}>
          {(p) => <TextInput {...p} maxLength={30} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onDone()} />}
        </Field>}
        <CommandError error={save.error} own={ownRefusal} />
      </div>
    </Composer>
  );
}
