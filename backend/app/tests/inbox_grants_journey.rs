// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/http.rs"]
mod http;
use ::http::StatusCode;
use serde_json::Value;
use sqlx::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;
const INBOX: &str = "/api/v1/me/action-inbox";
async fn inbox(ctx: &http::Ctx) -> Value {
    let (status, page) = ctx.call("GET", &format!("{INBOX}?limit=200"), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    page
}
fn items_of<'a>(page: &'a Value, kind: &str) -> Vec<&'a Value> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["kind"] == kind)
        .collect()
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn grant_notices_appear_once_only_for_the_holder_and_leave_on_confirmation(pool: PgPool) {
    let (org, ops) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let holder = http::add_user(&pool, org, &[]).await;
    let other = http::add_user(&pool, org, &[]).await;
    let ctx = http::ctx(&pool, org, holder, &[], None).await;
    inbox(&ctx).await;
    let role: Uuid = sqlx::query_scalar("INSERT INTO access_roles (org_id,name_ko,status,version,created_by) VALUES ($1,'알림 검증','ACTIVE',1,$2) RETURNING id")
        .bind(org).bind(ops.as_uuid()).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'알림 검증','ACTIVE','SETUP',$3)")
        .bind(org).bind(role).bind(ops.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'hr_basic',ARRAY['view','edit'])")
        .bind(org).bind(role).execute(&pool).await.unwrap();
    let mut expected = BTreeSet::new();
    for (start, end, status) in [
        (-1, Some(1), "ACTIVE"),
        (2, None, "ACTIVE"),
        (-5, Some(-4), "ACTIVE"),
        (-1, None, "REVOKED"),
    ] {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,valid_to,status,change_mode,reason_code,granted_by,revoked_by,revoked_at) \
             VALUES ($1,$2,$3,'TENANT',now()+($4 * interval '1 day'),CASE WHEN $5::integer IS NULL THEN NULL ELSE now()+($5 * interval '1 day') END, \
             $6,'SETUP','NEW_HIRE',$7,CASE WHEN $6='REVOKED' THEN $7 ELSE NULL END,CASE WHEN $6='REVOKED' THEN now() ELSE NULL END) RETURNING id"
        ).bind(org).bind(holder.as_uuid()).bind(role).bind(start).bind(end).bind(status).bind(ops.as_uuid())
            .fetch_one(&pool).await.unwrap();
        if start >= -1 && status == "ACTIVE" {
            expected.insert(id.to_string());
        }
    }
    let page = inbox(&ctx).await;
    let rows = items_of(&page, "grant_notice");
    let actual = rows
        .iter()
        .map(|r| r["links"][0]["id"].as_str().unwrap().to_owned())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        actual, expected,
        "one actionable notice per current or scheduled grant: {page}"
    );
    assert_eq!(
        rows.len(),
        2,
        "multiple role levels must not duplicate a grant"
    );
    for row in rows {
        let grant: Uuid = row["links"][0]["id"].as_str().unwrap().parse().unwrap();
        let (valid_from, valid_to): (time::OffsetDateTime, Option<time::OffsetDateTime>) =
            sqlx::query_as(
                "SELECT valid_from, valid_to FROM access_grants WHERE org_id=$1 AND id=$2",
            )
            .bind(org)
            .bind(grant)
            .fetch_one(&pool)
            .await
            .unwrap();
        let lines = row["context"]["grants"]
            .as_array()
            .expect("the notice includes its authority before confirmation");
        assert_eq!(lines.len(), 2, "all role levels survive: {row}");
        assert_eq!(
            lines
                .iter()
                .map(|line| line["level"].as_str().unwrap())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["edit", "view"])
        );
        for line in lines {
            assert_eq!(line["grant_id"], grant.to_string());
            assert_eq!(line["domain"], "hr_basic");
            assert_eq!(line["scope"]["kind"], "TENANT");
            assert_eq!(
                time::OffsetDateTime::parse(
                    line["valid_from"].as_str().unwrap(),
                    &time::format_description::well_known::Rfc3339
                )
                .unwrap(),
                valid_from
            );
            assert_eq!(
                line["valid_to"]
                    .as_str()
                    .map(|value| time::OffsetDateTime::parse(
                        value,
                        &time::format_description::well_known::Rfc3339
                    )
                    .unwrap()),
                valid_to
            );
        }
    }
    let outsider = http::ctx(&pool, org, other, &[], None).await;
    assert!(items_of(&inbox(&outsider).await, "grant_notice").is_empty());
    for (previous_ops, next_ops, count) in [(ops, holder, 0), (holder, ops, 2)] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("UPDATE users SET is_tenant_ops=false WHERE org_id=$1 AND id=$2")
            .bind(org)
            .bind(previous_ops.as_uuid())
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("UPDATE users SET is_tenant_ops=true WHERE org_id=$1 AND id=$2")
            .bind(org)
            .bind(next_ops.as_uuid())
            .execute(tx.as_mut())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM access_grants g WHERE org_id=$1 AND account_id=$2 AND status='ACTIVE' AND (valid_to IS NULL OR valid_to > now()) AND NOT EXISTS (SELECT 1 FROM authz_grant_ledger n WHERE n.org_id=g.org_id AND n.grant_ref=g.id::text AND n.event='NOTICE_DELIVERED')")
            .bind(org).bind(holder.as_uuid()).fetch_one(&pool).await.unwrap();
        assert_eq!(pending, 2, "ops handover does not consume pending notices");
        let page = inbox(&ctx).await;
        let rows = items_of(&page, "grant_notice");
        assert_eq!(
            rows.len(),
            count,
            "ops skips notices; handover restores them: {page}"
        );
        if count > 0 {
            assert_eq!(
                rows.iter()
                    .map(|row| row["links"][0]["id"].as_str().unwrap().to_owned())
                    .collect::<BTreeSet<_>>(),
                expected
            );
        }
    }
    for grant in expected {
        let (status, result) = ctx
            .call(
                "POST",
                &format!("/api/v1/access/grants/{grant}/notice"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{result}");
    }
    assert!(items_of(&inbox(&ctx).await, "grant_notice").is_empty());
}
