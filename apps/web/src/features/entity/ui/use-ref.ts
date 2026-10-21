import { useEffect, useState } from "react";
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import type { RefListKey } from "@console/api/pending";
import { t } from "@console/i18n";
import type { AddressHit, AddressProblem, AddressValue } from "../../../ui/address-field/address-field";
import type { CodeList, CodeOption } from "../../../ui/code-picker/code-picker";
import { addressQuery, codesQuery } from "../api";
import type { AddrDraft } from "../domain/draft";

/** `value` after it has stopped changing for `ms` (search as you type without a request per keystroke). */
function useSettled(value: string, ms = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/** A searchable official code list (design §2.4): its state, version and the options matching the query. */
export function useCodeSearch(key: RefListKey, title?: string) {
  const [query, setQuery] = useState("");
  const q = useSettled(query.trim());
  // The list's state comes from its unfiltered read, so a search that fails or is still loading never turns a
  // loaded list into "not loaded" (and never swaps the field's shape under the pointer); the last page stays meanwhile.
  const head = useQuery({ ...codesQuery(key, ""), retry: false });
  const r = useQuery({ ...codesQuery(key, q), retry: false, placeholderData: keepPreviousData });
  const info = head.data?.list;
  const list: CodeList = { title: info?.title ?? title ?? t(`entity.list.${key as "tax_office" | "nts_industry_code"}`), version: info?.version ?? undefined, loaded: info?.status === "LOADED" };
  const options: CodeOption[] = (r.data?.items ?? []).map((i) => ({ code: i.code, label: i.label, context: i.parent_label ?? undefined }));
  return { query, setQuery, list, options, loading: r.isFetching, ready: r.isSuccess };
}

/**
 * Whether each list has answered whether it is loaded. A code field's shape (a search over the list, or the code typed as
 * printed) follows that answer, so a form holds its code fields until then instead of drawing one shape and swapping it.
 */
export function useCodeListsKnown(keys: readonly RefListKey[]) {
  return useQueries({ queries: keys.map((key) => ({ ...codesQuery(key, ""), retry: false })) }).every((q) => !q.isPending);
}

/**
 * Road-name address search through the server (which holds the key and talks to juso.go.kr). The juso
 * service refuses keywords under two characters, so shorter input asks nothing. Unavailable (no key, an
 * expired key, the service down, or our request failing) turns the field into manual entry.
 */
export function useAddressSearch() {
  const [query, setQuery] = useState("");
  const q = useSettled(query.trim(), 300);
  const r = useQuery({ ...addressQuery(q), enabled: q.length >= 2, retry: false });
  const items = (r.data?.items ?? []).filter((h) => h.bd_mgt_sn);
  const hits: AddressHit[] = items.map((h) => ({ key: h.bd_mgt_sn!, road: h.road_addr_part1, jibun: h.jibun_addr ?? "", zip: h.zip_no ?? "", building: h.bd_nm ?? undefined }));
  const problem: AddressProblem | null = r.isError || r.data?.status === "UNAVAILABLE" ? "unavailable" : r.data?.status === "TOO_BROAD" ? "narrow" : null;
  /** The chosen value with the search result's codes attached, so the structured address is what is saved. */
  const withCodes = (v: AddressValue): AddrDraft => {
    const juso = v.verified ? items.find((h) => h.bd_mgt_sn === v.key) : undefined;
    return juso ? { ...v, juso } : v;
  };
  return { query, setQuery, hits, problem, loading: r.isFetching, withCodes };
}
