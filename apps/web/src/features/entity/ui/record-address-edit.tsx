import { AddressField } from "../../../ui/address-field/address-field";
import { DistrictPick } from "./district-pick";
import { useAddressSearch } from "./use-ref";
import type { Addr } from "../domain/record-values";

/** An address picked by road-name search (or typed by hand while search is down), for a revise sheet. */
export function AddressEdit({ label, v, set, required = true }: { label: string; v: Addr | null; set: (v: Addr | null) => void; required?: boolean }) {
  const search = useAddressSearch();
  return (
    <>
      <AddressField label={label} required={required} value={v} onChange={(x) => set(x && search.withCodes(x))} query={search.query} onQueryChange={search.setQuery} hits={search.hits} loading={search.loading} problem={search.problem} />
      <DistrictPick a={v} onChange={set} />
    </>
  );
}
