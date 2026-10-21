import { useState } from "react";
import { t } from "@console/i18n";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { pickable } from "../domain/accounts";
import type { Account } from "../api";

function Picker({ accounts, loading, onPick }: { accounts: readonly Account[]; loading: boolean; onPick: (a: Account) => void }) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  // The linked person's name finds the account too (the ops account carries its own name, not its holder: governance-20).
  const hits = term ? accounts.filter((a) => [a.display_name, a.employee_name, a.employee_number].some((v) => (v ?? "").toLowerCase().includes(term))) : [];
  return (
    <ServerPicker
      label={t("access.grants.pick")}
      query={q}
      onQueryChange={setQ}
      options={hits.map((a) => ({ id: a.id, name: a.display_name, code: a.employee_number ?? `#${a.id.slice(-4)}`, context: [a.employee_company, a.employee_org_unit].filter(Boolean).join(" · ") }))}
      value={null}
      onChange={(id) => {
        const a = accounts.find((x) => x.id === id);
        if (a) onPick(a);
      }}
      group={t("access.grants.pick.group")}
      loading={loading}
      empty={t("access.grants.pick.none")}
    />
  );
}

/**
 * A person to grant to, by search (people-self-47): namesakes are told apart by employee number and confirmed by its last
 * digits; one person with two accounts is one choice, never a namesake; the ops account is never offered (it already holds
 * everything). Picking hands the person over and starts the box afresh, so no list stays open over the sheet it opens.
 */
export function AccountPick({ accounts, ops, loading, onPick }: { accounts: readonly Account[]; ops: string | undefined; loading: boolean; onPick: (a: Account) => void }) {
  const [round, setRound] = useState(0);
  // While the accounts (re)load the list says so: no "none found" line that the fresh answer then removes.
  return <Picker key={round} accounts={pickable(accounts, ops)} loading={loading} onPick={(a) => (setRound(round + 1), onPick(a))} />;
}
