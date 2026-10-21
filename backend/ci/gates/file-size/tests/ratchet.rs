//! The ratchet rules, and the gate itself run over this tree.

use std::path::PathBuf;

use console_gate_file_size::{
    CAP, Counts, Finding, JOURNEY_CAP, cap, check, measure, missing_exemptions, oversize,
    parse_baseline, ratchet, render_baseline,
};

fn counts(rows: &[(&str, usize)]) -> Counts {
    rows.iter().map(|(p, n)| ((*p).to_owned(), *n)).collect()
}

#[test]
fn journey_tests_get_the_larger_ceiling_only_under_tests() {
    assert_eq!(cap("app/tests/hr_exit_journey.rs"), JOURNEY_CAP);
    assert_eq!(cap("crates/x/tests/sub/journey_a.rs"), JOURNEY_CAP);
    assert_eq!(cap("app/src/journey.rs"), CAP);
    assert_eq!(cap("app/tests/hr_exit.rs"), CAP);
}

#[test]
fn an_unpinned_file_over_its_ceiling_fails_and_at_the_ceiling_passes() {
    let tree = counts(&[("a.rs", CAP), ("b.rs", CAP + 1)]);
    assert_eq!(
        check(&tree, &Counts::new()),
        vec![Finding::OverCap {
            path: "b.rs".into(),
            lines: CAP + 1,
            cap: CAP
        }]
    );
}

#[test]
fn a_pin_must_equal_the_count_in_both_directions() {
    let pins = counts(&[("grew.rs", 400), ("same.rs", 400), ("shrank.rs", 400)]);
    let tree = counts(&[("grew.rs", 401), ("same.rs", 400), ("shrank.rs", 399)]);
    assert_eq!(
        check(&tree, &pins),
        vec![
            Finding::Grew {
                path: "grew.rs".into(),
                lines: 401,
                pinned: 400
            },
            Finding::Stale {
                path: "shrank.rs".into(),
                lines: 399,
                pinned: 400
            },
        ]
    );
}

#[test]
fn a_pin_for_a_file_now_under_its_ceiling_or_deleted_is_stale() {
    let pins = counts(&[("fixed.rs", 10), ("gone.rs", 400)]);
    let tree = counts(&[("fixed.rs", 10)]);
    assert_eq!(
        check(&tree, &pins),
        vec![
            Finding::Stale {
                path: "fixed.rs".into(),
                lines: 10,
                pinned: 10
            },
            Finding::Stale {
                path: "gone.rs".into(),
                lines: 0,
                pinned: 400
            },
        ]
    );
}

#[test]
fn write_baseline_output_passes_check_and_round_trips() {
    let tree = counts(&[("a.rs", 10), ("b.rs", 900), ("app/tests/x_journey.rs", 450)]);
    let pins = oversize(&tree);
    assert_eq!(pins, counts(&[("b.rs", 900)]));
    assert_eq!(parse_baseline(&render_baseline(&pins)), Ok(pins.clone()));
    assert!(check(&tree, &pins).is_empty());
}

#[test]
fn a_malformed_or_duplicated_row_is_rejected() {
    assert!(parse_baseline("a.rs 10\n").is_err());
    assert!(parse_baseline("a.rs\tten\n").is_err());
    assert!(parse_baseline("a.rs\t10\na.rs\t9\n").is_err());
}

#[test]
fn the_baseline_may_lower_and_move_pins_but_never_raise_one_or_the_total() {
    let old = counts(&[("a.rs", 900), ("b.rs", 500)]);
    // b split out of the tree and a moved into two pinned files: total 1400 -> 1300.
    assert!(ratchet(&old, &counts(&[("x/a1.rs", 700), ("x/a2.rs", 600)])).is_empty());
    assert_eq!(
        ratchet(&old, &counts(&[("a.rs", 901), ("b.rs", 400)])),
        vec![Finding::Raised {
            path: "a.rs".into(),
            was: 900,
            now: 901
        }]
    );
    assert_eq!(
        ratchet(
            &old,
            &counts(&[("a.rs", 900), ("b.rs", 500), ("c.rs", 301)])
        ),
        vec![Finding::TotalGrew {
            was: 1400,
            now: 1701
        }]
    );
}

#[test]
fn this_tree_matches_its_baseline() -> Result<(), String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_console-gate-file-size"))
        .current_dir(&root)
        .output()
        .map_err(|error| error.to_string())?;
    assert!(
        output.status.success(),
        "file-size gate failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

#[test]
fn a_star_exempts_exactly_one_segment() {
    use console_gate_file_size::exempt_matches;
    let pattern = "crates/*/rest/src/openapi.rs";
    assert!(exempt_matches(pattern, "crates/hr/rest/src/openapi.rs"));
    assert!(!exempt_matches(
        pattern,
        "crates/hr/rest/src/openapi_extra.rs"
    ));
    assert!(!exempt_matches(pattern, "crates/hr/x/rest/src/openapi.rs"));
    assert!(!exempt_matches(pattern, "crates/rest/src/openapi.rs"));
    assert!(!exempt_matches(pattern, "app/hr/rest/src/openapi.rs"));
}

#[test]
fn an_exempt_file_is_not_measured_and_a_pattern_matching_nothing_is_flagged() -> Result<(), String>
{
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let tree = measure(&root).map_err(|e| e.to_string())?;
    assert!(
        tree.keys()
            .all(|path| !path.ends_with("/rest/src/openapi.rs"))
    );
    assert!(!tree.contains_key("crates/contracts/src/gen_registry.rs"));
    let empty = std::env::temp_dir().join("file-size-empty-root");
    std::fs::create_dir_all(&empty).map_err(|e| e.to_string())?;
    assert_eq!(
        missing_exemptions(&empty).len(),
        console_gate_file_size::EXEMPT.len()
    );
    Ok(())
}
