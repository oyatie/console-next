import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { DockSheet } from "./dock-sheet";

beforeAll(() => loadCatalog("ko"));

const [C, A, BODY] = ["c", "a", "body"];
const sheet = (open: boolean) =>
  renderToStaticMarkup(
    <DockSheet open={open} title="26칸 저장" onClose={() => undefined} consequence={C} actions={A}>
      {BODY}
    </DockSheet>,
  );

test("a docked sheet is a labelled complementary region with its foot, and nothing while closed", () => {
  const html = sheet(true);
  expect(html).toContain("<aside");
  expect(html).toMatch(/aria-labelledby="[^"]+"/);
  expect(html).toContain("26칸 저장");
  expect(html).toContain("body");
  expect(sheet(false)).toBe("");
});
