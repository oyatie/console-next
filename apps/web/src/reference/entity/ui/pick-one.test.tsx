import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PickOne } from "./pick-one";

const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `w${i}`, label: `매장 ${i}` }));
const render = (n: number) => renderToStaticMarkup(<PickOne label="사업장" group="사업장" empty="없음" required options={opts(n)} value={null} onChange={() => {}} />);

test("a long list of workplaces is a search, not a crash", () => {
  expect(render(16)).toContain('role="combobox"');
  expect(render(3)).not.toContain('role="combobox"');
});
