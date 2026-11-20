// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CUTOVER_VERSION,
  checkMigrationCrypto,
  isExemptMigration,
  parseMigrationVersion,
  scanMigrationSql,
} from "./check-migration-crypto.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = "backend/crates/platform/db/migrations";

function withTempMigrations(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "migration-crypto-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, MIGRATIONS_DIR);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content, "utf8");
  }
  return root;
}

test("repository migrations pass at cutover and scanAll finds only the 3 historical md5 migrations", () => {
  assert.deepEqual(checkMigrationCrypto(REPO_ROOT), []);

  const allProblems = checkMigrationCrypto(REPO_ROOT, { scanAll: true });
  assert.ok(allProblems.length > 0, "expected historical md5 calls when scanAll is enabled");
  const matchedFiles = new Set(allProblems.map((p) => path.basename(p.split(":")[0])));
  assert.deepEqual(
    [...matchedFiles].sort(),
    [
      "0249_scrub_import_pii2.sql",
      "0313_employment_periods.sql",
      "20261106000000000_scrub_formatted_import_values.sql",
    ],
  );
});

test("version parsing and cutover boundaries handle 4, 14, 17-digit, and unversioned names", (t) => {
  assert.equal(parseMigrationVersion("0313_employment_periods.sql"), 313n);
  assert.equal(parseMigrationVersion("20261121000000_fourteen.sql"), 20261121000000000n);
  assert.equal(parseMigrationVersion("20261120143002000_cutover.sql"), CUTOVER_VERSION);
  assert.equal(parseMigrationVersion("unversioned_bad.sql"), null);

  assert.equal(isExemptMigration("0313_legacy.sql"), true);
  assert.equal(isExemptMigration("0361_legacy.sql"), true);
  assert.equal(isExemptMigration("20261120143002000_cutover.sql"), true);
  assert.equal(isExemptMigration("20261120143003000_next.sql"), false);
  assert.equal(isExemptMigration("20261121000000_fourteen_digit.sql"), false);
  assert.equal(isExemptMigration("unversioned_bad.sql"), false);

  const root = withTempMigrations(t, {
    "0313_legacy.sql": "SELECT md5('legacy');\n",
    "20261120143002000_cutover.sql": "SELECT md5('cutover');\n",
    "20261120143003000_next.sql": "SELECT md5('post-cutover');\n",
    "20261121000000_fourteen_digit.sql": "SELECT digest(x, 'sha1');\n",
    "unversioned_bad.sql": "SELECT sha1('x');\n",
  });

  const problems = checkMigrationCrypto(root);
  const flaggedFiles = new Set(problems.map((p) => path.basename(p.split(":")[0])));
  assert.deepEqual(
    [...flaggedFiles].sort(),
    ["20261120143003000_next.sql", "20261121000000_fourteen_digit.sql", "unversioned_bad.sql"],
  );
});

test("detects banned legacy calls, weak digest/hmac algorithms, and PL/pgSQL dollar-quoted bodies", () => {
  const badSql = `
    SELECT md5(col), MD5 (col), MD5 /* inline comment */ (col), pg_catalog.md5(col), "md5"(col);
    SELECT sha1(col), public.sha1(col);
    SELECT digest(col, 'md5'), encode(digest(v_body::text, 'MD5'::text), 'hex');
    SELECT public.digest(
      convert_to(x, 'UTF8'),
      'sha1'
    );
    SELECT digest(x, 'SHA-1'), hmac(x, k, 'md5'), hmac(convert_to(x, 'UTF8'), k, 'sha1');
    CREATE FUNCTION f(x text) RETURNS text AS $$
    BEGIN
      RETURN md5(x);
    END;
    $$ LANGUAGE plpgsql;
    DO $body$
    BEGIN
      PERFORM digest(x, 'ripemd160');
    END;
    $body$;
    SELECT pgp_sym_encrypt(x, k), pgp_sym_decrypt(y, k), pgp_pub_encrypt(x, k), pgp_pub_decrypt(y, k);
    SELECT encrypt(x, k, 'aes'), decrypt(y, k, 'aes'), encrypt_iv(x, k, iv, 'aes'), decrypt_iv(y, k, iv, 'aes');
    SELECT crypt(x, gen_salt('bf'));
  `;

  const violations = scanMigrationSql("20261121000000000_bad.sql", badSql);
  const rules = violations.map((v) => v.rule);

  assert.equal(rules.filter((r) => r === "banned-md5").length, 6);
  assert.equal(rules.filter((r) => r === "banned-sha1").length, 2);
  assert.equal(rules.filter((r) => r === "weak-digest-algorithm").length, 5);
  assert.equal(rules.filter((r) => r === "weak-hmac-algorithm").length, 2);
  assert.ok(rules.includes("banned-pgp_sym_encrypt"));
  assert.ok(rules.includes("banned-pgp_sym_decrypt"));
  assert.ok(rules.includes("banned-pgp_pub_encrypt"));
  assert.ok(rules.includes("banned-pgp_pub_decrypt"));
  assert.ok(rules.includes("banned-encrypt"));
  assert.ok(rules.includes("banned-decrypt"));
  assert.ok(rules.includes("banned-encrypt_iv"));
  assert.ok(rules.includes("banned-decrypt_iv"));
  assert.ok(rules.includes("banned-crypt"));
  assert.ok(rules.includes("banned-gen_salt"));
});

test("ignores comments, string prose literals, safe sha256/sha512 calls, and safe identifiers", () => {
  const safeSql = `
    -- md5(col) and digest(x, 'sha1') in line comment
    /* nested /* md5(col) */ hmac(a, b, 'md5') */
    COMMENT ON COLUMN t.c IS 'Migrated from md5(x) and sha1';
    DO $$
    BEGIN
      RAISE EXCEPTION 'sha1 and md5(x) are not allowed';
      PERFORM E'escaped \\' md5(x)';
    END;
    $$;
    SELECT
      digest(convert_to(x, 'UTF8'), 'sha256'),
      hmac(x, k, 'sha256'),
      sha256(convert_to(x, 'UTF8')),
      digest(x, 'sha512'),
      md5_legacy,
      sha1_migrated,
      obj.md5
    FROM t;
  `;

  assert.deepEqual(scanMigrationSql("20261121000000000_safe.sql", safeSql), []);
});

test("CLI exits 0 on clean migrations and 1 when a violation is present", (t) => {
  const script = path.join(REPO_ROOT, "scripts/check-migration-crypto.mjs");
  const cleanRoot = withTempMigrations(t, {
    "20261121000000000_clean.sql": "SELECT encode(digest(convert_to(v, 'UTF8'), 'sha256'), 'hex');\n",
  });
  const cleanRun = spawnSync(process.execPath, [script, "--root", cleanRoot], { encoding: "utf8" });
  assert.equal(cleanRun.status, 0, cleanRun.stderr);
  assert.match(cleanRun.stdout, /1 migration\(s\) checked.*0 problem\(s\)/);

  const dirtyRoot = withTempMigrations(t, {
    "20261121000000000_dirty.sql": "SELECT md5(v);\n",
  });
  const dirtyRun = spawnSync(process.execPath, [script, "--root", dirtyRoot], { encoding: "utf8" });
  assert.equal(dirtyRun.status, 1);
  assert.match(dirtyRun.stderr, /20261121000000000_dirty\.sql:1:/);
});
