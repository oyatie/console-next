import { expect, test } from "vitest";
import { listPosition, maskedAddress, maskedBirth, maskedEmail, maskedPhone, registerGaps, registerItems, serviceSpan } from "./card";

test("default masks show only what identifies the field, never the value", () => {
  expect(maskedBirth()).toBe("••••-••-••");
  expect(maskedPhone("+821012345821")).toBe("010-••••-5821");
  expect(maskedPhone("010-1234-5821")).toBe("010-••••-5821");
  expect(maskedPhone("123")).toBe("••••");
  expect(maskedEmail("hajun.yoon@saeon.example.com")).toBe("h••••@••••.com");
  expect(maskedAddress({ source: "MANUAL", road_addr_part1: "경기도 평택시 포승읍 새온로 118", si_nm: "경기도", sgg_nm: "평택시" } as never)).toBe("경기도 평택시 ••••");
});

test("register items: 경력 없음 counts as recorded, 해고·퇴직 is n/a while employed, 기타 is never a gap", () => {
  const base = { name: "윤하준", sex: "MALE", birth: "1994-08-21", address: null, careers: [], job: null, hireDate: "2019-03-14", exited: false, exitReason: null };
  const items = registerItems(base);
  expect(items.map((i) => i.present)).toEqual([true, true, true, false, true, false, true, true, true]);
  expect(registerGaps(items)).toBe(2);
  expect(registerGaps(registerItems({ ...base, careers: null, exited: true }))).toBe(4);
});

test("service span counts whole months, nothing before the hire date", () => {
  expect(serviceSpan("2019-03-14", "2026-10-06")).toEqual({ years: 7, months: 6 });
  expect(serviceSpan("2019-03-14", "2026-03-13")).toEqual({ years: 6, months: 11 });
  expect(serviceSpan("2026-11-02", "2026-10-06")).toBeNull();
});

test("list position walks the unit's list", () => {
  expect(listPosition(["a", "b", "c"], "b")).toEqual({ index: 2, total: 3, prev: "a", next: "c" });
  expect(listPosition(["a"], "z")).toBeNull();
});
