import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { failureText } from "../../../lib/refusal";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { pickable } from "../domain/accounts";
import { accountSearchQuery, type Account } from "../api";
import { personOption } from "../../../reference/person/ui/person-option";

/** The grant dialog unmounts this picker when a person is chosen. Searches the directory server-side. */
export function AccountPick({ accounts: all, ops, loading, onPick }: { accounts: readonly Account[]; ops: string | undefined; loading: boolean; onPick: (a: Account) => void }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const trimmed = q.trim();
    if (!trimmed) return;
    const timer = setTimeout(() => setDebounced(trimmed), 150);
    return () => clearTimeout(timer);
  }, [q]);
  const trimmed = q.trim();
  const debouncedQ = trimmed ? debounced : "";
  const settling = debouncedQ !== trimmed;
  const search = useQuery(accountSearchQuery(debouncedQ, 50, 0));
  // A result for earlier text can move under a pointer while selecting the grantee.
  const results = settling ? undefined : search.data;
  const raw = results?.items ?? (trimmed ? [] : all);
  const accounts = pickable(raw, ops);
  const total = results ? (results.items.length < results.total ? results.total : accounts.length) : undefined;
  return (
    <ServerPicker
      label={t("access.grants.pick")}
      query={q}
      onQueryChange={setQ}
      options={accounts.map((a) => personOption(a, accounts))}
      value={null}
      onChange={(id) => {
        const a = accounts.find((x) => x.id === id);
        if (a) onPick(a);
        else setQ("");
      }}
      group={t("access.grants.pick.group")}
      loading={loading || settling || search.isFetching}
      total={total}
      readError={!settling && search.error ? failureText(search.error) : undefined}
      empty={t("access.grants.pick.none")}
    />
  );
}
