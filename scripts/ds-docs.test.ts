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
`;
const tokens = (rows: string[]) => ["| Token | Read by |", "| --- | --- |", ...rows].join("\n");

test("a CSS source lists every token it reads once, sorted, with the properties that read it", () => {
  expect(tokenTable(CSS)).toBe(tokens([
    "| `--border` | `border` |",
    "| `--ink` | `color`, `outline-color` |",
    "| `--muted` | `background` |",
    "| `--space-2` | `padding-inline` |",
    "| `--space-3` | `padding` |",
    "| `--steel` | `color` |",
    "| `--surface` | `background` |",
  ]));
  expect(tokenTable(".plain { display: flex; }")).toBe("Reads no tokens.");
});

test("a selector filter keeps only rules whose selector contains the text, nested rules included", () => {
  expect(tokenTable(CSS, ".btn")).toBe(tokens([
    "| `--border` | `border` |",
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
