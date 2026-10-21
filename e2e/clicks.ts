import { test, type Locator } from "@playwright/test";

/**
 * Counts user clicks/selections per task so "clicks to completion" is measured, reported
 * (test annotations) and bounded by assertions instead of drifting.
 */
export function clickCounter() {
  let n = 0;
  const tasks: Record<string, number> = {};
  return {
    click: async (l: Locator) => {
      n++;
      await l.click();
    },
    select: async (l: Locator, v: string) => {
      n++;
      await l.selectOption(v);
    },
    /** Ends the current task, records it, returns its click count. */
    done(task: string) {
      tasks[task] = n;
      test.info().annotations.push({ type: "clicks", description: `${task}: ${n}` });
      n = 0;
      return tasks[task]!;
    },
  };
}
