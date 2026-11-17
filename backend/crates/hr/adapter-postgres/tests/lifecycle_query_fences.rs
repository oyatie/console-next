// SPDX-License-Identifier: LicenseRef-Proprietary
//! OFFSET 0 keeps fresh bulk tables on correlated key lookups before ANALYZE.

#[test]
fn case_queries_keep_their_point_lookup_fences() {
    for (name, query, fences) in [
        ("open", include_str!("../src/cases/open.rs"), 1),
        ("dates", include_str!("../src/cases/dates.rs"), 2),
        (
            "applicability",
            include_str!("../src/cases/applicability.rs"),
            3,
        ),
    ] {
        assert_eq!(
            query.matches("OFFSET 0").count(),
            fences,
            "{name}: preserve the bulk query's correlated lookup plan"
        );
    }
}
