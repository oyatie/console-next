// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps, ReactElement } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { DateInput } from "./date-input";
import { TextInput } from "../field/field";

// Exercise the real input handlers without adding a DOM test dependency.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useId: () => "date-error",
  useEffect: () => undefined,
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = value; }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
}));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { hooks.values = []; });

function input(props: Partial<ComponentProps<typeof DateInput>> = {}) {
  const onChange = vi.fn();
  const render = () => {
    hooks.cursor = 0;
    const tree = DateInput({ value: "", today: "2026-10-01", onChange, ...props });
    return tree.props.children[0] as ReactElement<ComponentProps<typeof TextInput>>;
  };
  const type = (text: string) => {
    let draft = "";
    for (const char of text) {
      draft += char;
      render().props.onChange!({ target: { value: draft } } as never);
      expect(render().props.value).toBe(draft);
      expect(onChange).not.toHaveBeenCalled();
    }
  };
  const blur = () => render().props.onBlur!({} as never);
  const enter = () => render().props.onKeyDown!({ key: "Enter", nativeEvent: {}, preventDefault: vi.fn() } as never);
  return { render, type, blur, enter, onChange };
}

test.each(["20261115", "2026. 11. 25."])("keeps %s intact until blur and commits once", (draft) => {
  const field = input();
  field.type(draft);
  field.blur();
  expect(field.render().props.value).toBe(draft === "20261115" ? "2026. 11. 15." : "2026. 11. 25.");
  expect(field.onChange).toHaveBeenCalledExactlyOnceWith(draft === "20261115" ? "2026-11-15" : "2026-11-25");
  field.blur();
  expect(field.onChange).toHaveBeenCalledTimes(1);
});

test("Enter commits once, including the subsequent blur", () => {
  const field = input();
  field.type("20261115");
  field.enter();
  field.blur();
  expect(field.onChange).toHaveBeenCalledExactlyOnceWith("2026-11-15");
});

test.each([
  { min: "2026-12-01", message: "uiDate.outOfRange" as const },
  { max: "2026-11-01", message: "uiDate.outOfRange" as const },
  { disabledDates: ["2026-11-15"], message: "uiDate.disabled" as const },
])("refuses typed unavailable dates with a visible error: %s", ({ message, ...bounds }) => {
  const field = input(bounds);
  field.type("2026-11-15");
  field.blur();
  expect(field.onChange).toHaveBeenCalledExactlyOnceWith("");
  expect(field.render().props["aria-invalid"]).toBe(true);
  hooks.cursor = 0;
  const tree = DateInput({ value: "", today: "2026-10-01", onChange: field.onChange, ...bounds });
  expect(tree.props.children.at(-1).props.children).toBe(t(message));
});

test("an invalid draft remains available to registration validation", () => {
  const onDraftChange = vi.fn();
  const field = input({ onDraftChange });
  field.type("1990-13-12");
  field.blur();
  expect(onDraftChange).toHaveBeenLastCalledWith("1990-13-12");
  expect(field.onChange).not.toHaveBeenCalled();
});

test("a typed date below minFrom shows the caller's reason", () => {
  const field = input({ min: "2026-12-01", minReason: "승인 후부터 적용됩니다" });
  field.type("2026-11-15");
  field.blur();
  hooks.cursor = 0;
  const tree = DateInput({ value: "", today: "2026-10-01", onChange: field.onChange, min: "2026-12-01", minReason: "승인 후부터 적용됩니다" });
  expect(tree.props.children.at(-1).props.children).toBe("승인 후부터 적용됩니다");
});

// regression (train fix r1): a sheet's own rule for a date after `max` (「오늘 이후 날짜는 기록할 수 없습니다.」) was replaced by
// the generic out-of-range line once typed dates outside the bounds stopped reaching the sheet.
test("a typed date after max shows the caller's reason", () => {
  const field = input({ max: "2026-10-01", maxReason: "오늘 이후 날짜는 기록할 수 없습니다." });
  field.type("2026-10-02");
  field.blur();
  hooks.cursor = 0;
  const tree = DateInput({ value: "", today: "2026-10-01", onChange: field.onChange, max: "2026-10-01", maxReason: "오늘 이후 날짜는 기록할 수 없습니다." });
  expect(tree.props.children.at(-1).props.children).toBe("오늘 이후 날짜는 기록할 수 없습니다.");
  expect(field.onChange).not.toHaveBeenCalledWith("2026-10-02");
});

// regression (train fix r1): an optional field emptied its refused text into "", so the 휴업 sheet saved without the end the
// person had typed (before the start) while the field showed the error. onInvalid tells the form to hold the save.
test("a refused commit reports invalid; a valid or cleared one reports valid", () => {
  const onInvalid = vi.fn();
  const refused = input({ min: "2026-10-01", onInvalid });
  refused.type("2026-09-30");
  refused.blur();
  expect(onInvalid).toHaveBeenLastCalledWith(true);
  expect(refused.onChange).toHaveBeenLastCalledWith("");
  // Cleared by the person: nothing typed is nothing refused.
  refused.render().props.onChange!({ target: { value: "" } } as never);
  refused.blur();
  expect(onInvalid).toHaveBeenLastCalledWith(false);
  const valid = input({ min: "2026-10-01", onInvalid });
  valid.type("2026-10-02");
  valid.blur();
  expect(onInvalid).toHaveBeenLastCalledWith(false);
  expect(valid.onChange).toHaveBeenLastCalledWith("2026-10-02");
});

test("calendar picks refuse bounds and blocked dates and accept an available date", () => {
  const onChange = vi.fn();
  hooks.cursor = 0;
  const tree = DateInput({ value: "", today: "2026-10-01", onChange, min: "2026-10-01", max: "2026-12-31", disabledDates: ["2026-11-15"] });
  const calendar = tree.props.children[1].props.children[1].props.children.props.children;
  expect(calendar.props.minValue.toString()).toBe("2026-10-01");
  expect(calendar.props.maxValue.toString()).toBe("2026-12-31");
  expect(calendar.props.isDateUnavailable({ toString: () => "2026-11-15" })).toBe(true);
  for (const date of ["2026-09-30", "2027-01-01", "2026-11-15", "2026-02-30"]) {
    calendar.props.onChange({ toString: () => date });
  }
  expect(onChange).not.toHaveBeenCalled();
  calendar.props.onChange({ toString: () => "2026-11-16" });
  expect(onChange).toHaveBeenCalledExactlyOnceWith("2026-11-16");
});
