//! regression (EMP-B round 7 #1): `the run's apply job` inside a single-quoted
//! description closed the scalar early, so openapi.yaml did not parse.

use console_contracts::yaml_quotes::first_single_quote_closed_early;

#[test]
fn regression_an_apostrophe_closing_a_quoted_scalar_early_is_refused() {
    let shipped =
        "description: 'one line\n  apply_in_progress while the run's apply job runs.'\nnext: 1\n";
    assert_eq!(
        first_single_quote_closed_early(shipped).map(|(line, _)| line),
        Some(2)
    );
    let one_line = "description: 'it's here'\n";
    assert_eq!(
        first_single_quote_closed_early(one_line).map(|(line, _)| line),
        Some(1)
    );

    for sound in [
        "description: 'the run''s apply job\n  and the tenant''s rule.'\nnext: 1\n",
        "description: 'quoted: fine' # comment\n",
        "default: ''\n",
        "'200':\n  description: ok\n",
        "enum: ['a', 'b']\n",
        "- {name: 'x', in: 'path'}\n",
        "description: plain text, it's fine\n",
        "description: >-\n  folded, it's fine\n",
    ] {
        assert_eq!(first_single_quote_closed_early(sound), None, "{sound}");
    }
}

/// The published file must parse: no single-quoted scalar may close early.
#[test]
fn regression_published_openapi_yaml_has_no_single_quote_closed_early() {
    let published = include_str!("../../../openapi/openapi.yaml");
    assert_eq!(first_single_quote_closed_early(published), None);
}
