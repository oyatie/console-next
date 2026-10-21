import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { EMPLOYEE_STATUS, EMPLOYMENT_TYPE, label, labeled } from "../../../lib/labels";
import { editable } from "../../../ui/long-table/row-keys";
import { KeyMap } from "../../../ui/palette/key-map";
import { Palette, type PaletteSection } from "../../../ui/palette/palette";
import { Kbd } from "../../../ui/record/record-section";
import { employeeQuery, samePersonQuery } from "../api";
import { numberMatchQuery } from "../api/record";
import { KEY_GROUPS } from "../domain/keys";
import { tx } from "../present";

/**
 * ⌘K (find and go) and ? (the key map) on the people screens (E1-jump, E1-jump-empty, E1-keys). The search reads only
 * the reader's own scope, so an out-of-scope person never shows, not even as a count; masked values are never searched.
 * People with the same name keep it exactly as written and are told apart by employee number, placement, employment type and status on the row.
 */
export function PeopleJump() {
  const navigate = useNavigate();
  const [open, setOpen] = useState<"jump" | "keys" | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        // On the people screens ⌘K is this people search (E1-jump: employee-number aliases, the person's own acts); the shell's jump
        // palette, listening on the way back up, does not open a second dialog over it.
        e.preventDefault();
        e.stopPropagation();
        setQ("");
        setOpen("jump");
      } else if (e.key === "?" && !editable(e.target) && !document.querySelector("[role=dialog]")) {
        e.preventDefault();
        setOpen("keys");
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, []);
  const found = useQuery({ ...samePersonQuery(q), enabled: open === "jump" && q.trim().length > 0 });
  const rows = found.data?.items ?? [];
  const exact = rows.filter((e) => e.employee_number === q.trim());
  // An earlier number still finds its person (E1-jump-alias): asked only when no one holds the number now.
  const asked = open === "jump" && found.isSuccess && !exact.length && /\d/.test(q);
  const matchRead = useQuery({ ...numberMatchQuery(q.trim()), enabled: asked, retry: false });
  const match = matchRead.data;
  const aliasRead = useQuery({ ...employeeQuery(match?.employee_id ?? ""), enabled: match?.matched_by === "alias" });
  const alias = aliasRead.data?.employee;
  // Everything this search asks has answered (an alias lookup included), so no section lands above another later.
  const settled = found.isSuccess && !found.isFetching && (!asked || !matchRead.isFetching) && !(match?.matched_by === "alias" && aliasRead.isPending);
  const people = exact.length ? exact : rows.slice(0, 8);
  const shared = people.length > 1 && people.every((e) => e.name === people[0]!.name);
  const go = (id: string) => {
    setOpen(null);
    if (id === "new") return void navigate({ to: "/people/new", search: {} });
    if (id === "exited") return void navigate({ to: "/people", search: { status: "EXITED" } });
    const [person, then] = id.split(":");
    if (then === "events") return void navigate({ to: "/people/$id", params: { id: person! }, search: { tab: "events" } });
    if (then === "multi") return void navigate({ to: "/people/$id", params: { id: person! }, search: { act: "multi" } });
    // A record action (docs/design/record-actions.md §2): the card opens with that action's sheet.
    if (then === "act") return void navigate({ to: "/people/$id", params: { id: person! }, search: { act: id.split(":")[2] } });
    void navigate({ to: "/people/$id", params: { id: person! } });
  };
  const sections: PaletteSection[] = [];
  if (alias)
    sections.push({
      id: "alias",
      title: t("peopleJump.alias"),
      items: [{ id: alias.id, text: `${alias.name} ${q}`, title: <><b>{alias.name}</b> <span className="code">{alias.employee_number ?? t("peopleJump.noNumber")}</span></>, meta: t("peopleJump.alias.d", { old: q.trim(), now: alias.employee_number ?? "—" }), end: <Kbd k="Enter" /> }],
    });
  if (people.length)
    sections.push({
      id: "people",
      title: exact.length ? t("peopleJump.byNumber") : shared ? t("peopleJump.sameName", { count: people.length }) : t("peopleJump.people", { count: rows.length }),
      items: people.map((e, i) => ({
        id: e.id,
        text: `${e.name} ${e.employee_number ?? ""}`,
        icon: <UserRound size={16} />,
        title: <><b>{e.name}</b> <span className="code">{e.employee_number ?? t("peopleJump.noNumber")}</span></>,
        meta: [e.company, e.org_unit, e.employment_type && label(EMPLOYMENT_TYPE, e.employment_type)].filter(Boolean).join(" · "),
        end: <>{labeled(EMPLOYEE_STATUS, e.status ?? "UNKNOWN").label}{i === 0 && <Kbd k="Enter" />}</>,
      })),
    });
  // What to do with the first match (E1-jump): the record, its action history, a correction — each opens on the card.
  const first = alias ?? people[0];
  if (first)
    sections.push({
      id: "do",
      title: t("peopleJump.do", { name: first.name, no: first.employee_number ?? "" }),
      items: [
        { id: `${first.id}:events`, text: t("peopleJump.do.events"), title: t("peopleJump.do.events"), meta: t("peopleJump.do.events.d") },
        { id: `${first.id}:multi`, text: t("peopleJump.do.fix"), title: t("peopleJump.do.fix"), meta: t("peopleJump.do.fix.d") },
        ...([["contact.add", t("empContact.add")], ["photo.add", t("empPhoto.add")], ["empno", t("empCard.more.empno")], ["exit.report", t("crud.person.exit")], ["cancel", t("crud.person.cancel")]] as const).map(([act, text]) => ({ id: `${first.id}:act:${act}`, text, title: text })),
      ],
    });
  // The ways on wait for the search to answer, so the results never land above them and push them down.
  if (q.trim() && settled)
    sections.push({
      id: "next",
      title: t("peopleJump.next"),
      items: [
        { id: "new", text: t("peopleJump.new", { q }), title: t("peopleJump.new", { q }), end: <Kbd k="A" /> },
        { id: "exited", text: t("peopleJump.exited"), title: t("peopleJump.exited"), meta: t("peopleJump.exited.d") },
      ],
    });
  const none = q.trim() && found.isSuccess && rows.length === 0 && !alias;
  return (
    <>
      <Palette
        open={open === "jump"}
        onClose={() => setOpen(null)}
        label={t("peopleJump.label")}
        query={q}
        onQuery={setQ}
        placeholder={t("peopleJump.placeholder")}
        sections={sections}
        onAction={go}
        notice={none && <><b>{t("peopleJump.none", { q: q.trim() })}</b><span>{t("peopleJump.none.d")}</span></>}
        foot={<><span className="grow" /><span>{t("peopleJump.foot.masked")}</span></>}
      />
      <KeyMap open={open === "keys"} onClose={() => setOpen(null)} title={t("peopleJump.keys")}  filter={{ label: t("peopleJump.keys.filter"), hint: t("peopleJump.keys.single") }} groups={KEY_GROUPS.map((g) => ({ id: g.id, title: tx(`peopleJump.keys.group.${g.id}`), keys: g.keys.map((k) => ({ keys: k.keys, what: tx(`peopleJump.keys.${k.id}`) })) }))} />
    </>
  );
}
