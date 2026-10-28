// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use sha2::{Digest, Sha256};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn stored_chunks_preserve_keyset_continuity_across_and_at_boundaries(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "chunks").await;
    reviewer(&pool, org, user).await;
    sqlx::query("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,created_at,occurred_at,after_snap,outcome) SELECT $1,$2,'employee.rrn_reveal','employee','test',repeat('a',32),repeat('b',16),'2026-09-01T02:00:00Z'::timestamptz+n*interval '1 millisecond','2026-09-01T02:00:00Z','{\"self_read\":false,\"subject_count\":0}','ALLOWED' FROM generate_series(1,450) n")
        .bind(org.as_uuid()).bind(user.as_uuid()).execute(&pool).await.unwrap();
    let expected: Vec<uuid::Uuid> = sqlx::query_scalar("SELECT id FROM audit_events WHERE org_id=$1 AND action='employee.rrn_reveal' ORDER BY created_at,id")
        .bind(org.as_uuid()).fetch_all(&pool).await.unwrap();
    let service = AccessService::new(runtime_role_pool(&pool).await, None);
    let p = principal(org, user);
    let summary = record::start(
        &service,
        p.clone(),
        "2026-09".into(),
        "chunk-review-start".into(),
    )
    .await
    .unwrap();
    assert!(summary["flags_seen"].get("chunk_ends").is_none());
    assert!(summary["flags_seen"].get("evidence_header").is_none());
    let stored: Value = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='access_log_review.start'",
    )
    .bind(org.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    let flags: Vec<console_platform_access::log_review::list::FlaggedEvent> =
        stored["evidence"]["flagged"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|chunk| chunk.as_array().unwrap())
            .map(|row| serde_json::from_value(row.clone()).unwrap())
            .collect();
    assert_eq!(
        stored["flag_set_sha256"],
        hex::encode(Sha256::digest(serde_json::to_vec(&flags).unwrap()))
    );
    for first_limit in [185, 200] {
        let first = record::frozen_page(&service, p.clone(), "2026-09".into(), None, first_limit)
            .await
            .unwrap();
        let last = first.last().unwrap();
        let second = record::frozen_page(
            &service,
            p.clone(),
            "2026-09".into(),
            Some((last.created_at, last.event_id)),
            200,
        )
        .await
        .unwrap();
        assert_eq!(second.len(), 200);
        let last = second.last().unwrap();
        let third = record::frozen_page(
            &service,
            p.clone(),
            "2026-09".into(),
            Some((last.created_at, last.event_id)),
            200,
        )
        .await
        .unwrap();
        let rows: Vec<_> = first.into_iter().chain(second).chain(third).collect();
        assert_eq!(
            rows.iter().map(|r| r.event_id).collect::<Vec<_>>(),
            expected
        );
        assert!(rows.iter().all(|r| r.flags == ["sensitive_read"]));
        let last = rows.last().unwrap();
        assert!(
            record::frozen_page(
                &service,
                p.clone(),
                "2026-09".into(),
                Some((last.created_at, last.event_id)),
                200
            )
            .await
            .unwrap()
            .is_empty()
        );
    }
}
