import { expect, test } from "vitest";
import { caretAfter, digits } from "./caret";

test("the caret stays after the same digit when separators are inserted", () => {
  // Typing the 4th digit of "1234" shows "123-4": the caret goes after the "4".
  expect(caretAfter("123-4", 4)).toBe(5);
  expect(caretAfter("123-45-67890", 3)).toBe(3);
  expect(caretAfter("123-45-67890", 0)).toBe(0);
  expect(caretAfter("123", 9)).toBe(3);
});

test("full-width digits count", () => {
  expect(digits("１２3-4")).toBe("1234");
});
