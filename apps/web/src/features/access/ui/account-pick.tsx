import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
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
  const debouncedQ = q.trim() ? debounced : "";
  const search = useQuery({ ...accountSearchQuery(debouncedQ, 50, 0), placeholderData: keepPreviousData });
  const raw = search.data?.items ?? (debouncedQ ? [] : all);
  const accounts = pickable(raw, ops);
  const total = search.data ? (search.data.items.length < search.data.total ? search.data.total : accounts.length) : undefined;
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
      loading={loading || search.isFetching}
      total={total}
      error={search.error ? failureText(search.error) : undefined}
      empty={t("access.grants.pick.none")}
    />
  );
}
