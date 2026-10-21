import { expect, type BrowserContext } from "@playwright/test";

/**
 * React's DOM-nesting errors (an <ol> inside a <p>, a <div> inside a <button>): the browser repairs the tree, so the
 * screen can look right while what is read and clicked is not what React rendered. React 19 words them "In HTML, X
 * cannot be a child/descendant of <Y>" and "<Y> cannot contain a nested X"; React 18 said validateDOMNesting.
 */
export const DOM_NESTING = /In HTML, .* cannot be a (?:child|descendant) of|cannot contain a nested|validateDOMNesting/;

/** Fails the running test (softly, so the walk still reports what follows) on each such console error in `context`. */
export function guardConsole(context: BrowserContext) {
  context.on("console", (m) => {
    if (m.type() === "error" && DOM_NESTING.test(m.text())) expect.soft(m.text(), "React DOM-nesting error in the console").toBe("");
  });
}
