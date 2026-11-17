// SPDX-License-Identifier: LicenseRef-Proprietary
//! Whom a holder may ask is the scope node of its to-do request grant, decided
//! by Cedar over each account's placement. The picker lists exactly the
//! accounts an ask accepts.

use std::collections::BTreeSet;

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::support::{Ctx, add_user};
use crate::world::{World, world_with_lines};
use crate::{REQUESTS, ask_id, code, picker, written};

pub async fn asking_world(pool: PgPool) -> World {
    world_with_lines(
        pool,
        json!([{ "domain": "todo_request", "levels": ["edit"] }]),
    )
    .await
}

/// A new account, linked to `employee` when one is given.
async fn account(w: &World, employee: Option<&str>) -> Uuid {
    let user = *add_user(&w.pool, w.org, &[]).await.as_uuid();
    if let Some(employee) = employee {
        sqlx::query("UPDATE users SET employee_id = $1::uuid WHERE id = $2")
            .bind(employee)
            .bind(user)
            .execute(&w.pool)
            .await
            .unwrap();
    }
    user
}

/// A second workplace of legal entity A with one person registered and placed
/// there: under A, outside workplace A and its departments. A department
/// opened after go-live is an org change, so the person sits on the
/// workplace's own unit. Returns the employee.
async fn second_workplace(w: &World) -> String {
    let le_a = &w.le_a;
    let reg: String = sqlx::query_scalar(
        "SELECT id::text FROM business_registrations WHERE legal_entity_id = $1::uuid",
    )
    .bind(le_a)
    .fetch_one(&w.pool)
    .await
    .unwrap();
    let wp = w
        .ok(
            "POST",
            &format!("/api/v1/legal-entities/{le_a}/workplaces"),
            json!({
                "name": "공장", "registration_id": reg, "same_address_as_registration": true,
                "opened_on": "2021-01-04", "is_head_office": false, "kind_code": "BRANCH",
                "insurance": { "shortcut": "ALL_ESTABLISHED_NUMBERS_LATER" },
            }),
        )
        .await;
    let text = |at: &str| wp["record"][at].as_str().unwrap().to_owned();
    let (wp_a2, branch, unit) = (text("id"), text("default_branch_id"), text("org_unit_id"));
    w.person("A-009", &branch, &unit, Some((le_a, &wp_a2)))
        .await
}

/// Asks `to`; the status and the refusal code.
async fn ask(who: &Ctx, to: Uuid) -> (StatusCode, String) {
    let (status, out) = who.call("POST", REQUESTS, Some(ask_id(to))).await;
    (status, code(&out).to_owned())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn each_grant_scope_reaches_the_people_placed_under_it(pool: PgPool) {
    let mut w = asking_world(pool).await;
    let (a1, a2, b1) = (w.a1.clone(), w.a2.clone(), w.b1.clone());
    let a3 = second_workplace(&w).await;
    let targets = [
        ("a1", account(&w, Some(&a1)).await),
        ("a2", account(&w, Some(&a2)).await),
        ("a3", account(&w, Some(&a3)).await),
        ("b1", account(&w, Some(&b1)).await),
        ("unlinked", account(&w, None).await),
    ];
    let (le_a, wp_a, dept_x) = (w.le_a.clone(), w.wp_a.clone(), w.dept_x.clone());
    let holders = [
        (
            "tenant",
            w.holder("TENANT", None).await,
            &["a1", "a2", "a3", "b1", "unlinked"][..],
        ),
        (
            "legal entity",
            w.holder("LEGAL_ENTITY", Some(&le_a)).await,
            &["a1", "a2", "a3"][..],
        ),
        (
            "workplace",
            w.holder("WORKPLACE", Some(&wp_a)).await,
            &["a1", "a2"][..],
        ),
        (
            "department",
            w.holder("DEPARTMENT", Some(&dept_x)).await,
            &["a1"][..],
        ),
    ];
    for (scope, holder, reach) in &holders {
        for (name, target) in targets {
            let before = written(&w.pool, w.org).await;
            let got = ask(holder, target).await;
            if reach.contains(&name) {
                assert_eq!(got.0, StatusCode::CREATED, "{scope} -> {name}: {got:?}");
            } else {
                assert_eq!(
                    got,
                    (
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "todo_assignee_out_of_scope".to_owned()
                    ),
                    "{scope} -> {name}"
                );
                assert_eq!(written(&w.pool, w.org).await, before, "{scope} -> {name}");
            }
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_picker_lists_exactly_whom_an_ask_accepts(pool: PgPool) {
    let mut w = asking_world(pool).await;
    let a3 = second_workplace(&w).await;
    for employee in [w.a1.clone(), w.a2.clone(), a3, w.b1.clone()] {
        account(&w, Some(&employee)).await;
    }
    account(&w, None).await;
    let (le_a, wp_a, dept_x, branch) = (
        w.le_a.clone(),
        w.wp_a.clone(),
        w.dept_x.clone(),
        w.branch_a.clone(),
    );
    let placed = w
        .person("A-003", &branch, &dept_x, Some((&le_a, &wp_a)))
        .await;
    let gone = account(&w, Some(&placed)).await;
    sqlx::query("UPDATE users SET is_active = false WHERE id = $1")
        .bind(gone)
        .execute(&w.pool)
        .await
        .unwrap();
    let askers = [
        w.holder("TENANT", None).await,
        w.holder("LEGAL_ENTITY", Some(&le_a)).await,
        w.holder("WORKPLACE", Some(&wp_a)).await,
        w.holder("DEPARTMENT", Some(&dept_x)).await,
    ];
    let everyone: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE org_id = $1")
        .bind(w.org)
        .fetch_all(&w.pool)
        .await
        .unwrap();
    for asker in askers.iter().chain([&w.ops]) {
        let listed = picker(asker).await;
        let mut accepted = BTreeSet::new();
        for &to in &everyone {
            if ask(asker, to).await.0 == StatusCode::CREATED {
                accepted.insert(to);
            }
        }
        assert!(!listed.is_empty());
        assert!(!listed.contains(asker.user.as_uuid()));
        assert!(!listed.contains(&gone));
        assert_eq!(listed, accepted, "{}", asker.user);
        assert_eq!(
            ask(asker, gone).await,
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                "todo_assignee_inactive".to_owned()
            )
        );
    }
}
