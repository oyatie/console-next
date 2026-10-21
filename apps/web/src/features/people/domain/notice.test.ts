import { expect, test } from "vitest";
import { after, before, sections } from "./notice";

const line = (n: number, event: object) => ({ line_no: n, employee_id: `e${n}`, employee_number: `1000${n}`, name: `사람${n}`, event: { effective_date: "2026-11-01", ...event } }) as never;

test("sections follow the act order; each line reads where the person stood and what the act makes them", () => {
  const lines: never[] = [
    line(1, { event_type: "CONTRACT_RENEWAL", from_org_unit: "생산1팀", contract_end_date: "2027-10-31" }),
    line(2, { event_type: "TRANSFER", from_org_unit: "생산3팀", from_position: "사원", to_org_unit: "생산1팀", to_position: "사원" }),
    line(3, { event_type: "APPOINT", from_org_unit: "생산3팀", to_position: "팀장" }),
  ];
  expect(sections(lines).map((s) => s.kind)).toEqual(["TRANSFER", "APPOINT", "CONTRACT_RENEWAL"]);
  expect([before(lines[1]!), after(lines[1]!)]).toEqual(["생산3팀 · 사원", "생산1팀"]);
  expect(after(lines[0]!)).toBe("2026-11-01 ~ 2027-10-31");
  expect(after(lines[2]!)).toBe("팀장");
});
