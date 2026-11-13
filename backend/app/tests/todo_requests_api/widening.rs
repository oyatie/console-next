// SPDX-License-Identifier: LicenseRef-Proprietary
//! A to-do request grant lets its holder ask and nothing more: every list the
//! holder read before the grant reads the same after it, whatever else the
//! holder holds.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;

use crate::reach::asking_world;
use crate::support::{Ctx, add_user, ctx};
use crate::{code, picker};

const READS: [&str; 6] = [
    "/api/v1/directory/people",
    "/api/v1/employees",
    "/api/v1/branches",
    "/api/v1/legal-entities",
    "/api/v1/workplaces",
    "/api/v1/onboarding/checklist",
];

const ASK_LINES: &str = r#"[{ "domain": "todo_request", "levels": ["edit"] }]"#;

/// What `who` reads on each list: the status, and the body when it is read
/// (the refusal code otherwise).
async fn reads(who: &Ctx) -> Vec<(&'static str, StatusCode, Value)> {
    let mut out = Vec::new();
    for uri in READS {
        let (status, body) = who.call("GET", uri, None).await;
        let seen = if status.is_success() {
            body
        } else {
            json!(code(&body))
        };
        out.push((uri, status, seen));
    }
    out
}

/// Each list reads the same, named by its route when it does not.
fn same(after: &[(&str, StatusCode, Value)], before: &[(&str, StatusCode, Value)]) {
    for (now, was) in after.iter().zip(before) {
        assert_eq!((now.1, &now.2), (was.1, &was.2), "{} changed", now.0);
    }
}

fn read<'a>(reads: &'a [(&str, StatusCode, Value)], uri: &str) -> &'a Value {
    &reads.iter().find(|(u, ..)| *u == uri).unwrap().2
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_request_grant_alone_reads_what_no_grant_reads(pool: PgPool) {
    let mut w = asking_world(pool).await;
    let asker = w.holder("TENANT", None).await;
    let nobody = ctx(
        &w.pool,
        w.org,
        add_user(&w.pool, w.org, &[]).await,
        &[],
        None,
    )
    .await;
    assert!(picker(&asker).await.contains(nobody.user.as_uuid()));
    same(&reads(&asker).await, &reads(&nobody).await);
}

/// A legacy role reads over its own branches; a tenant-wide request grant
/// beside it does not widen them to every branch.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_request_grant_widens_no_branch_read(pool: PgPool) {
    let mut w = asking_world(pool).await;
    let ask = w
        .role("할 일 요청", serde_json::from_str(ASK_LINES).unwrap())
        .await;
    let admin = add_user(&w.pool, w.org, &["ADMIN"]).await;
    let other = add_user(&w.pool, w.org, &["ADMIN"]).await;
    for (user, branch) in [(admin, &w.branch_a), (other, &w.branch_b)] {
        sqlx::query(
            "INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2::uuid, $3)",
        )
        .bind(user.as_uuid())
        .bind(branch)
        .bind(w.org)
        .execute(&w.pool)
        .await
        .unwrap();
    }
    let before = reads(&ctx(&w.pool, w.org, admin, &["ADMIN"], None).await).await;
    let people = read(&before, "/api/v1/directory/people").to_string();
    assert!(people.contains(&admin.to_string()), "{people}");
    assert!(!people.contains(&other.to_string()), "{people}");

    w.grant(admin, &ask, "TENANT", None).await;
    let after = ctx(&w.pool, w.org, admin, &["ADMIN"], None).await;
    assert!(picker(&after).await.contains(other.as_uuid()));
    same(&reads(&after).await, &before);
}

/// An organization reader of one workplace keeps reading that workplace's
/// legal entities and workplaces only once it may also ask anyone.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_request_grant_widens_no_entity_read(pool: PgPool) {
    let mut w = asking_world(pool).await;
    let ask = w
        .role("할 일 요청", serde_json::from_str(ASK_LINES).unwrap())
        .await;
    let org_view = w
        .role(
            "조직 조회",
            json!([{ "domain": "org", "levels": ["view"] }]),
        )
        .await;
    let reader = add_user(&w.pool, w.org, &[]).await;
    let wp_a = w.wp_a.clone();
    w.grant(reader, &org_view, "WORKPLACE", Some(&wp_a)).await;
    let before = reads(&ctx(&w.pool, w.org, reader, &[], None).await).await;
    let workplaces = read(&before, "/api/v1/workplaces").to_string();
    let entities = read(&before, "/api/v1/legal-entities").to_string();
    assert!(workplaces.contains(&wp_a), "{workplaces}");
    assert!(entities.contains(&w.le_a), "{entities}");
    assert!(!entities.contains(&w.le_b), "{entities}");

    w.grant(reader, &ask, "TENANT", None).await;
    let after = ctx(&w.pool, w.org, reader, &[], None).await;
    assert!(picker(&after).await.contains(w.ops.user.as_uuid()));
    same(&reads(&after).await, &before);
}
