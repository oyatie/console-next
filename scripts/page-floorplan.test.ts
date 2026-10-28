// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { floorplanFindings, pageSpacingFindings } from "./quality/ratchet.mjs";

test.each([
  '<><PageHead title="Extra" /><Page floorplan="list" head={{title:"List"}}>Body</Page></>',
  '<Page floorplan="list" head={{title:"List"}}><h1>Extra</h1></Page>',
  '<><Page floorplan="list" head={{title:"A"}}>A</Page><Page floorplan="record" head={{title:"B"}}>B</Page></>',
  '<Sheet><PageHead title="Extra" /><Page floorplan="form" head={{title:"Form"}}>Body</Page></Sheet>',
])("the ratchet refuses two document headings: %s", jsx => {
  expect(floorplanFindings(`export const Screen = () => (${jsx});`).multipleH1).toBe(1);
});

test.each([
  '<Page floorplan="list" head={{title:"List"}}><PageHead title="Section" /><Page floorplan="form" head={{title:"Form"}}>Body</Page></Page>',
  '<PageHeadingLevel value={2}><PageHead title="Section" /><Page floorplan="form" head={{title:"Form"}}>Body</Page></PageHeadingLevel>',
  '<ListPage q={q} head={{title:"List"}}>{rows => <div>{rows.length}</div>}</ListPage>',
])("secondary headings and templates pass: %s", jsx => {
  expect(floorplanFindings(`export const Screen = () => (${jsx});`)).toEqual({});
});

test("missing floorplans, legacy heads and raw module h1s remain counted", () => {
  expect(floorplanFindings('export const Screen = () => <main className="page"><div className="page__head"><h1 className="page__title">Title</h1></div></main>;'))
    .toEqual({ missingFloorplan: 1, legacyHead: 1, legacyTitle: 1, moduleH1: 1 });
  expect(floorplanFindings('export const Screen = () => <PageHead title="Title" />;').missingFloorplan).toBe(1);
});

test("aliases cannot evade the heading ratchet", () => {
  expect(floorplanFindings('import {Page as Frame} from "../ui/page/page"; import {PageHead as Head} from "../ui/page-head/page-head"; export const Screen = () => <><Head title="Extra" /><Frame floorplan="list" head={{title:"List"}}>Body</Frame></>;').multipleH1).toBe(1);
});

test("namespace imports cannot evade the heading ratchet", () => {
  const imports = 'import * as UI from "../ui/page/page"; import * as Heading from "../ui/page-head/page-head";';
  expect(floorplanFindings(`${imports} export const Screen = () => <><Heading.PageHead title="Extra" /><UI.Page floorplan="list" head={{title:"List"}}>Body</UI.Page></>;`).multipleH1).toBe(1);
  expect(floorplanFindings(`${imports} export const Screen = () => <Heading.PageHead title="Title" />;`).missingFloorplan).toBe(1);
  expect(floorplanFindings(`${imports} export const Screen = () => <UI.Page floorplan="list" head={{title:"List"}}><Heading.PageHead title="Section" /></UI.Page>;`)).toEqual({});
});

test("another heading cannot hide inside an already indebted frame", () => {
  expect(floorplanFindings('export const Screen = () => <><PageHead title="A" /><PageHead title="B" /><PageHead title="C" /></>;').multipleH1).toBe(2);
});

test("the spacing ratchet counts declarations, excluding comments and non-spacing properties", async () => {
  expect(await pageSpacingFindings('.page { margin: var(--space-3); padding-inline: var(--space-2); }')).toEqual({ pageSpacing: 2 });
  expect(await pageSpacingFindings('/* margin: 4px; */ .page { content: "{ padding: 4px; }"; scroll-padding-top: var(--space-2); }')).toEqual({});
  await expect(Promise.resolve().then(() => pageSpacingFindings('.page { padding:'))).rejects.toThrow();
});

test("floorplan Phase A runs against the repository without growing inherited debt", () => {
  const run = spawnSync("node", ["scripts/quality/ratchet.mjs"], { encoding: "utf8" });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  expect(run.stdout).toContain("floorplan Phase A: pass");
});

test("the executable ratchet rejects a planted sibling heading and permits nested secondary heads", () => {
  const root = mkdtempSync(join(tmpdir(), "floorplan-"));
  const screen = join(root, "apps/web/src/screen.tsx");
  const script = resolve("scripts/quality/ratchet.mjs");
  const good = 'export const Screen = () => <Page floorplan="list" head={{title:"List"}}><PageHead title="Section" /></Page>;';
  try {
    mkdirSync(join(root, "apps/web/src"), { recursive: true });
    writeFileSync(screen, good);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-b", "dev");
    git("add", ".");
    git("-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", "commit", "-m", "fixture");
    const run = () => spawnSync("node", [script, "--root", root], { encoding: "utf8", env: { ...process.env, QUALITY_BASE: "dev" } });
    expect(run().status).toBe(0);
    writeFileSync(screen, 'export const Screen = () => <><PageHead title="Extra" /><Page floorplan="list" head={{title:"List"}}>Body</Page></>;');
    const bad = run();
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("multipleH1");
    writeFileSync(screen, 'export const Screen = () => <main><PageHead title="Title" /></main>;');
    expect(run().stderr).toContain("missingFloorplan");
    writeFileSync(screen, good);
    expect(run().status).toBe(0);
    const css = join(root, "apps/web/src/features/example/ui/page.module.css");
    mkdirSync(join(root, "apps/web/src/features/example/ui"), { recursive: true });
    writeFileSync(css, '.page { margin: var(--space-3); }');
    expect(run().stderr).toContain("pageSpacing");
    rmSync(css);
    expect(run().status).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("renamed pages retain inherited debt but reject additional headings", () => {
  const root = mkdtempSync(join(tmpdir(), "floorplan-rename-"));
  const directory = join(root, "apps/web/src");
  const old = join(directory, "before.tsx"), renamed = join(directory, "after.tsx");
  const indebted = 'export const Screen = () => <main><PageHead title="Title" /></main>;';
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(old, indebted);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-b", "dev");
    git("add", ".");
    git("-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", "commit", "-m", "fixture");
    git("mv", "apps/web/src/before.tsx", "apps/web/src/after.tsx");
    const run = () => spawnSync("node", [resolve("scripts/quality/ratchet.mjs"), "--root", root], { encoding: "utf8", env: { ...process.env, QUALITY_BASE: "dev" } });
    const moved = run();
    expect(moved.status, moved.stderr).toBe(0);
    writeFileSync(renamed, indebted.replace("</main>", '<PageHead title="Extra" /></main>'));
    const bad = run();
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("multipleH1");
    writeFileSync(renamed, indebted);
    git("-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", "commit", "-m", "rename");
    expect(run().status).toBe(0);
    writeFileSync(old, indebted);
    const added = run();
    expect(added.status).toBe(1);
    expect(added.stderr).toContain("before.tsx: missingFloorplan");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(["dev", "public/dev", "review-base"])("advancing %s cannot turn inherited floorplan debt into new debt", ref => {
  const root = mkdtempSync(join(tmpdir(), "floorplan-base-"));
  const screen = join(root, "apps/web/src/screen.tsx");
  const inherited = 'export const Screen = () => <main><PageHead title="Title" /></main>;';
  const env = { ...process.env };
  delete env.QUALITY_BASE;
  if (ref === "review-base") env.QUALITY_BASE = ref;
  try {
    mkdirSync(join(root, "apps/web/src"), { recursive: true });
    writeFileSync(screen, inherited);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    const commit = (message: string) => {
      git("add", ".");
      git("-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", "commit", "-m", message);
    };
    git("init", "-b", "dev");
    commit("inherited debt");
    git("switch", "-c", "lane");
    writeFileSync(join(root, "lane.txt"), "lane work");
    commit("lane work");
    git("switch", "dev");
    writeFileSync(screen, 'export const Screen = () => <Page floorplan="list" head={{title:"Title"}}>Body</Page>;');
    commit("dev clears debt");
    if (ref !== "dev") git("update-ref", ref === "public/dev" ? "refs/remotes/public/dev" : "refs/heads/review-base", "HEAD");
    git("switch", "lane");
    const run = () => spawnSync("node", [resolve("scripts/quality/ratchet.mjs"), "--root", root], { encoding: "utf8", env });
    const unchanged = run();
    expect(unchanged.status, unchanged.stderr).toBe(0);
    writeFileSync(screen, inherited.replace("</main>", '<PageHead title="Extra" /></main>'));
    const added = run();
    expect(added.status).toBe(1);
    expect(added.stderr).toContain("multipleH1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
