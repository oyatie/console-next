import { expect, test } from "vitest";
import type { ReviewItem } from "./contract";
import { resolveKind } from "./review";
import { answerOf, initialPicks, withChoice } from "./steps";

test("unfamiliar response values keep their evidence without offering an unsupported write", () => {
  const item: ReviewItem = { id: "new", reason: "new_review", blocking: true, sheet: "source", rows: 1,
    resolution: { decision: "future_map" as never, key: "source:2", choices: ["x"] } };
  expect(resolveKind(item)).toBe("info");
  const picks = initialPicks();
  expect(answerOf(picks, item.resolution!.decision, item.resolution!.key)).toBeNull();
  expect(answerOf(picks, "__proto__" as never, "anything")).toBeNull();
  expect(() => withChoice(picks, "future_map" as never, "source:2", "x")).toThrow(TypeError);
  expect(picks).toEqual(initialPicks());
});
