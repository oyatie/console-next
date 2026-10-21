// The canonical layout components: semantics and the refusals built into their props.
import { readFileSync } from "node:fs";
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { ActionBar } from "./action-bar/action-bar";
import { buttonClass } from "./button/button-class";
import { Button, IconButton } from "./button/button";
import { Card } from "./card/card";
import { SectionHead } from "./card/section-head";
import { KeyValue, StatRow } from "./key-value/key-value";
import { Crumbs } from "./page-head/crumbs";
import { PageHead } from "./page-head/page-head";
import { Avatar } from "./avatar/avatar";
import { SearchField } from "./search/search-field";
import { Banner } from "./banner/banner";
import { ItemList } from "./item-list/item-list";
import { Legend } from "./legend/legend";
import { Skeleton } from "./skeleton/skeleton";

beforeAll(() => loadCatalog("ko"));
const [x, y, z] = ["x", "y", "z"];

test("a banner present on load is silent; one raised by an action is announced by its urgency", () => {
  expect(html(<Banner tone="warn">{x}</Banner>)).not.toMatch(/role=/);
  expect(html(<Banner tone="ok" live="polite">{x}</Banner>)).toContain('role="status"');
  expect(html(<Banner tone="danger" live="assertive">{x}</Banner>)).toContain('role="alert"');
  // The tone is never colour alone: an icon (hidden from AT) and the words carry it.
  expect(html(<Banner tone="danger">{x}</Banner>)).toMatch(/<svg[^>]*aria-hidden="true"/);
});

test("button sizes and the icon-only variant are classes of the one button, never a second look", () => {
  expect(buttonClass()).toBe("btn");
  expect(buttonClass("primary", { size: "sm" })).toBe("btn btn--primary btn--sm");
  expect(buttonClass("ghost", { icon: true, className: "extra" })).toBe("btn btn--ghost btn--icon extra");
  expect(html(<Button size="sm">{x}</Button>)).toContain('class="btn btn--sm"');
  const icon = html(<IconButton label={y}>{x}</IconButton>);
  expect(icon).toContain('aria-label="y"');
  expect(icon).toContain('title="y"');
  expect(icon).toContain('type="button"');
  expect(icon).toContain("btn--icon");
});

test("a card is a region named by its title; an untitled card is a plain surface", () => {
  const titled = html(<Card title={x}>{y}</Card>);
  const id = titled.match(/aria-labelledby="([^"]+)"/)![1];
  expect(titled).toContain(`<h2 id="${id}"`);
  expect(html(<Card>{y}</Card>)).not.toContain("aria-labelledby");
  expect(html(<SectionHead level={4}>{x}</SectionHead>)).toContain("<h4");
});

test("facts are a definition list; the verb column exists only when a fact has a verb", () => {
  const plain = html(<KeyValue items={[{ key: "a", label: x, value: y }]} />);
  expect(plain).toMatch(/^<dl[^>]*><div[^>]*><dt[^>]*>x<\/dt><dd[^>]*>y<\/dd><\/div><\/dl>$/);
  expect(plain).not.toContain("data-acts");
  expect(html(<KeyValue items={[{ key: "a", label: x, value: y, action: z }]} />)).toContain("data-acts");
  expect(html(<StatRow items={[{ key: "a", label: x, value: 3 }]} />)).toMatch(/<dt[^>]*>x<\/dt><dd[^>]*>3<\/dd>/);
});

test("the page head has the one h1; crumbs mark only the current place and hide the separators", () => {
  const head = html(<PageHead title={x} crumbs={<Crumbs items={[y]} current={z} />} />);
  expect(head.match(/<h1/g)).toHaveLength(1);
  expect(head).toContain('aria-label="보고 있는 위치"');
  expect(head.match(/aria-current="page"/g)).toHaveLength(1);
  expect(head).toContain('aria-current="page" class');
  expect(head).toMatch(/<li aria-hidden="true"/);
});

test("the action bar states the consequence before the actions", () => {
  const bar = html(<ActionBar consequence={x} actions={y} />);
  expect(bar.indexOf(">x<")).toBeLessThan(bar.indexOf(">y<"));
  expect(html(<ActionBar actions={y} />)).not.toContain(">x<");
});

test("the find box is a named search input with its icon hidden; an avatar is decoration", () => {
  const box = html(<SearchField label={x} value="" onChange={() => undefined} />);
  expect(box).toMatch(/<input[^>]*type="search"/);
  expect(box).toContain('aria-label="x"');
  expect(box).toMatch(/<svg[^>]*aria-hidden="true"/);
  expect(html(<Avatar name=" yoon" />)).toMatch(/aria-hidden="true"[^>]*>y</);
});

// Regression: features wrote className="btn--sm" in ~20 places while app.css never defined it (a silent no-op).
test("every class the button look emits is defined in app.css", () => {
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  const emitted = new Set(
    (["primary", "secondary", "ghost", "danger", "ghost-danger"] as const).flatMap((v) => buttonClass(v, { size: "sm", icon: true }).split(" ")),
  );
  for (const c of emitted) expect(css, c).toMatch(new RegExp(`\\.${c}[\\s.{:\\[]`));
});

test("a short list, a legend and the loading shape: list semantics, words beside every swatch, busy while loading", () => {
  expect(html(<ItemList items={[{ key: "a", text: x, end: y, tone: "ok" }]} />)).toMatch(/^<ul[^>]*><li[^>]*data-tone="ok"[^>]*>.*>x<.*>y<\/span><\/li><\/ul>$/);
  const legend = html(<Legend items={[{ swatch: "new", text: x }]} />);
  expect(legend).toMatch(/<i[^>]*aria-hidden="true"[^>]*><\/i>x/);
  const loading = html(<Skeleton label={z} bones={["title", "row"]} />);
  expect(loading).toContain('aria-busy="true"');
  expect(loading).toContain('aria-label="z"');
  expect(loading.match(/data-bone=/g)).toHaveLength(2);
});

// Regression: `.card.panel` was sticky (app.css .panel), so stacked cards slid over the one above (identifiers).
test("a Card never sticks: it stacks and scrolls with the page", () => {
  const css = readFileSync(new URL("./card/card.module.css", import.meta.url), "utf8");
  expect(css).not.toMatch(/position:\s*sticky/);
  expect(html(<Card title={x}>{y}</Card>)).not.toMatch(/class="[^"]*\bpanel\b/);
});

test("a segmented control is one named group with exactly one pressed segment; a chip's count sits in its own slot", async () => {
  const { Segmented } = await import("./button/segmented");
  const { ToggleButton } = await import("./button/button");
  const seg = html(<Segmented label={x} value="b" onChange={() => undefined} items={[{ id: "a", label: y }, { id: "b", label: z }]} />);
  expect(seg).toMatch(/role="group" aria-label="x"/);
  expect(seg.match(/aria-pressed="true"/g)).toHaveLength(1);
  const chip = html(<ToggleButton look="chip" pressed={false} count={3} countTone="warn">{x}</ToggleButton>);
  expect(chip).toContain("btn--chip");
  expect(chip).toMatch(/<span class="btn__count" data-tone="warn">3<\/span>/);
});

test("a record's photo is named when it stands for the person, an initial is decoration unless it names a missing photo", async () => {
  const { Avatar } = await import("./avatar/avatar");
  expect(html(<Avatar name="김" />)).toContain('aria-hidden="true"');
  expect(html(<Avatar name="김" size="lg" alt={x} />)).toMatch(/role="img" aria-label="x"/);
  expect(html(<Avatar name="김" size="lg" src="/p.jpg" alt={y} />)).toMatch(/<img[^>]*alt="y"/);
});

test("a docked receipt is still one polite status region", async () => {
  const { Receipt } = await import("./receipt/receipt");
  const docked = html(<Receipt placement="docked" state="recorded" message={x} />);
  expect(docked).toMatch(/^<div role="status" class="[^"]+ [^"]+"/);
});
