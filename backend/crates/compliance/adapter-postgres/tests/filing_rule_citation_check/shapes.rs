// SPDX-License-Identifier: LicenseRef-Proprietary
//! The citation CHECK on non-law.go.kr hosts, optional and null citations, and malformed shapes.

use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn database_rejects_filing_rule_with_non_law_go_kr_penalty_or_applicability_citation(
    pool: PgPool,
) -> sqlx::Result<()> {
    let bad_urls = [
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "http://www.law.go.kr/법령/국민연금법시행령",
        "https://law.go.kr/법령/국민연금법시행령",
        "https://evil.example/https://www.law.go.kr/법령/국민연금법시행령",
        "https://www.law.go.kr.evil.example/법령/국민연금법시행령",
        "https://www.law.go.kr/",
        "",
        "https://www.law.go.kr/법령/국민연금법시행령 ",
        "https://www.law.go.kr/법령/국민연금법시행령\n",
        "https://www.law.go.kr/\t법령/국민연금법시행령",
        "https://www.law.go.kr/법령/국민연금법\u{7f}시행령",
    ];

    for (i, bad) in bad_urls.iter().enumerate() {
        let day = date!(2099 - 01 - 01) + time::Duration::days(i64::try_from(i).unwrap_or(0));

        let bad_penalty = sample_filing_rule(
            "https://www.law.go.kr/법령/국민연금법시행규칙",
            Some(bad),
            &["https://www.law.go.kr/법령/국민연금법"],
        );
        assert_check_violation(
            try_insert_filing_rule(&pool, day, bad_penalty).await,
            &format!("penalty.citation.source_url={bad}"),
        );

        let bad_applicability = sample_filing_rule(
            "https://www.law.go.kr/법령/국민연금법시행규칙",
            Some("https://www.law.go.kr/법령/국민연금법시행령"),
            &["https://www.law.go.kr/법령/국민연금법", bad],
        );
        assert_check_violation(
            try_insert_filing_rule(&pool, day, bad_applicability).await,
            &format!("applicability_citations[].source_url={bad}"),
        );

        let bad_primary = sample_filing_rule(
            bad,
            Some("https://www.law.go.kr/법령/국민연금법시행령"),
            &["https://www.law.go.kr/법령/국민연금법"],
        );
        assert_check_violation(
            try_insert_filing_rule(&pool, day, bad_primary).await,
            &format!("citation.source_url={bad}"),
        );
    }

    let mut missing_penalty_url = sample_filing_rule(
        "https://www.law.go.kr/법령/국민연금법시행규칙",
        Some("https://www.law.go.kr/법령/국민연금법시행령"),
        &["https://www.law.go.kr/법령/국민연금법"],
    );
    missing_penalty_url["penalty"]["citation"]["source_url"] = Value::Null;
    assert_check_violation(
        try_insert_filing_rule(&pool, date!(2099 - 04 - 01), missing_penalty_url).await,
        "penalty.citation.source_url=null",
    );

    let mut missing_applicability_url = sample_filing_rule(
        "https://www.law.go.kr/법령/국민연금법시행규칙",
        Some("https://www.law.go.kr/법령/국민연금법시행령"),
        &["https://www.law.go.kr/법령/국민연금법"],
    );
    missing_applicability_url["applicability_citations"][0]["source_url"] = Value::Null;
    assert_check_violation(
        try_insert_filing_rule(&pool, date!(2099 - 04 - 02), missing_applicability_url).await,
        "applicability_citations[0].source_url=null",
    );

    let valid = sample_filing_rule(
        "https://www.law.go.kr/법령/국민연금법시행규칙",
        Some("https://www.law.go.kr/법령/국민연금법시행령"),
        &[
            "https://www.law.go.kr/법령/국민연금법",
            "https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=286165&efYd=20270101&chrClsCd=010202",
        ],
    );
    try_insert_filing_rule(&pool, date!(2099 - 06 - 01), valid).await?;

    let valid_without_penalty =
        sample_filing_rule("https://www.law.go.kr/법령/국민연금법시행규칙", None, &[]);
    try_insert_filing_rule(&pool, date!(2099 - 06 - 02), valid_without_penalty).await?;
    Ok(())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn database_accepts_omitted_optional_citation_fields(pool: PgPool) -> sqlx::Result<()> {
    for (i, key) in ["penalty", "applicability_citations"]
        .into_iter()
        .enumerate()
    {
        let mut rule = sample_filing_rule(
            "https://www.law.go.kr/법령/국민연금법시행규칙",
            Some("https://www.law.go.kr/법령/국민연금법시행령"),
            &["https://www.law.go.kr/법령/국민연금법"],
        );
        rule.as_object_mut()
            .ok_or_else(|| sqlx::Error::Protocol("filing rule must be an object".into()))?
            .remove(key);
        let day = date!(2099 - 10 - 01) + time::Duration::days(i64::try_from(i).unwrap_or(0));
        let result = try_insert_filing_rule(&pool, day, rule).await;
        assert!(
            result.is_ok(),
            "omitted {key} must be accepted, got {result:?}"
        );
    }
    Ok(())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn database_accepts_explicit_null_applicability_citations(pool: PgPool) -> sqlx::Result<()> {
    let mut rule = sample_filing_rule(
        "https://www.law.go.kr/법령/국민연금법시행규칙",
        Some("https://www.law.go.kr/법령/국민연금법시행령"),
        &["https://www.law.go.kr/법령/국민연금법"],
    );
    rule["applicability_citations"] = Value::Null;
    try_insert_filing_rule(&pool, date!(2099 - 11 - 01), rule).await?;
    Ok(())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn database_rejects_bad_column_url_and_malformed_applicability_shapes(
    pool: PgPool,
) -> sqlx::Result<()> {
    let valid_rule =
        || sample_filing_rule("https://www.law.go.kr/법령/국민연금법시행규칙", None, &[]);
    // The pre-existing column CHECK admits a bare host and control characters.
    let bad_column_urls = [
        "https://www.law.go.kr/",
        "https://www.law.go.kr/법령/국민연금법시행규칙\n",
        "https://www.law.go.kr/\t법령",
        "https://www.law.go.kr/법령\u{7f}",
    ];
    for (i, bad) in bad_column_urls.iter().enumerate() {
        let day = date!(2099 - 08 - 01) + time::Duration::days(i64::try_from(i).unwrap_or(0));
        assert_check_violation(
            try_insert_row(&pool, day, bad, valid_rule()).await,
            &format!("source_url column={bad:?}"),
        );
    }

    let citation = json!({ "source_url": "https://www.law.go.kr/법령/국민연금법" });
    let malformed = [
        ("applicability_citations=object", citation.clone()),
        ("applicability_citations=[[citation]]", json!([[citation]])),
    ];
    for (i, (context, shape)) in malformed.into_iter().enumerate() {
        let mut rule = valid_rule();
        rule["applicability_citations"] = shape;
        let day = date!(2099 - 09 - 01) + time::Duration::days(i64::try_from(i).unwrap_or(0));
        assert_check_violation(try_insert_filing_rule(&pool, day, rule).await, context);
    }
    Ok(())
}
