import { useState } from "react";
import { t } from "@console/i18n";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { pickable } from "../domain/accounts";
import type { Account } from "../api";
import { personOption } from "../../../reference/person/ui/person-option";

/** The grant dialog unmounts this picker when a person is chosen. */
export function AccountPick({ accounts: all, ops, loading, onPick }: { accounts: readonly Account[]; ops: string | undefined; loading: boolean; onPick: (a: Account) => void }) {
  const accounts = pickable(all, ops);
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  // The linked person's name finds the account too (the ops account carries its own name, not its holder: governance-20).
  const hits = accounts.filter((a) => [a.display_name, a.employee_name, a.employee_number].some((v) => (v ?? "").toLowerCase().includes(term)));
  return (
    <ServerPicker
      label={t("access.grants.pick")}
      query={q}
      onQueryChange={setQ}
      options={hits.map((a) => personOption(a, accounts))}
      value={null}
      onChange={(id) => {
        const a = accounts.find((x) => x.id === id);
        if (a) onPick(a);
        else setQ("");
      }}
      group={t("access.grants.pick.group")}
      loading={loading}
      empty={t("access.grants.pick.none")}
    />
  );
}
