// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[test]
#[allow(clippy::unwrap_used)]
fn only_internal_candidate_reads_bound_and_use_the_immutable_cursor() {
    let after = Some((
        time::OffsetDateTime::UNIX_EPOCH,
        "insurance_filing_ACQUIRE_NPS:record".into(),
    ));
    let mut query = FilingQuery {
        inbox_after: after,
        limit: Some(1),
        ..FilingQuery::default()
    };
    let mut ordinary = QueryBuilder::<Postgres>::new("SELECT * FROM filtered");
    push_page_order(&mut ordinary, &query);
    assert_eq!(
        ordinary.sql(),
        "SELECT * FROM filtered ORDER BY effective_date,id,kind,insurer"
    );
    query.inbox_scan_limit = Some(50);
    let mut bounded = QueryBuilder::<Postgres>::new("SELECT * FROM filtered");
    push_page_order(&mut bounded, &query);
    assert_eq!(
        bounded.sql(),
        "SELECT * FROM filtered WHERE (created_at, inbox_id) > ($1, $2) ORDER BY created_at, inbox_id LIMIT $3"
    );
    let external: FilingQuery =
        serde_json::from_value(serde_json::json!({"inbox_scan_limit": 50})).unwrap();
    assert!(
        external.inbox_scan_limit.is_none(),
        "HTTP input cannot switch the read into a partial candidate scan"
    );
}

#[test]
fn non_employee_types_derives_dispatched_outsourced_and_freelance_only() {
    assert_eq!(
        non_employee_types(),
        vec!["DISPATCHED_IN", "OUTSOURCED_ON_SITE", "FREELANCE"]
    );
}
