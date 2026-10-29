// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "source-layout-"));
  roots.push(root);
  const write = (file: string, text: string | Buffer) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  git("init", "--quiet");
  for (const dir of ["packages/api/src", "packages/i18n/src", "e2e"]) mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ["account/Account", "home/Home", "org/OrgChange", "people/Accounts", "people/ExitCase", "people/People", "platform/Tenants"])
    write(`apps/web/src/features/${file}.tsx`, "");
  for (const file of ["check-hermetic.test.mjs", "check-source.test.ts"])
    write(`scripts/${file}`, readFileSync(path.join(import.meta.dirname, file), "utf8"));
  write("oxlint.json", '{"overrides":[]}');
  const run = () => spawnSync(process.execPath, [path.resolve(import.meta.dirname, "check-source.mjs")], { cwd: root, encoding: "utf8" });
  return { write, git, run };
}

test("component journeys and gallery cache fixtures preserve production source rules", () => {
  const { write, git, run } = fixture();
  const slice = "apps/web/src/features/probe/ui/";
  write(`${slice}grid.spec.ts`, "");
  write(`${slice}grid.playwright.ts`, "");
  write(`${slice}grid.gallery.module.css`, "");
  const seed = "cache.setQueryData(descriptor.queryKey, []);";
  write(`${slice}grid.gallery.tsx`, seed);
  write(`${slice}screen.tsx`, seed);
  write(`${slice}misplaced.ts`, "");
  git("add", ".");
  const result = run();
  expect(result.status).toBe(1);
  for (const file of ["grid.spec.ts", "grid.playwright.ts", "grid.gallery.module.css", "grid.gallery.tsx"]) {
    expect(result.stderr).not.toContain(`${slice}${file}:`);
  }
  expect(result.stderr).toContain(`${slice}screen.tsx: queryKey ×1`);
  expect(result.stderr).toContain(`${slice}screen.tsx: cacheWrites ×1`);
  expect(result.stderr).toContain(`${slice}misplaced.ts: a slice holds only`);
});

test("only go-live may synchronize its confirmed phase through the shared profile descriptor", () => {
  const { write, git, run } = fixture();
  const file = "apps/web/src/features/onboarding/ui/go-live.tsx";
  const source = 'import { meQuery } from "../../account/api"; cache.setQueriesData(meQuery, confirmedPhase);';
  write("apps/web/src/features/account/api.ts", "");
  write(file, source);
  git("add", ".");
  expect(run().status).toBe(0);
  write(file, source + " cache.setQueryData(other.queryKey, []);");
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${file}: cacheWrites ×1`);
  expect(result.stderr).toContain(`${file}: queryKey ×1`);
});

test.each(["relay/antigravity/reports/ATT-GRAMMAR.1.md", "lanes/proof.txt", "docs/lanes/lmg-depth-ent.md"])("refuses tracked delivery evidence: %s", (file) => {
  const { write, git, run } = fixture();
  write(file, "Delivery proof\n");
  git("add", ".");
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${file}: delivery evidence belongs outside the product repository`);
});

test.each([
  "/Users/operator/Library/Caches/console-target",
  "/home/operator/console/proof.log",
  "file:///Users/operator/console/proof.log",
  "/home/runner-local/proof.log",
  "/private/tmp/console-proof.log",
  String.raw`C:\Users\operator\console\proof.log`,
  String.raw`C:\\Users\\operator\\console\\proof.log`,
])("refuses tracked text with a local machine path: %s", (machinePath) => {
  const { write, git, run } = fixture();
  write("docs/ci.md", `# CI\nEvidence: \`${machinePath}\`\n`);
  git("add", ".");
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("docs/ci.md:2: local machine path");
});

test("refuses local paths outside Markdown and reads working-tree changes to tracked files", () => {
  const { write, git, run } = fixture();
  write("Dockerfile", "FROM scratch\n");
  git("add", ".");
  write("Dockerfile", "FROM scratch\nCOPY /Users/operator/proof /proof\n");
  expect(run().stderr).toContain("Dockerfile:2: local machine path");
});

test("refuses the original support-access document's local proof", () => {
  const { write, git, run } = fixture();
  write("docs/ops/support-access.md", "# Tenant-approved support access\n\n## Verification and hand-off\n\nThe fail-before worktree and logs are under `/Users/operator/Developer/frontend/lanes/support`.\n");
  git("add", ".");
  expect(run().stderr).toContain("docs/ops/support-access.md:5: local machine path");
});

test("permits CI runner paths, relative product paths, binaries, untracked evidence and reasoned fixtures", () => {
  const { write, git, run } = fixture();
  write("docs/operator.md", "/home/runner/work/console\napps/web/src/features/home/ui/screen.tsx\nhttps://example.invalid/home/operator/\n");
  write("image.bin", Buffer.from("\0/Users/operator/binary-payload"));
  git("add", ".");
  write("relay/local-proof.md", "/Users/operator/private-proof\n");
  const result = run();
  expect(result.status, result.stderr).toBe(0);
});

test("refuses stale local-path fixture exemptions", () => {
  const { write, git, run } = fixture();
  write("scripts/check-hermetic.test.mjs", "// No more host-path fixtures.\n");
  git("add", ".");
  expect(run().stderr).toContain("stale baseline local-path fixture (delete it): scripts/check-hermetic.test.mjs");
});

test("identifiers reuses only the canonical people privacy client and component", () => {
  const { write, git, run } = fixture();
  write("apps/web/src/features/people/api/record.ts", "");
  write("apps/web/src/features/people/ui/rrn-field.tsx", "");
  write("apps/web/src/features/people/ui/other.tsx", "");
  write("apps/web/src/features/identifiers/api.ts", 'export { rrnStatusQuery } from "../people/api/record";');
  write("apps/web/src/features/identifiers/ui/rrn-card.tsx", 'import { RrnField } from "../../people/ui/rrn-field";');
  git("add", ".");
  expect(run().status).toBe(0);
  write("apps/web/src/features/identifiers/ui/rrn-card.tsx", 'import { Other } from "../../people/ui/other";');
  expect(run().stderr).toContain("features never import other features");
});

test("permits the upstream Rollouts container mount but still refuses host paths in that manifest", () => {
  const { write, git, run } = fixture();
  const manifest = "deploy/base/platform/rollouts.yaml";
  const mount = "volumeMounts:\n  - mountPath: /home/argo-rollouts/plugin-bin\n";
  write(manifest, mount);
  git("add", ".");
  expect(run().status).toBe(0);
  write(manifest, `${mount}# Evidence: /Users/operator/private-proof\n`);
  expect(run().stderr).toContain(`${manifest}:3: local machine path`);
});
