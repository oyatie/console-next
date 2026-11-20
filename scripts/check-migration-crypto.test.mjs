// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  assert.equal(allProblems.length, 4);
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

test("detects banned legacy calls including bytea variants, weak digest/hmac, and PL/pgSQL blocks", () => {
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
    DO LANGUAGE plpgsql $$
    BEGIN
      PERFORM md5(x);
    END;
    $$;
    SELECT pgp_sym_encrypt(x, k), pgp_sym_decrypt(y, k), pgp_pub_encrypt(x, k), pgp_pub_decrypt(y, k);
    SELECT pgp_sym_encrypt_bytea(x, k), pgp_sym_decrypt_bytea(y, k), pgp_pub_encrypt_bytea(x, k), pgp_pub_decrypt_bytea(y, k);
    SELECT encrypt(x, k, 'aes'), decrypt(y, k, 'aes'), encrypt_iv(x, k, iv, 'aes'), decrypt_iv(y, k, iv, 'aes');
    SELECT crypt(x, gen_salt('bf'));
  `;

  const violations = scanMigrationSql("20261121000000000_bad.sql", badSql);
  const rules = violations.map((v) => v.rule);

  assert.equal(rules.filter((r) => r === "banned-md5").length, 7);
  assert.equal(rules.filter((r) => r === "banned-sha1").length, 2);
  assert.equal(rules.filter((r) => r === "weak-digest-algorithm").length, 5);
  assert.equal(rules.filter((r) => r === "weak-hmac-algorithm").length, 2);
  for (const fn of [
    "pgp_sym_encrypt",
    "pgp_sym_decrypt",
    "pgp_pub_encrypt",
    "pgp_pub_decrypt",
    "pgp_sym_encrypt_bytea",
    "pgp_sym_decrypt_bytea",
    "pgp_pub_encrypt_bytea",
    "pgp_pub_decrypt_bytea",
    "encrypt",
    "decrypt",
    "encrypt_iv",
    "decrypt_iv",
    "crypt",
    "gen_salt",
  ]) {
    assert.ok(rules.includes(`banned-${fn}`), `expected banned-${fn}`);
  }
});

test("isolates dollar-quoted quotes/comments and catches dollar-tag, escape, concat, and named algorithm bypasses", () => {
  const apostropheBypass = "INSERT INTO notes(body) VALUES ($$It's fine$$);\nSELECT md5(secret) FROM users;";
  assert.deepEqual(
    scanMigrationSql("20261121000000000_apos.sql", apostropheBypass).map((v) => `${v.line}:${v.rule}`),
    ["2:banned-md5"],
  );

  const nestedDollarMsg = [
    "CREATE FUNCTION f(x text) RETURNS text AS $outer$",
    "DECLARE",
    "  v_note text := $msg$it's safe$msg$;",
    "BEGIN",
    "  RETURN md5(x);",
    "END;",
    "$outer$ LANGUAGE plpgsql;",
  ].join("\n");
  assert.deepEqual(
    scanMigrationSql("20261121000000000_nested.sql", nestedDollarMsg).map((v) => `${v.line}:${v.rule}`),
    ["5:banned-md5"],
  );

  const commentDollar = [
    "INSERT INTO t VALUES ($$/*$$);",
    "SELECT md5(secret) FROM users;",
    "INSERT INTO t VALUES ($$*/$$);",
    "SELECT $$--$$, md5(secret) FROM users;",
  ].join("\n");
  assert.deepEqual(
    scanMigrationSql("20261121000000000_cmtdollar.sql", commentDollar).map((v) => `${v.line}:${v.rule}`),
    ["2:banned-md5", "4:banned-md5"],
  );

  const obfuscatedAlgs = [
    "SELECT digest(x, $$md5$$);",
    "SELECT digest(x, $alg$sha1$alg$);",
    "SELECT hmac(x, k, $$md5$$);",
    "SELECT digest(x, ('sha' || '1'));",
    "SELECT digest(x, concat('md', '5'));",
    "SELECT digest(x, E'\\x6d\\x64\\x35');",
    "SELECT digest(x, E'\\155\\144\\065');",
    "SELECT digest(x, E'\\u006d\\u0064\\u0035');",
    "SELECT digest(x, U&'\\006d\\0064\\0035');",
    "SELECT digest(x, U&'!006d!0064!0035' UESCAPE '!');",
    "SELECT digest(type => 'md5', data => x);",
    "SELECT hmac(data => x, key => k, alg => 'sha1');",
    "SELECT digest(x, CAST('md' || '5' AS text));",
    "SELECT digest(type := 'md5', data := x);",
    "SELECT hmac(data := x, key := k, alg := 'sha1');",
    "SELECT digest(x, 'md'\n'5');",
    "SELECT digest(x, 's'\n/* c */\n'ha1');",
    "SELECT digest(x, U&'!006d!0064!0035'UESCAPE'!');",
  ].join("\n");
  const algViolations = scanMigrationSql("20261121000000000_algs.sql", obfuscatedAlgs);
  assert.equal(algViolations.length, 18);
  assert.deepEqual(
    algViolations.map((v) => `${v.line}:${v.rule}`),
    [
      "1:weak-digest-algorithm",
      "2:weak-digest-algorithm",
      "3:weak-hmac-algorithm",
      "4:weak-digest-algorithm",
      "5:weak-digest-algorithm",
      "6:weak-digest-algorithm",
      "7:weak-digest-algorithm",
      "8:weak-digest-algorithm",
      "9:weak-digest-algorithm",
      "10:weak-digest-algorithm",
      "11:weak-digest-algorithm",
      "12:weak-hmac-algorithm",
      "13:weak-digest-algorithm",
      "14:weak-digest-algorithm",
      "15:weak-hmac-algorithm",
      "16:weak-digest-algorithm",
      "18:weak-digest-algorithm",
      "21:weak-digest-algorithm",
    ],
  );
});

test("scans single-quoted executable bodies and fails closed on excessive nesting depth", () => {
  const singleQuotedBodies = [
    "CREATE FUNCTION f(x text) RETURNS text AS 'BEGIN RETURN md5(x); END;' LANGUAGE plpgsql;",
    "CREATE PROCEDURE p() LANGUAGE plpgsql AS 'BEGIN PERFORM md5(x); END;';",
    "DO 'BEGIN PERFORM md5(x); END;';",
    "DO LANGUAGE plpgsql 'BEGIN PERFORM md5(x); END;';",
    "DO LANGUAGE 'plpgsql' 'BEGIN PERFORM md5(x); END;';",
    "DO $$ BEGIN EXECUTE 'SELECT md5(x)'; END; $$;",
  ].join("\n");

  const bodyViolations = scanMigrationSql("20261121000000000_sq.sql", singleQuotedBodies);
  assert.deepEqual(
    bodyViolations.map((v) => `${v.line}:${v.rule}`),
    [
      "1:banned-md5",
      "2:banned-md5",
      "3:banned-md5",
      "4:banned-md5",
      "5:banned-md5",
      "6:banned-md5",
    ],
  );

  let deeplyNested = "PERFORM md5(x);";
  for (let d = 17; d >= 1; d--) {
    deeplyNested = `DO $t${d}$ BEGIN ${deeplyNested} END; $t${d}$;`;
  }
  const depthViolations = scanMigrationSql("20261121000000000_deep.sql", deeplyNested);
  assert.equal(depthViolations.length, 1);
  assert.equal(depthViolations[0].rule, "excessive-dollar-nesting");
});

test("ignores comments, string/dollar prose literals, safe sha256/sha512 calls, and safe identifiers", () => {
  const safeSql = `
    -- md5(col) and digest(x, 'sha1') in line comment
    /* nested /* md5(col) */ hmac(a, b, 'md5') */
    COMMENT ON COLUMN t.c IS 'Migrated from md5(x) and sha1';
    INSERT INTO t VALUES ($$not sql md5(x)$$);
    SELECT CAST(x AS text), 'md5(x)' AS label FROM t;
    SELECT 'md' '5', 'sha256' AS label FROM t;
    CREATE FUNCTION f(x text) RETURNS text AS 'BEGIN RETURN ''md5(x)''; END;' LANGUAGE plpgsql;
    CREATE FUNCTION f(x text) RETURNS text AS $fn$
    BEGIN
      RAISE EXCEPTION 'sha1 and md5(x) are not allowed';
      PERFORM E'escaped \\' md5(x)';
      RETURN $$not sql md5(x)$$;
    END;
    $fn$ LANGUAGE plpgsql;
    SELECT
      digest(convert_to(x, 'UTF8'), 'sha256'),
      digest(x, ('sha' || '256')),
      digest(x, concat('sha', '256')),
      digest(x, CAST('sha' || '256' AS text)),
      digest(type => 'sha256', data => x),
      digest(type := 'sha256', data := x),
      digest(x, U&'\\0073\\0068\\0061\\0032\\0035\\0036'),
      digest(x, U&'!0073!0068!0061!0032!0035!0036'UESCAPE'!'),
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

test("CLI works through symlinked entrypoint and exits 0 on clean or 1 on violations", (t) => {
  const script = path.join(REPO_ROOT, "scripts/check-migration-crypto.mjs");
  const symlinkDir = mkdtempSync(path.join(tmpdir(), "migration-crypto-link-"));
  t.after(() => rmSync(symlinkDir, { recursive: true, force: true }));
  const linkedScript = path.join(symlinkDir, "check-migration-crypto-link.mjs");
  symlinkSync(script, linkedScript);

  const cleanRoot = withTempMigrations(t, {
    "20261121000000000_clean.sql": "SELECT encode(digest(convert_to(v, 'UTF8'), 'sha256'), 'hex');\n",
  });
  const cleanRun = spawnSync(process.execPath, [linkedScript, "--root", cleanRoot], { encoding: "utf8" });
  assert.equal(cleanRun.status, 0, cleanRun.stderr);
  assert.match(cleanRun.stdout, /1 migration\(s\) checked.*0 problem\(s\)/);

  const dirtyRoot = withTempMigrations(t, {
    "20261121000000000_dirty.sql": "SELECT md5(v);\n",
  });
  const dirtyRun = spawnSync(process.execPath, [linkedScript, "--root", dirtyRoot], { encoding: "utf8" });
  assert.equal(dirtyRun.status, 1);
  assert.match(dirtyRun.stdout, /1 migration\(s\) checked.*1 problem\(s\)/);
  assert.match(dirtyRun.stderr, /20261121000000000_dirty\.sql:1:/);
});
