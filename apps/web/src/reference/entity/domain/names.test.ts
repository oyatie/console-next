import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@console/i18n";
import { entityName, entityNames, legalNameTaken } from "./names";

const entity = (english: string | null) => ({ current: { name: "주식회사 누리", display_name: "누리", english_name: english } }) as unknown as Parameters<typeof entityNames>[0];

describe("entityNames", () => {
  afterEach(() => i18n.set("ko"));
  it("leads with the 법인명 in Korean, the 약칭 and 영문명 secondary", () => {
    expect(entityNames(entity("Nuri Co., Ltd."))).toEqual({ name: "주식회사 누리", aliases: ["누리", "Nuri Co., Ltd."] });
  });
  it("shows only the English name in English, never the 약칭", () => {
    i18n.set("en");
    expect(entityNames(entity("Nuri Co., Ltd."))).toEqual({ name: "Nuri Co., Ltd.", aliases: [] });
  });
  it("falls back to the 법인명 alone in English when there is no English name", () => {
    i18n.set("en");
    expect(entityNames(entity(null))).toEqual({ name: "주식회사 누리", aliases: [] });
  });
  it("names an entity in a sentence by the name it leads with: the 법인명 in Korean, the English name in English", () => {
    expect(entityName(entity("Nuri Co., Ltd."))).toBe("주식회사 누리");
    i18n.set("en");
    expect(entityName(entity("Nuri Co., Ltd."))).toBe("Nuri Co., Ltd.");
    expect(entityName(entity(null))).toBe("주식회사 누리");
  });
  it("names nothing without a record or a name", () => {
    expect(entityName(undefined)).toBe("");
    expect(entityName({ current: undefined } as unknown as Parameters<typeof entityName>[0])).toBe("");
  });
  it("finds a 법인명 an open entity already holds, never a closed one's or an empty name", () => {
    const held = [{ current: { name: "주식회사 누리" }, closed_on: null }, { current: { name: "주식회사 다온" }, closed_on: "2026-01-01" }] as unknown as Parameters<typeof legalNameTaken>[1];
    expect(legalNameTaken(" 주식회사 누리 ", held)).toBe(true);
    expect(legalNameTaken("주식회사 다온", held)).toBe(false);
    expect(legalNameTaken("  ", held)).toBe(false);
  });
});
