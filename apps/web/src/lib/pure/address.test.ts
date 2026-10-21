import { expect, test } from "vitest";
import { manualAddress } from "./address";

test("a typed address gives its province and district, or null without a district", () => {
  expect(manualAddress(" 경기  평택시 고덕동 31")).toEqual({ source: "MANUAL_UNVERIFIED", road_addr_part1: "경기 평택시 고덕동 31", si_nm: "경기", sgg_nm: "평택시" });
  expect(manualAddress("경기도 수원시 영통구 광교로 1")?.sgg_nm).toBe("수원시 영통구");
  expect(manualAddress("평택 1공장")).toBeNull();
});
