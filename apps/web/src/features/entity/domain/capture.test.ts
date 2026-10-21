import { expect, test } from "vitest";

test("a hand-typed address takes its codes and names from a picked district, else from its own words", async () => {
  const { krAddress } = await import("./plan");
  const typed = { road: "서울특별시 종로구 세종대로 209", zip: "03154", detail: "", verified: false };
  expect(krAddress({ ...typed, district: { code: "1111000000", label: "서울특별시 종로구", version: "2026-10-01" } })).toMatchObject({ source: "MANUAL_UNVERIFIED", adm_cd: "1111000000", si_nm: "서울특별시", sgg_nm: "종로구", emd_nm: null });
  expect(krAddress({ ...typed, district: { code: "4113500000", label: "경기도 성남시 분당구", version: "2026-10-01" } })).toMatchObject({ si_nm: "경기도", sgg_nm: "성남시 분당구", emd_nm: null });
  expect(krAddress({ ...typed, district: { code: "3611000000", label: "세종특별자치시", version: "2026-10-01" } })).toMatchObject({ si_nm: "세종특별자치시", sgg_nm: null, emd_nm: null });
  expect(krAddress(typed)).not.toHaveProperty("adm_cd");
});

test("the NHIS branch office goes out with its relation; no other insurer carries a listed code", async () => {
  const { insurers } = await import("./workplace");
  const rows = [
    { insurer: "NHIS" as const, status: "ESTABLISHED" as const, mgmtNo: "12345678901", establishedOn: "2026-01-02", code: { code: "0101", label: "x", version: "2026" } },
    { insurer: "IACI" as const, status: "ESTABLISHED_NUMBER_PENDING" as const, mgmtNo: "", establishedOn: "", code: { code: "72901", label: "y", version: "2026" } },
    { insurer: "EI" as const, status: "NOT_ESTABLISHED" as const, mgmtNo: "", establishedOn: "" },
  ];
  const out = insurers({ insurance: "PER_INSURER", rows });
  expect(out[0]).toMatchObject({ insurer: "NHIS", nhis_branch_office_code: "0101" });
  expect(out[1]).not.toHaveProperty("iaci_business_type_code");
  expect(out[2]).not.toHaveProperty("nhis_branch_office_code");
});

test("an edited head office keeps its codes for a new unit, and is replaced for a new road or a newly picked district", async () => {
  const { addressChange } = await import("./capture");
  const old = { source: "MANUAL_UNVERIFIED" as const, road_addr_part1: "서울특별시 종로구 세종대로 209", si_nm: "서울특별시", sgg_nm: "종로구", zip_no: "03154", detail: "3층", as_printed: "종로 세종대로" };
  const draft = { road: old.road_addr_part1, zip: "03154", detail: "3층", verified: false };
  expect(addressChange(old, draft)).toBeUndefined();
  expect(addressChange(old, { ...draft, detail: "4층" })).toEqual({ ...old, detail: "4층" });
  const district = { code: "1111000000", label: "서울특별시 종로구", version: "2026-10-01" };
  expect(addressChange(old, { ...draft, district })).toMatchObject({ adm_cd: "1111000000", sgg_nm: "종로구", detail: "3층", as_printed: "종로 세종대로" });
  expect(addressChange({ ...old, adm_cd: "1111000000" }, { ...draft, district: { ...district, version: "" } })).toBeUndefined();
  expect(addressChange(old, { ...draft, road: "부산광역시 중구 중앙대로 2" })).toMatchObject({ road_addr_part1: "부산광역시 중구 중앙대로 2", si_nm: "부산광역시" });
});
