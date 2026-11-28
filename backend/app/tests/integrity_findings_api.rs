// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/http.rs"]
mod http;
use ::http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

const FINDINGS: &str = "/api/v1/integrity/findings";

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_register_matches_its_served_authority(pool: PgPool) {
    let (org, executive) = http::tenant(&pool, &["EXECUTIVE"]).await;
    let admin = http::add_user(&pool, org, &["ADMIN"]).await;
    for (actor, role, authorized) in [(executive, "EXECUTIVE", true), (admin, "ADMIN", false)] {
        let ctx = http::ctx(&pool, org, actor, &[role], None).await;
        let (status, result) = ctx.call("GET", "/api/v1/me/authz", None).await;
        assert_eq!(status, StatusCode::OK, "{result}");
        for cap in ["served_integrity_findings", "served_integrity_triage"] {
            assert_eq!(
                result["capabilities"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|row| row["feature"] == cap),
                cfg!(feature = "integrity") && authorized
            );
        }
        let (status, rows) = ctx.call("GET", FINDINGS, None).await;
        let expected = if !cfg!(feature = "integrity") {
            StatusCode::NOT_FOUND
        } else if authorized {
            StatusCode::OK
        } else {
            StatusCode::FORBIDDEN
        };
        assert_eq!(status, expected, "{rows}");
        if status == StatusCode::OK {
            assert_eq!(rows, json!([]));
        }
        if !authorized {
            let path = format!("{FINDINGS}/{}/triage", Uuid::new_v4());
            assert_eq!(
                ctx.call("POST", &path, Some(json!({"status":"REVIEWED"})))
                    .await
                    .0,
                expected
            );
        }
    }
}

#[cfg(feature = "integrity")]
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_reviewers_racing_on_one_open_finding_leave_one_decision(pool: PgPool) {
    let (org, reviewer) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let second = http::add_user(&pool, org, &["EXECUTIVE"]).await;
    let (foreign_org, foreign_reviewer) = http::tenant(&pool, &["EXECUTIVE"]).await;
    let insert = |org| {
        sqlx::query_scalar::<_,Uuid>("INSERT INTO governance_findings (org_id,detector_id,entity_type,entity_id,score,severity,detected_at,evidence) VALUES ($1,'anomaly.price_outlier','purchase','P-17',1,'HIGH',now(),'{}') RETURNING id").bind(org).fetch_one(&pool)
    };
    let id = insert(org).await.unwrap();
    let foreign = insert(foreign_org).await.unwrap();
    let a = http::ctx(&pool, org, reviewer, &["SUPER_ADMIN"], None).await;
    let b = http::ctx(&pool, org, second, &["EXECUTIVE"], None).await;
    let other = http::ctx(&pool, foreign_org, foreign_reviewer, &["EXECUTIVE"], None).await;
    let (status, list) = a.call("GET", FINDINGS, None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], id.to_string());
    let route = format!("{FINDINGS}/{id}/triage");
    assert_eq!(
        other
            .call("POST", &route, Some(json!({"status":"REVIEWED"})))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (status, _) = a
        .call("POST", &route, Some(json!({"status":"DISMISSED"})))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    // Both reviewers reach the same locked row before either can complete. An unlocked
    // pre-read lets both UPDATEs succeed after the blocker releases the row.
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM governance_findings WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_one(lock.as_mut())
        .await
        .unwrap();
    let note = "界".repeat(2000);
    let first = a.call(
        "POST",
        &route,
        Some(json!({"status":"REVIEWED","memo":note})),
    );
    let second = b.call(
        "POST",
        &route,
        Some(json!({"status":"DISMISSED","memo":note})),
    );
    let unlock = async {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let count: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%governance_findings%'").fetch_one(&pool).await.unwrap();
                if count >= 2 { break; }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        }).await.expect("both reviewers should be waiting on this finding");
        lock.commit().await.unwrap();
    };
    let (one, two, ()) = tokio::join!(first, second, unlock);
    let mut statuses = [one.0, two.0];
    statuses.sort();
    assert_eq!(
        statuses,
        [StatusCode::OK, StatusCode::CONFLICT],
        "{one:?} {two:?}"
    );
    let wins: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='anomaly.finding.triage'",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(wins, 1);
    let (_, rows) = other.call("GET", FINDINGS, None).await;
    assert_eq!(rows[0]["id"], foreign.to_string());
    assert_eq!(rows[0]["status"], "OPEN");
}
