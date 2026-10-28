// SPDX-License-Identifier: LicenseRef-Proprietary
//! Harness wiring and topology-script contracts; enabled with database-test tooling.

use super::{
    EXPECTED_REQUIRED_TABLES, Fallible, repo_root, require_docker, required_tables_from_topology,
    run, topology_script,
};
use console_ontology_canonical_domain::ObjectKey;
use std::{fs, path::PathBuf};

#[test]
#[cfg_attr(
    not(feature = "test-postgres"),
    ignore = "needs the DB-test tooling, added with the database-test slice"
)]
fn derived_required_tables_match_the_verbatim_roster() -> Fallible {
    let derived = required_tables_from_topology(&topology_script())?;
    assert_eq!(
        derived,
        EXPECTED_REQUIRED_TABLES.map(str::to_string).to_vec(),
        "the shell `required_tables` array and the verbatim pin must stay the same \
         set; a new canonical table edits BOTH (shell first, then this pin), and \
         this test is the ratchet that refuses a drift"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// The wiring, proven by RUNNING each harness
// ---------------------------------------------------------------------------

/// The enforcement's own output line. Its presence is proof the enforcement
/// executed; the name of the script that would have produced it is not.
const ENFORCED: &str = "canonical-enforce: enforced";

#[test]
#[cfg_attr(
    not(feature = "test-postgres"),
    ignore = "needs the DB-test tooling, added with the database-test slice"
)]
fn pgtest_harness_executes_the_enforcement() -> Fallible {
    require_docker();
    let root = repo_root().display().to_string();
    let script = repo_root()
        .join("tools/lanes/pgtest.sh")
        .display()
        .to_string();
    // `true` as the command under test: the harness still boots PostgreSQL,
    // reconciles and enforces, and nothing is compiled.
    let (ok, log) = run("bash", &[&script, &root, "true"])?;
    assert!(ok, "tools/lanes/pgtest.sh did not complete:\n{log}");
    assert!(
        log.contains(ENFORCED),
        "tools/lanes/pgtest.sh must EXECUTE the canonical enforcement. Commenting \
         the invocation out leaves the literal `canonical-enforce.sh` in the file, \
         so only its output proves it ran:\n{log}"
    );
    Ok(())
}

#[test]
#[cfg_attr(
    not(feature = "test-postgres"),
    ignore = "needs the DB-test tooling, added with the database-test slice"
)]
fn cargo_needs_postgres_harness_executes_the_enforcement() -> Fallible {
    require_docker();
    let script = repo_root()
        .join("tools/ci/cargo_needs_postgres.sh")
        .display()
        .to_string();
    // A `--only` name no map entry carries: the harness boots, reconciles and
    // enforces, then exits on an empty selection without building anything.
    let (ok, log) = run(
        "bash",
        &[&script, "--only", "console-canonical-wiring-probe"],
    )?;
    assert!(
        log.contains(ENFORCED),
        "tools/ci/cargo_needs_postgres.sh must EXECUTE the canonical enforcement \
         before it selects targets:\n{log}"
    );
    assert!(
        !ok && log.contains("no map entries selected"),
        "the probe selection is expected to end the run, and did not:\n{log}"
    );
    Ok(())
}
// ---------------------------------------------------------------------------
// The database half: its table roster may not drift from the registry
// ---------------------------------------------------------------------------

/// The `DO $canonical$ ... $canonical$;` body ONLY.
///
/// Slicing to end-of-file instead would make every assertion below unfalsifiable:
/// the same four command-role names reappear 20 lines after the block, in the
/// backend-termination step, so `contains(role)` would hold no matter what the
/// block itself said.
///
/// The opener is matched as a whole LINE. `DO $canonical$` also appears inside a
/// comment 400 lines earlier ("Read back by the DO $canonical$ block below"),
/// and splitting on the bare substring silently pulled those 400 lines of
/// unrelated role reconciliation into "the block" — which is how a
/// `!block.contains(…)` assertion can fail on text the block does not contain.
fn canonical_block() -> Result<String, Box<dyn std::error::Error>> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../ops/postgres-reconcile-topology.sh");
    let text =
        fs::read_to_string(&script).map_err(|error| format!("{}: {error}", script.display()))?;
    let (_, rest) = text
        .split_once("\nDO $canonical$\n")
        .ok_or("topology script lost the canonical writer-ownership block")?;
    let (block, _) = rest
        .split_once("$canonical$;")
        .ok_or("the canonical writer-ownership block is not terminated")?;
    Ok(block.to_owned())
}

/// The text between a marker's BEGIN and END lines, the marker's own line
/// dropped. The BEGIN line is a comment, and callers that parse literals would
/// otherwise read an apostrophe in it ("the crate's tables") as one.
fn marked_region<'a>(block: &'a str, marker: &str) -> Result<&'a str, Box<dyn std::error::Error>> {
    let (_, rest) = block
        .split_once(&format!("canonical-writer-ownership: BEGIN {marker}"))
        .ok_or_else(|| format!("the canonical block lost its BEGIN {marker} marker"))?;
    let rest = rest.split_once('\n').map_or("", |(_, tail)| tail);
    let (region, _) = rest
        .split_once(&format!("canonical-writer-ownership: END {marker}"))
        .ok_or_else(|| format!("the canonical block lost its END {marker} marker"))?;
    Ok(region)
}

/// Every single-quoted literal between the two markers, comments dropped.
fn marked_list(block: &str, marker: &str) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let region = marked_region(block, marker)?;
    let mut found = Vec::new();
    for line in region.lines() {
        let line = line.trim();
        if line.starts_with("--") {
            continue;
        }
        let mut rest = line;
        while let Some((_, after)) = rest.split_once('\'') {
            let Some((literal, tail)) = after.split_once('\'') else {
                break;
            };
            found.push(literal.to_owned());
            rest = tail;
        }
    }
    Ok(found)
}

/// `ops/postgres-reconcile-topology.sh` carries the same table roster, because
/// SQL cannot import a Rust constant. This binds the two: a seventh object key
/// that never reaches the database half fails here.
#[test]
#[cfg_attr(
    not(feature = "test-postgres"),
    ignore = "needs the DB-test tooling, added with the database-test slice"
)]
fn topology_script_table_roster_matches_the_registry() -> Result<(), Box<dyn std::error::Error>> {
    let in_script = marked_list(&canonical_block()?, "table roster")?;
    let registry: Vec<String> = ObjectKey::ALL
        .iter()
        .flat_map(|key| key.owned_tables().iter().map(|table| (*table).to_owned()))
        .collect();
    assert_eq!(
        in_script, registry,
        "the topology script's canonical table roster drifted from ObjectKey::owned_tables"
    );
    Ok(())
}

/// The database half must name, exactly, which roles lose DML and which writers
/// are still expected — as parsed lists inside the block, not as substrings of
/// the rest of the script.
///
/// Both assertions are set EQUALITIES. An inequality (`contains`) cannot fail
/// when a role is dropped from the check, which is the defect this replaces.
#[test]
#[cfg_attr(
    not(feature = "test-postgres"),
    ignore = "needs the DB-test tooling, added with the database-test slice"
)]
fn topology_script_names_the_roles_that_lose_dml() -> Result<(), Box<dyn std::error::Error>> {
    let block = canonical_block()?;

    assert_eq!(
        marked_list(&block, "revoked roles")?,
        [
            "console_leave_cmd",
            "console_ontology_cmd",
            "console_platform_force_cmd",
            "console_auth_cmd",
        ],
        "no command role writes a canonical relation directly (the three \
         domain roles go through SECURITY DEFINER functions; the auth role owns \
         no canonical table); the block must actively REVOKE table DML from every one"
    );

    // The measured writer surface of the canonical relations at this tip. Every
    // pair is a live holder with the lane that deletes it, or a role PostgreSQL
    // itself gives DML to. `console_app` OWNS every canonical table and
    // `pg_write_all_data` holds DML in every cluster: naming them is what makes
    // a rogue OWNER and a MEMBER of a write role ordinary findings instead of
    // structural blind spots.
    assert_eq!(
        marked_list(&block, "expected writers")?,
        [
            "console_app",
            "*",
            "console_rt",
            "*",
            "console_leave_definer",
            "employees",
            "pg_write_all_data",
            "*",
        ],
        "the expected-writer ratchet drifted; every role that can write a \
         canonical relation must be named here with the lane that removes it"
    );

    for verb in ["'INSERT'", "'UPDATE'", "'DELETE'", "'TRUNCATE'"] {
        assert!(
            block.contains(verb),
            "{verb} is not covered by the DML census"
        );
    }
    assert!(
        block.contains("REVOKE INSERT, UPDATE, DELETE, TRUNCATE"),
        "the database half must actually revoke, not merely describe a revoke"
    );
    assert!(
        !block.contains("RETURN;"),
        "an early RETURN makes the whole census a no-op; the block must run on \
         every reconcile against the tables that exist now"
    );

    // The hand-maintained catalog unions this round DELETED. Each was a
    // separate guard for one way a DML privilege can arrive, and each round
    // added the next one a reviewer named. `has_table_privilege` /
    // `has_any_column_privilege` answer all of them at once, so a re-appearance
    // of any of these names is the enumeration growing back.
    //
    // Deleting the `relowner` entry outright was measured, not argued: with
    // `LEFT JOIN pg_roles owner_role ON owner_role.oid = relation.relowner`
    // added to the census, every assertion in this test AND all 16 probes and
    // 14 mutations of tests/census_executes_against_postgres.rs stayed green
    // (134s against PostgreSQL 18.4). So this text assertion is kept.
    let census = marked_region(&block, "census statement")?;
    assert!(
        census.contains("has_table_privilege") && census.contains("AS census"),
        "the census-statement markers do not enclose the census, so every \
         assertion over that region would examine nothing"
    );
    for subsumed in [
        "aclexplode",
        "relacl",
        "attacl",
        "pg_auth_members",
        "rolsuper",
    ] {
        assert!(
            !block.contains(subsumed),
            "`{subsumed}` is subsumed by has_table_privilege/has_any_column_privilege \
             and must not be unioned back into the census"
        );
        assert!(
            !census.contains(subsumed),
            "`{subsumed}` must not be read inside the census statement"
        );
    }
    // The owner catalog may be read in exactly ONE place: the step-4 owner pin,
    // which carries its own markers so the position can be named. Scoping this
    // to the census REGION left a one-statement bypass — read `relowner` into a
    // variable above the BEGIN marker and join it inside the census — so the
    // assertion counts occurrences instead, which is total over position.
    // Reading ownership anywhere the census can reach puts OWNERSHIP behind the
    // census's ratchet, and that ratchet excludes a candidate by NAME before it
    // asks the privilege question: `console_rt` could then OWN `employees` and
    // pass, which is `ALTER TABLE … DISABLE ROW LEVEL SECURITY` on the runtime
    // login principal.
    let owner_pin = marked_region(&block, "owner pin")?;
    assert!(
        owner_pin.contains("relowner")
            && owner_pin.contains("expected_owners")
            && owner_pin.contains("topology.canonical_table_owner_failed"),
        "the owner-pin markers do not enclose the owner pin, so the `relowner` \
         count below would examine nothing"
    );
    assert_eq!(
        block.matches("relowner").count(),
        owner_pin.matches("relowner").count(),
        "`relowner` is read outside the step-4 owner pin; ownership read \
         anywhere the census can reach becomes subject to the write ratchet"
    );

    // The owner pin is a list of its own, so no expected-WRITER entry can widen
    // who may OWN.
    assert_eq!(
        marked_list(&block, "expected owners")?,
        ["console_app"],
        "migrations run as console_app, so it is the only expected owner of a \
         canonical relation; a role that may WRITE one may still not OWN it"
    );
    assert!(
        block.contains("topology.canonical_table_owner_failed"),
        "the owner pin must fail closed with a named error"
    );
    assert!(
        block.contains("has_table_privilege") && block.contains("has_any_column_privilege"),
        "the census must ASK PostgreSQL the privilege question"
    );
    assert!(
        block.contains("pg_inherits"),
        "the examined set must reach partition and inheritance children, whose \
         relname the roster does not contain"
    );
    assert!(
        block.contains("topology.canonical_writer_ownership_failed"),
        "the check must fail closed with a named error"
    );
    Ok(())
}
