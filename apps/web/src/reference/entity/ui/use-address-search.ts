import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AddressHit, AddressProblem, AddressValue } from "../../../ui/address-field/address-field";
import { get } from "../../../lib/query";
import type { AddrDraft } from "../domain/address";

/** `value` after it has stopped changing for `ms` (search as you type without a request per keystroke). */
function useSettled(value: string, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/**
 * Road-name address search through the server (which holds the key and talks to juso.go.kr). The juso service
 * refuses keywords under two characters, so shorter input asks nothing. Unavailable (no key, an expired key, the
 * service down, or our request failing) turns the field into manual entry.
 * features/entity/ui/use-ref.ts keeps its own copy until that lane switches to this one.
 */
export function useAddressSearch() {
  const [query, setQuery] = useState("");
  const q = useSettled(query.trim(), 300);
  const r = useQuery({ ...get("/api/v1/ref/address-search", { params: { query: { q } } }), enabled: q.length >= 2, retry: false });
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
