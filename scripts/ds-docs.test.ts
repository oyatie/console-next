// SPDX-License-Identifier: LicenseRef-Proprietary
// The design-system docs generator (scripts/ds-docs.mjs): what a generated block says, and that drift fails the check.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
// @ts-expect-error: a plain .mjs script, no types
import { markers, render, tokenTable } from "./ds-docs.mjs";

const script = fileURLToPath(new URL("./ds-docs.mjs", import.meta.url));
const repo = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const PAGES = "docs/design-system/components";
const FIX = "node scripts/ds-docs.mjs --write";
const HEAD = "| Prop | Required | Type | Default | Description |\n| --- | --- | --- | --- | --- |";
const empty = (kind: string, arg: string) => `<!-- ds:${kind} ${arg} -->\n<!-- /ds:${kind} -->`;

/**
 * A throwaway repository root holding `files` (path → text). The generator reads a real tsconfig.json and lists the
 * workspace packages under apps/ and packages/, so both exist. `lib` is ES only unless a fixture needs the DOM.
 */
function fixture(files: Record<string, string>, lib = ["ES2023"]) {
  const root = mkdtempSync(path.join(tmpdir(), "ds-docs-"));
  roots.push(root);
  const tsconfig = { compilerOptions: { target: "ES2023", lib, module: "ESNext", moduleResolution: "bundler", jsx: "react-jsx", strict: true, noEmit: true, types: [] }, include: ["apps"] };
  for (const dir of ["apps", "packages"]) mkdirSync(path.join(root, dir));
  for (const [file, text] of Object.entries({ "tsconfig.json": JSON.stringify(tsconfig), ...files })) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
}
const cli = (root: string, ...args: string[]) => spawnSync("node", [script, "--root", root, ...args], { encoding: "utf8" });
const read = (root: string, file: string) => readFileSync(path.join(root, file), "utf8");
/** Bring every page of `root` up to date in process. */
const refresh = (root: string) => render(root).pages.forEach((page: { file: string; next: string }) => writeFileSync(path.join(root, page.file), page.next));
/** What the generator would write between the markers labelled `label`, in the one page of `root`. */
function generated(root: string, label: string) {
  const { pages, problems } = render(root);
  expect(problems).toEqual([]);
  const next: string = pages[0].next;
  expect(next).not.toContain(root);
  expect(next).not.toContain("import(");
  const found = markers(next).blocks.find((b: { label: string }) => b.label === label);
  return next.slice(found.from, found.to).trim();
}

const BADGE = `/** A status word. */
export function Badge({ tone = "ok", label, onPick }: {
  /** What the badge says. */
  label: string;
  /**
   * \`ok\` is calm; \`warn\` waits on someone
   * | or something, and is never a <button>.
   */
  tone?: "ok" | "warn";
  onPick?: (id: string | null) => void;
}) { return null; }
export const helper = (n: number) => n;
export const LIMIT = 3;
export type BadgeTone = "ok" | "warn";
`;
const BADGE_TABLE = `### Badge

${HEAD}
| \`label\` | yes | \`string\` |  | What the badge says. |
| \`onPick\` | no | \`(id: string \\| null) => void\` |  |  |
| \`tone\` | no | \`"ok" \\| "warn"\` | \`"ok"\` | \`ok\` is calm; \`warn\` waits on someone \\| or something, and is never a &lt;button>. |`;
const badgePage = (prose = "# Badge\n\nHand-written.\n") => `${prose}\n${empty("props", "apps/web/src/ui/badge.tsx")}\n`;
const badgeRoot = () => fixture({ [`${PAGES}/badge.md`]: badgePage(), "apps/web/src/ui/badge.tsx": BADGE });

test("inline props: required before optional, the destructuring default, the doc comment, and cells a table can hold", () => {
  expect(generated(badgeRoot(), "ds:props apps/web/src/ui/badge.tsx")).toBe(BADGE_TABLE);
});

test("a re-exported component is documented under the name the module exports, with its defaults", () => {
  const root = fixture({
    [`${PAGES}/pill.md`]: empty("props", "apps/web/src/ui/index.ts"),
    "apps/web/src/ui/badge.tsx": BADGE,
    "apps/web/src/ui/index.ts": 'export { Badge as Pill } from "./badge";\n',
  });
  expect(generated(root, "ds:props apps/web/src/ui/index.ts")).toBe(BADGE_TABLE.replace("### Badge", "### Pill"));
});

test("a union props type gives one table per member; a component without props says so", () => {
  const root = fixture({
    [`${PAGES}/notice.md`]: empty("props", "apps/web/src/ui/notice.tsx"),
    "apps/web/src/ui/notice.tsx": `type Info = { kind: "info"; text: string };
export function Notice(props: Info | { kind: "action"; onPress: () => void; note?: (() => void) | null }) { return null; }
export function Divider() { return null; }
`,
  });
  expect(generated(root, "ds:props apps/web/src/ui/notice.tsx")).toBe(`### Divider

Takes no props.

### Notice

**Shape 1 of 2: \`Info\`**

${HEAD}
| \`kind\` | yes | \`"info"\` |  |  |
| \`text\` | yes | \`string\` |  |  |

**Shape 2 of 2**

${HEAD}
| \`kind\` | yes | \`"action"\` |  |  |
| \`onPress\` | yes | \`() => void\` |  |  |
| \`note\` | no | \`(() => void) \\| null\` |  |  |`);
});

test("props declared in node_modules collapse into one line naming the library type, and what was left out of it", () => {
  const root = fixture({
    [`${PAGES}/anchor.md`]: empty("props", "apps/web/src/ui/anchor.tsx"),
    "node_modules/widgets/index.d.ts": `export interface PressProps { /** Fires on press. */ onPress?: () => void; isDisabled?: boolean }
export interface LinkProps extends PressProps { href?: string; target?: string }
`,
    "apps/web/src/ui/anchor.tsx": `import type { LinkProps } from "widgets";
export function Anchor({ tone = "ok", ...rest }: LinkProps & { tone?: "ok" | "warn" }) { return null; }
export function Bare(props: LinkProps) { return null; }
export function Picky(props: Pick<LinkProps, "href"> & { id: string }) { return null; }
export function Quiet(props: Omit<LinkProps, "href">) { return null; }
export function Preset({ target = "_blank", isDisabled = false, ...rest }: LinkProps) { return null; }
`,
  });
  expect(generated(root, "ds:props apps/web/src/ui/anchor.tsx")).toBe(`### Anchor

${HEAD}
| \`tone\` | no | \`"ok" \\| "warn"\` | \`"ok"\` |  |

Also accepts the attributes of \`LinkProps\` (\`widgets\`).

### Bare

Accepts the attributes of \`LinkProps\` (\`widgets\`).

### Picky

${HEAD}
| \`id\` | yes | \`string\` |  |  |

Also accepts \`href\` of \`LinkProps\` (\`widgets\`).

### Preset

Accepts the attributes of \`LinkProps\` (\`widgets\`). Defaults \`isDisabled\` to \`false\` and \`target\` to \`"_blank"\`.

### Quiet

Accepts the attributes of \`LinkProps\` (\`widgets\`), except \`href\`.`);
});

// Real React types, from this repository's node_modules: forwardRef and memo hide the function that holds the defaults.
test("forwardRef and memo components keep their own props and defaults; React's attributes stay one line", () => {
  const root = fixture({
    [`${PAGES}/real.md`]: empty("props", "apps/web/src/ui/real.tsx"),
    "apps/web/src/ui/real.tsx": `import { forwardRef, memo, type ButtonHTMLAttributes } from "react";
type Props = {
  /** The words. */
  label: string;
  tone?: "ok" | "warn";
};
export const Fwd = forwardRef<HTMLButtonElement, Props>(function Fwd({ label, tone = "ok" }, ref) { return null; });
const Inner = ({ label, tone = "warn" }: Props) => null;
export const Memo = memo(Inner);
export function Native({ busy = false, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> & { busy?: boolean }) { return null; }
`,
  }, ["ES2023", "DOM"]);
  symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"));
  const rows = (tone: string) => `${HEAD}\n| \`label\` | yes | \`string\` |  | The words. |\n| \`tone\` | no | \`"ok" \\| "warn"\` | \`"${tone}"\` |  |`;
  expect(generated(root, "ds:props apps/web/src/ui/real.tsx")).toBe(`### Fwd

${rows("ok")}

Also accepts the attributes of \`RefAttributes\` (\`@types/react\`).

### Memo

${rows("warn")}

### Native

${HEAD}
| \`busy\` | no | \`boolean\` | \`false\` |  |

Also accepts the attributes of \`ButtonHTMLAttributes\` (\`@types/react\`), except \`title\`.`);
}, 60_000);

const CSS = `
.btn { color: var(--ink); outline-color: var(--ink); border: 1px solid var(--border); padding: 0 var( --space-3 ); }
.btn:hover { background: var(--muted); }
@media (width < 768px) { .top .btn { padding-inline: var(--space-2); } }
.chip { color: var(--steel); background: var(--muted, var(--surface)); &:hover { color: var(--ink); } }
.plain { display: flex; }
.btn-group { gap: var(--group-gap); }
.btn--wide .label, .btn__count { min-width: var(--count); }
`;
const tokens = (rows: string[]) => ["| Token | Read by |", "| --- | --- |", ...rows].join("\n");

test("a CSS source lists every token it reads once, sorted, with the properties that read it", () => {
  expect(tokenTable(CSS)).toBe(tokens([
    "| `--border` | `border` |",
    "| `--count` | `min-width` |",
    "| `--group-gap` | `gap` |",
    "| `--ink` | `color`, `outline-color` |",
    "| `--muted` | `background` |",
    "| `--space-2` | `padding-inline` |",
    "| `--space-3` | `padding` |",
    "| `--steel` | `color` |",
    "| `--surface` | `background` |",
  ]));
  expect(tokenTable(".plain { display: flex; }")).toBe("Reads no tokens.");
  // Code-unit order, so a capital sorts before every small letter on any machine.
  expect(tokenTable(".a { color: var(--Zed); margin: var(--apple); }")).toBe(tokens(["| `--Zed` | `color` |", "| `--apple` | `margin` |"]));
});

test("a selector filter keeps the rules that name the class or one of its -- and __ classes, nested rules included", () => {
  // `.btn-group` only starts with the same letters: it is another component's class.
  expect(tokenTable(CSS, ".btn")).toBe(tokens([
    "| `--border` | `border` |",
    "| `--count` | `min-width` |",
    "| `--ink` | `color`, `outline-color` |",
    "| `--muted` | `background` |",
    "| `--space-2` | `padding-inline` |",
    "| `--space-3` | `padding` |",
  ]));
  expect(tokenTable(CSS, ".chip")).toBe(tokens(["| `--ink` | `color` |", "| `--muted` | `background` |", "| `--steel` | `color` |", "| `--surface` | `background` |"]));
  expect(() => tokenTable(CSS, ".button")).toThrow("matches no rule");
});

// Each CLI run starts Node and builds a TypeScript program, so a test makes two at most and sets the rest up in process.
test("--check passes on output --write has just produced", () => {
  const root = badgeRoot();
  expect(cli(root, "--write").status).toBe(0);
  expect(read(root, `${PAGES}/badge.md`)).toContain(BADGE_TABLE);
  const r = cli(root, "--check");
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
});

test("--check fails when a prop is added to the component without regenerating", () => {
  const root = badgeRoot();
  refresh(root);
  writeFileSync(path.join(root, "apps/web/src/ui/badge.tsx"), BADGE.replace("label: string;", "label: string;\n  size?: number;"));
  const r = cli(root);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(`${PAGES}/badge.md: \`ds:props apps/web/src/ui/badge.tsx\` is out of date; run ${FIX}`);
});

test("--check fails when a generated block was edited by hand", () => {
  const root = badgeRoot();
  refresh(root);
  const page = path.join(root, PAGES, "badge.md");
  writeFileSync(page, readFileSync(page, "utf8").replace("What the badge says.", "Anything at all."));
  const r = cli(root);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(`${PAGES}/badge.md: \`ds:props apps/web/src/ui/badge.tsx\` is out of date; run ${FIX}`);
});

test("a source path that does not exist fails, and --write leaves the page alone", () => {
  const page = `# Gone\n\n${empty("props", "apps/web/src/ui/gone.tsx")}\n\n${empty("tokens", "../outside.css")}\n`;
  const root = fixture({ [`${PAGES}/gone.md`]: page, "apps/web/src/ui/badge.tsx": BADGE });
  for (const mode of ["--check", "--write"]) {
    const r = cli(root, mode);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${PAGES}/gone.md: \`ds:props apps/web/src/ui/gone.tsx\` names a source that does not exist`);
    expect(r.stderr).toContain(`${PAGES}/gone.md: \`ds:tokens ../outside.css\` names a source that does not exist`);
  }
  expect(read(root, `${PAGES}/gone.md`)).toBe(page);
});

test("a marker with no closing marker fails", () => {
  const root = fixture({ [`${PAGES}/open.md`]: "# Open\n\n<!-- ds:tokens apps/web/src/ui/a.css -->\n| stale |\n", "apps/web/src/ui/a.css": ".a { color: var(--ink); }\n" });
  const r = cli(root);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(`${PAGES}/open.md: \`ds:tokens apps/web/src/ui/a.css\` is not closed`);
});

test("a page with no generated block, and a block that documents nothing, fail", () => {
  const root = fixture({
    [`${PAGES}/prose.md`]: "# Prose\n\nOnly words.\n",
    [`${PAGES}/thin.md`]: `${empty("props", "apps/web/src/ui/limits.ts")}\n${empty("tokens", "apps/web/src/ui/a.css .missing")}\n`,
    "apps/web/src/ui/limits.ts": "export const LIMIT = 3;\n",
    "apps/web/src/ui/a.css": ".a { color: var(--ink); }\n",
  });
  const r = cli(root);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(`${PAGES}/prose.md: has no generated block`);
  expect(r.stderr).toContain(`${PAGES}/thin.md: \`ds:props apps/web/src/ui/limits.ts\` exports no component`);
  expect(r.stderr).toContain(`${PAGES}/thin.md: \`ds:tokens apps/web/src/ui/a.css .missing\` matches no rule`);
  expect(cli(fixture({})).stderr).toContain(`${PAGES}: no component page found`);
});

test("--write keeps every byte outside the markers, and changes nothing a second time", () => {
  const head = "<!-- a comment that is not a marker -->\r\n# Badge  \n\n\tHand-written, trailing spaces kept   \n\n";
  const middle = "\n\nBetween | two | blocks.\n  ";
  const tail = "\n\n<!-- ds is mentioned here, /ds:props too -->\nNo newline at the end";
  const page = head + empty("props", "apps/web/src/ui/badge.tsx") + middle + empty("tokens", "apps/web/src/ui/a.css") + tail;
  const root = fixture({ [`${PAGES}/badge.md`]: page, "apps/web/src/ui/badge.tsx": BADGE, "apps/web/src/ui/a.css": ".a { color: var(--ink); }\n" });
  expect(cli(root, "--write").status).toBe(0);
  expect(read(root, `${PAGES}/badge.md`)).toBe(
    `${head}<!-- ds:props apps/web/src/ui/badge.tsx -->\n\n${BADGE_TABLE}\n\n<!-- /ds:props -->${middle}<!-- ds:tokens apps/web/src/ui/a.css -->\n\n${tokens(["| `--ink` | `color` |"])}\n\n<!-- /ds:tokens -->${tail}`,
  );
  const written = read(root, `${PAGES}/badge.md`);
  expect(cli(root, "--write").status).toBe(0);
  expect(read(root, `${PAGES}/badge.md`)).toBe(written);
});

test("types the source never imports are read as tsc reads them: an ambient declaration, and an augmentation in another file", () => {
  const root = fixture({
    [`${PAGES}/amb.md`]: empty("props", "apps/web/src/ui/amb.tsx"),
    "apps/web/src/ambient.d.ts": 'interface KitProps {\n  /** The words. */\n  label: string;\n  tone?: "ok" | "warn";\n}\n',
    "apps/web/src/main.ts": "export {};\ndeclare global { interface KitProps { wide?: boolean } }\n",
    "apps/web/src/ui/amb.tsx": `export function Amb(props: KitProps) { return null; }
export function Mixed({ size = "md", ...rest }: KitProps & { size?: "sm" | "md" }) { return null; }
`,
  });
  const kit = '| `label` | yes | `string` |  | The words. |\n%| `tone` | no | `"ok" \\| "warn"` |  |  |\n| `wide` | no | `boolean` |  |  |';
  expect(generated(root, "ds:props apps/web/src/ui/amb.tsx")).toBe(`### Amb

${HEAD}
${kit.replace("%", "")}

### Mixed

${HEAD}
${kit.replace("%", '| `size` | no | `"md" \\| "sm"` | `"md"` |  |\n')}`);
});

test("a source that does not typecheck fails, naming the page, the block and the error, also when the component is declared in another file", () => {
  const root = fixture({
    [`${PAGES}/ghost.md`]: empty("props", "apps/web/src/ui/ghost.tsx"),
    [`${PAGES}/via.md`]: empty("props", "apps/web/src/ui/index.ts"),
    "apps/web/src/ui/ghost.tsx": 'import type { GhostProps } from "no-such-package";\n\nexport function Ghost(props: GhostProps) { return null; }\n',
    "apps/web/src/ui/index.ts": 'export { Ghost } from "./ghost";\n',
  });
  const why = "does not typecheck, so its props cannot be read: apps/web/src/ui/ghost.tsx:1 Cannot find module 'no-such-package' or its corresponding type declarations.";
  expect(render(root).problems).toEqual([
    `${PAGES}/ghost.md: \`ds:props apps/web/src/ui/ghost.tsx\` ${why}`,
    `${PAGES}/via.md: \`ds:props apps/web/src/ui/index.ts\` ${why}`,
  ]);
});

test("a file with a syntax error fails, naming the file, and the page and block when a page names it", () => {
  const root = badgeRoot();
  writeFileSync(path.join(root, "apps/web/src/ui/badge.tsx"), `${BADGE}export function Broken({ a }: { a: string ) { return null; }\n`);
  writeFileSync(path.join(root, "apps/web/src/other.ts"), "export const = 3;\n");
  const { problems } = render(root);
  expect(problems).toHaveLength(2);
  expect(problems[1]).toMatch(/^apps\/web\/src\/other\.ts:1 does not parse \(.+\); no props block can be read until it does$/);
  expect(problems[0]).toMatch(/^docs\/design-system\/components\/badge\.md: `ds:props apps\/web\/src\/ui\/badge\.tsx` does not parse: apps\/web\/src\/ui\/badge\.tsx:15 /);
});

test("a type cell does not depend on the other pages: union members are in one fixed order", () => {
  const root = fixture({
    [`${PAGES}/zed.md`]: empty("props", "apps/web/src/ui/zed.tsx"),
    "apps/web/src/ui/zed.tsx": 'export function Zed({ tone }: { tone?: "calm" | "loud" | "mute"; size: "sm" | "lg"; pick: (to: "b" | "a" | null) => void }) { return null; }\n',
  });
  const alone = generated(root, "ds:props apps/web/src/ui/zed.tsx");
  expect(alone).toBe(`### Zed

${HEAD}
| \`pick\` | yes | \`(to: "a" \\| "b" \\| null) => void\` |  |  |
| \`size\` | yes | \`"lg" \\| "sm"\` |  |  |
| \`tone\` | no | \`"calm" \\| "loud" \\| "mute"\` |  |  |`);
  // A second page whose source names the same literals in another order, and is read first.
  writeFileSync(path.join(root, PAGES, "alpha.md"), empty("props", "apps/web/src/ui/alpha.tsx"));
  writeFileSync(path.join(root, "apps/web/src/ui/alpha.tsx"), 'export function Alpha({ tone }: { tone?: "mute" | "loud" | "calm"; size: "lg" | "sm"; pick: (to: "a" | null | "b") => void }) { return null; }\n');
  const { pages, problems } = render(root);
  expect(problems).toEqual([]);
  expect(pages[1].file).toBe(`${PAGES}/zed.md`);
  expect(pages[1].next).toBe(`<!-- ds:props apps/web/src/ui/zed.tsx -->\n\n${alone}\n\n<!-- /ds:props -->`);
});

test("a default export is documented under its declared name and an overloaded component by its first signature; a class and a helper are named as not documented", () => {
  const root = fixture({
    [`${PAGES}/mixed.md`]: empty("props", "apps/web/src/ui/mixed.tsx"),
    "apps/web/src/ui/mixed.tsx": `export function Over(props: { a: string }): null;
export function Over(props: { a: string; b: number }, extra: number): null;
export function Over(props: { a: string; b?: number }) { return null; }
export default function Defaulted({ label }: { label: string }) { return null; }
export class Boundary { constructor(readonly props: { fallback: string }) {} }
export function FormatAmount(amount: number, currency = "KRW") { return String(amount) + currency; }
export const LIMIT = 3;
`,
  });
  expect(generated(root, "ds:props apps/web/src/ui/mixed.tsx")).toBe(`### Defaulted

${HEAD}
| \`label\` | yes | \`string\` |  |  |

### Over

${HEAD}
| \`a\` | yes | \`string\` |  |  |

Not documented: \`Boundary\` (a class) and \`FormatAmount\` (its first parameter is not a props object).`);
});

test("a comment that looks like a marker but is not one is a problem, and so is a closing marker with no opener; a fenced example and plain words are left alone", () => {
  for (const typo of ["ds-props", "ds: props", "DS:props", "ds_props", "ds.props"]) {
    const found = markers(`<!-- ${typo} a.tsx -->\nstale by hand\n<!-- /${typo} -->`);
    expect(found.blocks).toEqual([]);
    expect(found.problems).toEqual([`<!-- ${typo} a.tsx -->`, `<!-- /${typo} -->`].map((marker) => `\`${marker}\` is not a marker this script reads; write <!-- ds:props path --> or <!-- ds:tokens path -->, and close it with <!-- /ds:props --> or <!-- /ds:tokens -->`));
  }
  expect(markers("words\n<!-- /ds:props -->\n")).toEqual({ blocks: [], problems: ["<!-- /ds:props --> closes no block; remove it or add the opening marker"] });
  for (const fence of ["```", "~~~~"]) expect(markers(`${fence}md\n<!-- ds:props a.tsx -->\n<!-- /ds:props -->\n${fence}\n`)).toEqual({ blocks: [], problems: [] });
  expect(markers("<!-- ds is mentioned here, /ds:props too -->\n<!-- dsl notes -->")).toEqual({ blocks: [], problems: [] });
  // After a fence closes, a marker counts again.
  expect(markers("```\ncode\n```\n<!-- ds:tokens a.css -->\n<!-- /ds:tokens -->").blocks).toHaveLength(1);
});

test("a marker is refused for an unknown kind, the wrong kind of file, a path that is absolute or climbs out, and text after a props path", () => {
  const root = fixture({ "apps/web/src/ui/badge.tsx": BADGE, "apps/web/src/ui/a.css": ".a { color: var(--ink); }\n" });
  const named = ["ds:prosp apps/web/src/ui/badge.tsx", "ds:props apps/web/src/ui/a.css", `ds:tokens ${path.join(root, "apps/web/src/ui/a.css")}`, "ds:tokens docs/../apps/web/src/ui/a.css", "ds:props apps/web/src/ui/badge.tsx Badge"];
  mkdirSync(path.join(root, PAGES), { recursive: true });
  writeFileSync(path.join(root, PAGES, "guards.md"), named.map((label) => `<!-- ${label} -->\n<!-- /${label.split(" ")[0]} -->\n`).join("\n"));
  const outside = "names a source that does not exist; give a file path from the repository root";
  expect(render(root).problems).toEqual([
    "is not a block this script writes; use ds:props or ds:tokens",
    "cannot read apps/web/src/ui/a.css; ds:props takes a .ts or .tsx file and ds:tokens a .css file",
    outside,
    outside,
    "has text after the path; ds:props takes a file path and nothing else",
  ].map((problem, i) => `${PAGES}/guards.md: \`${named[i]}\` ${problem}`));
});

test("a page with Windows line endings is compared by its text, and a rewritten block keeps the page's line endings", () => {
  const root = badgeRoot();
  refresh(root);
  const page = path.join(root, PAGES, "badge.md");
  writeFileSync(page, readFileSync(page, "utf8").replaceAll("\n", "\r\n"));
  expect(render(root).pages[0].stale).toEqual([]);
  writeFileSync(path.join(root, "apps/web/src/ui/badge.tsx"), BADGE.replace("label: string;", "label: string;\n  size?: number;"));
  const [after] = render(root).pages;
  expect(after.stale).toEqual(["ds:props apps/web/src/ui/badge.tsx"]);
  expect(after.next).toContain("| `size` | no | `number` |  |  |\r\n");
  expect(after.next).not.toMatch(/(?<!\r)\n/);
});

test("the script runs when it is started through a symlinked path", () => {
  const root = badgeRoot();
  const linked = mkdtempSync(path.join(tmpdir(), "ds-docs-link-"));
  roots.push(linked);
  symlinkSync(path.resolve(repo), path.join(linked, "repo"));
  const r = spawnSync("node", [path.join(linked, "repo/scripts/ds-docs.mjs"), "--root", root], { encoding: "utf8" });
  expect(r.stderr).toContain(`${PAGES}/badge.md: \`ds:props apps/web/src/ui/badge.tsx\` is out of date; run ${FIX}`);
  expect(r.status).toBe(1);
});

test("npm run check runs the generator's check, straight after the reach check", () => {
  expect(JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).scripts.check).toContain("node scripts/check-reach.mjs && node scripts/ds-docs.mjs --check && ");
});
