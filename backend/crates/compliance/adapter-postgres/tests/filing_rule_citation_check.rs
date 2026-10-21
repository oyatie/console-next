// SPDX-License-Identifier: LicenseRef-Proprietary
//! LINKS-CITATION-SCHEME-DB: database CHECK constraint on nested citation URLs
//! in `statutory_rules.filing_rule` (`citation.source_url`,
//! `penalty.citation.source_url`, and `applicability_citations[].source_url`).

use console_compliance_adapter_postgres::PgComplianceStore;
use console_platform_test_support::runtime_role_pool;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::macros::date;

fn sample_filing_rule(
    citation_url: &str,
    penalty_url: Option<&str>,
    applicability_urls: &[&str],
) -> Value {
    let penalty = penalty_url.map(|url| {
        json!({
            "citation": {
                "instrument": "국민연금법 시행령",
                "article": "제114조 별표3 가목 (법 제131조제1항제1호)",
                "promulgation": "대통령령 제35602호",
                "source_url": url,
                "enforced_on": "2026-01-01"
            },
            "delay_won": [170000, 330000, 500000],
            "per_worker": false,
            "cap_won": null
        })
    });
    let applicability_citations: Vec<Value> = applicability_urls
        .iter()
        .map(|url| {
            json!({
                "instrument": "국민연금법",
                "article": "제6조·제8조",
                "promulgation": "법률 제21689호",
                "source_url": url,
                "enforced_on": "2027-01-01"
            })
        })
        .collect();
    json!({
        "code": "ins.deadline.acquire.nps",
        "insurer": "NPS",
        "filing_kind": "ACQUIRE",
        "effective_from": "2099-01-01",
        "effective_to_exclusive": null,
        "deadline": {
            "anchor": "ACQUIRE_DATE",
            "kind": "DAY_OF_NEXT_MONTH",
            "value": 15,
            "first_day": "EXCLUDED"
        },
        "candidate": null,
        "opens_anchor": "ACQUIRE_DATE",
        "opens_offset": 0,
        "holiday_roll": "UNVERIFIED",
        "open": false,
        "citation": {
            "instrument": "국민연금법 시행규칙",
            "article": "제6조제1항 (법 제11조·제12조)",
            "promulgation": "보건복지부령 제1157호",
            "source_url": citation_url,
            "enforced_on": "2026-02-13"
        },
        "exclusions": [],
        "penalty": penalty,
        "covered_by": null,
        "age_trigger_years": null,
        "remuneration_required": false,
        "applicability_anchor": "ACQUIRE_DATE",
        "applicability_citations": applicability_citations,
        "loss_offset_days": 1
    })
}

async fn try_insert_filing_rule(
    pool: &PgPool,
    effective_from: time::Date,
    rule: Value,
) -> sqlx::Result<()> {
    try_insert_row(
        pool,
        effective_from,
        "https://www.law.go.kr/법령/국민연금법시행규칙",
        rule,
    )
    .await
}

async fn try_insert_row(
    pool: &PgPool,
    effective_from: time::Date,
    column_url: &str,
    rule: Value,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO statutory_rules (
            code, effective_from, effective_to_exclusive, unit, value_num, value_den,
            instrument_ko, article_ko, promulgation_ko, enforced_on, source_url,
            retrieved_on, provenance_ko, filing_rule
        ) VALUES (
            'ins.deadline.acquire.nps', $1, NULL, 'DAY_OF_NEXT_MONTH', 15, 1,
            '국민연금법 시행규칙', '제6조제1항', '보건복지부령 제1157호',
            DATE '2026-02-13', $2,
            DATE '2026-10-12', '테스트 행', $3
        )",
    )
    .bind(effective_from)
    .bind(column_url)
    .bind(rule)
    .execute(pool)
    .await?;
    Ok(())
}

fn assert_check_violation(result: sqlx::Result<()>, context: &str) {
    assert!(
        result.is_err(),
        "{context}: expected database rejection, got Ok"
    );
    if let Err(err) = result {
        let code = err
            .as_database_error()
            .and_then(|db_err| db_err.code().map(std::borrow::Cow::into_owned));
        assert_eq!(
            code.as_deref(),
            Some("23514"),
            "{context}: expected CHECK violation 23514, got {err:?}"
        );
        assert_eq!(
            err.as_database_error()
                .and_then(sqlx::error::DatabaseError::constraint),
            Some("statutory_rules_filing_rule_citation_urls_check"),
            "{context}: expected the citation URL constraint to refuse, got {err:?}"
        );
    }
}

#[test]
fn citation_constraint_migration_is_embedded() {
    assert!(
        console_platform_test_support::MIGRATOR
            .iter()
            .any(|migration| migration.version == 20261020053428000),
        "the embedded test migrator must include the citation URL constraint"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn seeded_855_statutory_urls_pass_and_register_loads(pool: PgPool) -> sqlx::Result<()> {
    let urls: Vec<String> = sqlx::query_scalar(
        "SELECT source_url FROM statutory_rules
         UNION ALL
         SELECT filing_rule->'citation'->>'source_url'
           FROM statutory_rules
          WHERE filing_rule IS NOT NULL
         UNION ALL
         SELECT filing_rule->'penalty'->'citation'->>'source_url'
           FROM statutory_rules
          WHERE filing_rule IS NOT NULL
            AND jsonb_typeof(filing_rule->'penalty') = 'object'
         UNION ALL
         SELECT c->>'source_url'
           FROM statutory_rules,
                LATERAL jsonb_array_elements(COALESCE(filing_rule->'applicability_citations', '[]'::jsonb)) AS c
          WHERE filing_rule IS NOT NULL
            AND jsonb_typeof(filing_rule->'applicability_citations') = 'array'",
    )
    .fetch_all(&pool)
    .await?;

    assert!(
        urls.len() >= 855,
        "expected at least 855 seeded statutory URLs, got {}",
        urls.len()
    );
    assert_eq!(
        urls.len(),
        4605,
        "expected 4605 materialized statutory URLs across all seeded rows"
    );
    assert!(
        urls.iter()
            .all(|u| u.starts_with("https://www.law.go.kr/")
                && u.len() > "https://www.law.go.kr/".len()),
        "every seeded URL must start with https://www.law.go.kr/ and carry a non-empty path"
    );

    // NOT VALID only guards new writes; VALIDATE is what proves every seeded row passes.
    let validated: bool = sqlx::query_scalar(
        "SELECT convalidated FROM pg_constraint
          WHERE conrelid = 'public.statutory_rules'::regclass
            AND conname = 'statutory_rules_filing_rule_citation_urls_check'",
    )
    .fetch_one(&pool)
    .await?;
    assert!(
        validated,
        "the citation URL constraint must be validated against existing rows"
    );

    let rt = runtime_role_pool(&pool).await;
    let register = PgComplianceStore::new(rt).statutory_register().await;
    assert!(
        register.is_ok(),
        "migrated statutory register must load cleanly"
    );
    Ok(())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn database_rejects_absent_penalty_citation_source_url(pool: PgPool) -> sqlx::Result<()> {
    let mut rule = sample_filing_rule(
        "https://www.law.go.kr/법령/국민연금법시행규칙",
        Some("https://www.law.go.kr/법령/국민연금법시행령"),
        &[],
    );
    rule["penalty"]["citation"]
        .as_object_mut()
        .ok_or_else(|| sqlx::Error::Protocol("penalty citation must be an object".into()))?
        .remove("source_url");
    assert_check_violation(
        try_insert_filing_rule(&pool, date!(2099 - 07 - 01), rule).await,
        "penalty.citation.source_url absent",
    );
    Ok(())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn database_rejects_empty_applicability_citation(pool: PgPool) -> sqlx::Result<()> {
    let mut rule = sample_filing_rule("https://www.law.go.kr/법령/국민연금법시행규칙", None, &[]);
    rule["applicability_citations"] = json!([{}]);
    assert_check_violation(
        try_insert_filing_rule(&pool, date!(2099 - 07 - 02), rule).await,
        "applicability_citations=[{}]",
    );
    Ok(())
}

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
