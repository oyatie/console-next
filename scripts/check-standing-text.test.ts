import { expect, test } from "vitest";
import { blocks, inScope, ratchet } from "./check-standing-text.mjs";

test("counts prose, shared messages and field hints even when their text is dynamic", () => {
  expect(blocks("screen.tsx", '<><p>{text}</p><Banner>{error}</Banner><Field hint={format} /><Sheet subtitle={copy} /><Choice options={[{ description: t("choice.hint") }]} /></>')).toBe(5);
});

test("inline explanations count too; their hint marker cannot count the same span twice", () => {
  expect(blocks("screen.tsx", '<><span>{copy}</span><span data-hint="format">{format}</span><span className="muted">{instruction}</span></>')).toBe(3);
});

test("ratchet refuses a new block, a stale pin, a new screen and a raised baseline", () => {
  expect(ratchet({ screen: 3 }, { screen: 2 })).toContain("screen: 3 standing blocks exceeds 2");
  expect(ratchet({ screen: 1 }, { screen: 2 })).toContain("screen: lower the standing-text baseline from 2 to 1");
  expect(ratchet({ newScreen: 1 }, {})).toContain("newScreen: 1 standing blocks exceeds 0");
  expect(ratchet({ screen: 3 }, { screen: 3 }, { screen: 2 })).toContain("screen: standing-text baseline may only go down");
  expect(ratchet({ screen: 1 }, { screen: 1 }, { screen: 2 })).toEqual([]);
});

const classified = { FACT: 1, REFUSAL: 1, EMPTY: 1, LEGAL: 1, RECEIPT: 1, EXPLANATION: 0 };

test("a first pin requires complete classification and zero explanations", () => {
  expect(ratchet({ screen: 5 }, { screen: 5 }, {}, { screen: classified })).toEqual([]);
  expect(ratchet({ screen: 5 }, { screen: 5 }, {})).toContain("screen: standing-text baseline may only go down");
  expect(ratchet({ screen: 6 }, { screen: 5 }, {}, { screen: classified })).toContain("screen: 6 standing blocks exceeds 5");
  expect(ratchet({ screen: 4 }, { screen: 5 }, {}, { screen: classified })).toContain("screen: lower the standing-text baseline from 5 to 4");
  expect(ratchet({ screen: 6 }, { screen: 6 }, {}, { screen: { ...classified, EXPLANATION: 1 } })).toContain("screen: new screen cannot contain EXPLANATION");
  expect(ratchet({ screen: 5 }, { screen: 5 }, {}, { screen: { ...classified, FACT: 2 } })).toContain("screen: new-screen category counts must sum to its standing-text pin");
  expect(ratchet({}, { screen: 5 }, {}, { screen: classified })).toContain("screen: classified new screen is absent");
});

test.each([null, [], {}, { ...classified, FACT: -1 }, { ...classified, FACT: 0.5 },
  { ...classified, FACT: "1" }, { ...classified, EXPLANATION: undefined }, { ...classified, OTHER: 0 }])(
  "a malformed classification cannot authorize a first pin: %j", (counts) => {
    expect(ratchet({ screen: 5 }, { screen: 5 }, {}, { screen: counts })).toContain("screen: new screen needs nonnegative integer counts for all six categories");
  },
);

test.each([0, 4])("classification never permits raising an existing pin of %i", (previous) => {
  expect(ratchet({ screen: 5 }, { screen: 5 }, { screen: previous }, { screen: classified })).toContain("screen: standing-text baseline may only go down");
});

test("a classified screen retains the ratchet after integration", () => {
  expect(ratchet({ screen: 5 }, { screen: 5 }, { screen: 5 }, { screen: classified })).toEqual([]);
  expect(ratchet({ screen: 4 }, { screen: 4 }, { screen: 5 }, { screen: classified })).toEqual([]);
  expect(ratchet({ screen: 4 }, { screen: 4 }, { screen: 5 }, { screen: { ...classified, FACT: 0 } })).toEqual([]);
  expect(ratchet({ screen: 6 }, { screen: 6 }, { screen: 5 }, { screen: { ...classified, FACT: 2 } })).toContain("screen: standing-text baseline may only go down");
});

test("excludes the other lane's shell and structure screens and non-product examples", () => {
  for (const file of ["apps/web/src/shell/nav.tsx", "apps/web/src/features/structure/ui/page.tsx", "apps/web/src/ui/field/field.gallery.tsx", "apps/web/src/ui/field/field.test.tsx"])
    expect(inScope(file)).toBe(false);
  expect(inScope("apps/web/src/features/people/ui/roster-page.tsx")).toBe(true);
});

test("screen totals follow shared hint components, handle cycles and exclude the other lane", async () => {
  const { screenCounts } = await import("./check-standing-text.mjs");
  const sources = {
    "apps/web/src/routes/people.ts": 'const page = lazyRouteComponent(() => import("../features/people/ui/page"));',
    "apps/web/src/features/people/ui/page.tsx": 'import { Field } from "../../../ui/field/field"; import "./cycle"; export const Page = () => <Field hint={format} />;',
    "apps/web/src/features/people/ui/cycle.ts": 'import "./page";',
    "apps/web/src/ui/field/field.tsx": 'export const Field = () => <p data-hint="field">{hint}</p>;',
    "apps/web/src/routes/org.ts": 'const page = lazyRouteComponent(() => import("../features/structure/ui/page"));',
    "apps/web/src/features/structure/ui/page.tsx": '<p>Other lane</p>',
  };
  expect(screenCounts(sources)).toEqual({ "apps/web/src/features/people/ui/page.tsx#default": 2 });
});

test("screen resolution ignores inherited source files", async () => {
  const { screenCounts } = await import("./check-standing-text.mjs");
  const phantom = "apps/web/src/features/people/ui/page.tsx";
  const sources = Object.create({ [phantom]: 'export const Page = () => <p>phantom</p>;' });
  sources["apps/web/src/routes/people.ts"] = 'const page = lazyRouteComponent(() => import("../features/people/ui/page"), "Page");';

  expect(screenCounts(sources)).toEqual({});
});


test("separate lazy exports keep sibling screens from hiding additions; barrels include their screen", async () => {
  const { screenCounts } = await import("./check-standing-text.mjs");
  const sources = {
    "apps/web/src/routes/people.ts": 'const load = () => import("../features/people/ui/routes"); lazyRouteComponent(screen(load), "One"); lazyRouteComponent(screen(load), "Two"); lazyRouteComponent(() => import("../features/platform/Tenants"), "Tenants");',
    "apps/web/src/features/people/ui/routes.tsx": 'import { A } from "./a"; import { B } from "./b"; export const One = A; export function Two() { return <B />; }',
    "apps/web/src/features/people/ui/a.tsx": 'export const A = () => <p>One</p>;',
    "apps/web/src/features/people/ui/b.tsx": 'export const B = () => <><p>Two</p><p>Two</p></>;',
    "apps/web/src/features/platform/Tenants.tsx": 'export { Page as Tenants } from "./ui/page";',
    "apps/web/src/features/platform/ui/page.tsx": 'export const Page = () => <p>Barrel</p>;',
  };
  expect(screenCounts(sources)).toEqual({
    "apps/web/src/features/people/ui/routes.tsx#One": 1,
    "apps/web/src/features/people/ui/routes.tsx#Two": 2,
    "apps/web/src/features/platform/Tenants.tsx#Tenants": 1,
  });
});

test("a reviewed new record dock has its own budget while shared fields still count", async () => {
  const { screenCounts } = await import("./check-standing-text.mjs");
  const sources = {
    "apps/web/src/routes/a.ts": 'lazyRouteComponent(() => import("../features/a/page"), "Page");',
    "apps/web/src/features/a/page.tsx": 'import { Dock } from "./dock"; export function Page() { return <><p>Parent</p><Dock /></>; }',
    "apps/web/src/features/a/dock.tsx": 'import { Field } from "../../ui/field"; export function Dock() { return <Field hint={format} />; }',
    "apps/web/src/ui/field.tsx": 'export function Field() { return <p>{hint}</p>; }',
  };
  const first = { "apps/web/src/features/a/dock.tsx#Dock": { FACT: 2, REFUSAL: 0, EMPTY: 0, LEGAL: 0, RECEIPT: 0, EXPLANATION: 0 } };
  expect(screenCounts(sources, first)).toEqual({
    "apps/web/src/features/a/page.tsx#Page": 1,
    "apps/web/src/features/a/dock.tsx#Dock": 2,
  });
});
