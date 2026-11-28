// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
#[path = "support/http.rs"]
mod http;

use ::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

const CYCLES: &str = "/api/v1/evaluation/cycles";

fn advertised(projection: &Value, feature: &str) -> bool {
    projection["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|cap| cap["feature"] == feature)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cycle_navigation_agrees_with_independent_list_and_create_commands(pool: PgPool) {
    let (org, manager) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let branch: Uuid = sqlx::query_scalar("WITH r AS (INSERT INTO regions(org_id,name) VALUES($1,'North') RETURNING id) INSERT INTO branches(org_id,region_id,name) SELECT $1,id,'Harbor' FROM r RETURNING id")
        .bind(org).fetch_one(&pool).await.unwrap();
    let reader = http::add_user(&pool, org, &["EXECUTIVE"]).await;
    let member = http::add_user(&pool, org, &["MEMBER"]).await;
    for user in [manager, reader, member] {
        sqlx::query("INSERT INTO user_branches(user_id,branch_id,org_id) VALUES($1,$2,$3)")
            .bind(user.as_uuid())
            .bind(branch)
            .bind(org)
            .execute(&pool)
            .await
            .unwrap();
    }
    let input = json!({"name":"Autumn review","kind":"REGULAR","period_label":"Autumn","due_date":"2030-11-30"});
    for (user, role, read, create) in [
        (reader, "EXECUTIVE", true, false),
        (member, "MEMBER", false, false),
        (manager, "SUPER_ADMIN", true, true),
    ] {
        let ctx = http::ctx(&pool, org, user, &[role], None).await;
        let (status, caps) = ctx.call("GET", "/api/v1/me/authz", None).await;
        assert_eq!(status, StatusCode::OK);
        let served = cfg!(feature = "evaluation");
        assert_eq!(
            advertised(&caps, "served_evaluation_cycles"),
            served && read
        );
        assert_eq!(
            advertised(&caps, "served_evaluation_cycle_create"),
            served && create
        );
        let (status, page) = ctx.call("GET", CYCLES, None).await;
        let expected = if !served {
            StatusCode::NOT_FOUND
        } else if read {
            StatusCode::OK
        } else {
            StatusCode::FORBIDDEN
        };
        assert_eq!(status, expected, "{page}");
        let (status, created) = ctx.call("POST", CYCLES, Some(input.clone())).await;
        let expected = if !served {
            StatusCode::NOT_FOUND
        } else if create {
            StatusCode::CREATED
        } else {
            StatusCode::FORBIDDEN
        };
        assert_eq!(status, expected, "{created}");
        if served && create {
            let (repeat, replayed) = ctx.retry("POST", CYCLES, Some(input.clone())).await;
            assert_eq!(repeat, StatusCode::CONFLICT, "{replayed}");
            assert_eq!(replayed["error"]["code"], "command_applied");
            let (status, list) = ctx.call("GET", CYCLES, None).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(list["total"], 1);
            assert_eq!(list["items"][0]["id"], created["id"]);
            let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND target_type='evaluation_cycle' AND target_id=$2 AND action='evaluation.cycle.created'")
                .bind(org).bind(created["id"].as_str().unwrap()).fetch_one(&pool).await.unwrap();
            assert_eq!(audits, 1);
        }
    }
}

#[cfg(feature = "evaluation")]
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tied_creation_dates_have_stable_pages_and_archived_cycles_remain_reachable(pool: PgPool) {
    let (org, editor) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let (other, other_editor) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    for (tenant, user, n, stage) in [
        (org, editor, 2, "DRAFT"),
        (org, editor, 1, "OPEN"),
        (org, editor, 3, "ARCHIVED"),
        (org, editor, 4, "DRAFT"),
        (other, other_editor, 5, "DRAFT"),
    ] {
        sqlx::query("INSERT INTO evaluation_cycles(id,org_id,name,kind,period_label,due_date,stage,created_by,created_at,updated_at) VALUES($1,$2,'Cycle','REGULAR','Autumn','2030-11-30',$3,$4,'2030-01-01','2030-01-01')")
            .bind(Uuid::from_u128(n)).bind(tenant).bind(stage).bind(user.as_uuid()).execute(&pool).await.unwrap();
    }
    let ctx = http::ctx(&pool, org, editor, &["SUPER_ADMIN"], None).await;
    for (url, total, expected) in [
        (format!("{CYCLES}?limit=2"), 3, vec![4u128, 2]),
        (format!("{CYCLES}?limit=2&offset=2"), 3, vec![1]),
        (format!("{CYCLES}?stage=ARCHIVED"), 1, vec![3]),
        (format!("{CYCLES}?limit=2&offset=20"), 3, vec![]),
        (format!("{CYCLES}?stage=CALIBRATION"), 0, vec![]),
    ] {
        let (st, page) = ctx.call("GET", &url, None).await;
        assert_eq!(st, StatusCode::OK, "{page}");
        assert_eq!(page["total"], total);
        let ids: Vec<_> = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| {
                Uuid::parse_str(v["id"].as_str().unwrap())
                    .unwrap()
                    .as_u128()
            })
            .collect();
        assert_eq!(ids, expected);
    }
}
