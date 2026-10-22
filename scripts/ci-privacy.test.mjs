// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load } from "js-yaml";

const root = new URL("../", import.meta.url);
const workflow = () => load(readFileSync(new URL(".github/workflows/ci.yml", root), "utf8"));

test("public test topology has no restricted paths or production services", () => {
  const tracked = spawnSync("git", ["diff", "cutover/preflip-r2", "--name-only", "--diff-filter=ACMR", "-z"], { encoding: "utf8" }).stdout.split("\0");
  assert.deepEqual(tracked.filter((file) => /^(ops|tools|deploy)\//.test(file)), []);
  const stack = load(readFileSync(new URL("e2e/stack/compose.yml", root), "utf8"));
  assert.deepEqual(Object.keys(stack.services).sort(), ["mailpit", "otel-collector", "postgres", "postgres-topology", "seaweedfs"]);
  assert.equal(stack.services.postgres.image, "${CONSOLE_POSTGRES_IMAGE:?}");
  assert.equal(stack.services["postgres-topology"].image, stack.services.postgres.image);
  for (const service of Object.values(stack.services)) {
    assert.equal(service.build, undefined);
    assert.equal(service.extra_hosts, undefined);
    assert.equal(service.container_name, undefined);
  }
  const launcher = readFileSync(new URL("scripts/backend-dev.mjs", root), "utf8");
  assert.ok(launcher.includes("e2e/stack/compose.yml"));
  assert.doesNotMatch(launcher, /ops\//);
  assert.doesNotMatch(readFileSync(new URL("scripts/ci/bootstrap-db.sh", root), "utf8"), /ops\//);
});

test("structural scanner catches planted controls without printing their values", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-structural-controls-"));
  const scanner = new URL("scripts/client-data-scan.py", root).pathname;
  try {
    assert.equal(spawnSync("git", ["init", "-q", dir]).status, 0);
    const control = ["contact", "planted.invalid-domain.kr"].join("@");
    writeFileSync(path.join(dir, "fixture.txt"), control);
    assert.equal(spawnSync("git", ["-C", dir, "add", "."]).status, 0);
    const result = spawnSync("python3", [scanner, "--root", dir, "--tree"], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /client-data: email/);
    assert.ok(!result.stdout.includes(control));
    writeFileSync(path.join(dir, "fixture.txt"), "contact@example.invalid");
    assert.equal(spawnSync("python3", [scanner, "--root", dir, "--tree"], { encoding: "utf8" }).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("clean upload payload passes the existing structural and checksum gates", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-clean-upload-"));
  try {
    writeFileSync(path.join(dir, "summary.md"), "12 tests passed; contact@example.invalid\n");
    const result = spawnSync("node", ["scripts/ci/privacy.mjs", dir], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("private terms are supplied only to trusted runs in a temporary environment file", () => {
  for (const job of Object.values(workflow().jobs)) {
    const step = job.steps.find((s) => s.name === "Prepare optional trusted client-data rules");
    assert.ok(step);
    assert.match(step.if, /github.event_name == 'merge_group'/);
    assert.match(step.if, /github.event_name == 'push' && github.ref == 'refs\/heads\/dev'/);
    assert.doesNotMatch(step.if, /pull_request/);
    assert.equal(step.env.CLIENT_DATA_TERMS, "${{ secrets.CONSOLE_CLIENT_DATA_TERMS }}");
    assert.match(step.run, /umask 077/);
    assert.match(step.run, /CONSOLE_CLIENT_DATA_TERMS_FILE=/);
  }
});

test("upload scanner inspects archives, encodings and private terms without echoing controls", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-upload-controls-"));
  try {
    const script = `import io,sys,tarfile,zipfile,subprocess\nfrom pathlib import Path\np=Path(sys.argv[1]);data=sys.argv[2].encode()\n(p/'plain.txt').write_bytes(data)\n(p/'utf16.txt').write_bytes(sys.argv[2].encode('utf-16'))\nwith zipfile.ZipFile(p/'payload.zip','w',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('body.txt',data)\nwith tarfile.open(p/'payload.tar.gz','w:gz') as t:\n i=tarfile.TarInfo('body.txt');i.size=len(data);t.addfile(i,io.BytesIO(data))\nwith tarfile.open(p/'payload.tar','w') as t:\n i=tarfile.TarInfo('body.txt');i.size=len(data);t.addfile(i,io.BytesIO(data))\nsubprocess.run(['zstd','-q','-f',str(p/'payload.tar')],check=True)\n`;
    const run = (file, env = {}) => spawnSync("node", ["scripts/ci/privacy.mjs", path.join(dir, file)], { encoding: "utf8", env: { ...process.env, ...env } });
    const prepare = (value) => assert.equal(spawnSync("python3", ["-c", script, dir, value], { encoding: "utf8" }).status, 0);
    const files = ["plain.txt", "utf16.txt", "payload.zip", "payload.tar.gz", "payload.tar.zst"];
    prepare("contact@example.invalid");
    for (const file of files) assert.equal(run(file).status, 0, file);
    const control = ["contact", "planted.invalid-domain.kr"].join("@");
    prepare(control);
    for (const file of files) {
      const result = run(file);
      assert.equal(result.status, 1, file);
      assert.ok(!(result.stdout + result.stderr).includes(control));
    }
    const digits = [0, 1, 0, 1, 0, 1, 3, 2, 4, 6, 8, 0];
    const weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
    const check = (11 - digits.reduce((sum, d, i) => sum + d * weights[i], 0) % 11) % 10;
    prepare(digits.join("") + check);
    for (const file of files) assert.equal(run(file).status, 1, file);
    prepare(String(Number(digits.join("") + check)));
    for (const file of files) assert.equal(run(file).status, 1, file);
    prepare("a harmless synthetic company marker");
    const terms = path.join(dir, "private-terms");
    writeFileSync(terms, "synthetic company marker\n", { mode: 0o600 });
    assert.equal(run("payload.zip", { CONSOLE_CLIENT_DATA_TERMS_FILE: terms }).status, 1);
    writeFileSync(path.join(dir, "unknown.bin"), Buffer.from([0, 1, 2, 3]));
    assert.equal(run("unknown.bin").status, 1);
    mkdirSync(path.join(dir, "sccache"));
    const prefix = Buffer.from([1, 0, 0, 0, 0, 0]);
    writeFileSync(path.join(dir, "sccache", "entry"), Buffer.concat([prefix, Buffer.from("harmless metadata")]));
    assert.equal(run("sccache/entry").status, 0);
    writeFileSync(path.join(dir, "sccache", "entry"), Buffer.concat([prefix, Buffer.from(control)]));
    assert.equal(run("sccache/entry").status, 1);
    const browsers = path.join(dir, "public-browsers");
    mkdirSync(browsers);
    writeFileSync(path.join(browsers, "distribution.bin"), Buffer.from([0, 1, 2, 3]));
    const inventory = path.join(dir, "public-browsers.json");
    assert.equal(spawnSync("python3", ["scripts/ci/public-browser-cache.py", browsers, inventory]).status, 0);
    const provenance = { CONSOLE_PUBLIC_BROWSER_MANIFEST_FILE: inventory };
    assert.equal(run("public-browsers", provenance).status, 0);
    writeFileSync(path.join(browsers, "distribution.bin"), control);
    assert.equal(run("public-browsers", provenance).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("shared nextest metadata removes upstream contacts and preserves executable bytes", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-nextest-metadata-"));
  try {
    const contact = ["upstream", "planted.invalid-domain.kr"].join("@");
    const manifest = { packages: [{ name: "fixture", authors: [contact] }], workspace_members: ["fixture"] };
    writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(manifest));
    const archive = path.join(dir, "workspace.tar.zst");
    const create = spawnSync("python3", ["-c", `import io,tarfile,subprocess,sys\nfrom pathlib import Path\np=Path(sys.argv[1])\nwith tarfile.open(p/'workspace.tar','w') as t:\n for name,data in [('target/nextest/cargo-metadata.json',(p/'metadata.json').read_bytes()),('target/debug/test',b'executable-marker')]:\n  i=tarfile.TarInfo(name);i.size=len(data);i.mode=0o755;t.addfile(i,io.BytesIO(data))\nsubprocess.run(['zstd','-q',str(p/'workspace.tar')],check=True)\n`, dir], { encoding: "utf8" });
    assert.equal(create.status, 0, create.stderr);
    const result = spawnSync("python3", ["scripts/ci/sanitize-nextest.py", archive, path.join(dir, "metadata.json")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "metadata.json"), "utf8")).packages[0].authors, []);
    const verify = spawnSync("python3", ["-c", `import io,json,tarfile,subprocess,sys\ndata=subprocess.check_output(['zstd','-dq','-c',sys.argv[1]])\nwith tarfile.open(fileobj=io.BytesIO(data)) as t:\n assert json.load(t.extractfile('target/nextest/cargo-metadata.json'))['packages'][0]['authors']==[]\n assert t.extractfile('target/debug/test').read()==b'executable-marker'\n assert t.getmember('target/debug/test').mode==0o755\n`, archive], { encoding: "utf8" });
    assert.equal(verify.status, 0, verify.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
