import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ShiftBar } from "./shift-bar";
import { cut } from "./cut";

test("recorded minutes outside the recognised ones are cut out as the hatched part", () => {
  expect(cut({ start: 472, end: 1150 }, [{ start: 480, end: 720 }, { start: 780, end: 1020 }])).toEqual([
    { start: 472, end: 480 },
    { start: 720, end: 780 },
    { start: 1020, end: 1150 },
  ]);
  const html = renderToStaticMarkup(<ShiftBar from={360} to={1260} scheduled={[{ start: 480, end: 1020 }]} recorded={[{ start: 472, end: 1150 }]} recognised={[{ start: 480, end: 1020 }]} />);
  expect(html).toContain('aria-hidden="true"');
});
