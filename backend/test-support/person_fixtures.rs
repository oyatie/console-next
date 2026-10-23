// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::UserId;
use sqlx::PgPool;
use uuid::Uuid;

/// Bind an existing account to a new natural person as the fixture owner.
#[allow(dead_code)]
pub async fn bind_user_to_distinct_person(owner: &PgPool, user: UserId) -> (Uuid, Uuid) {
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM users WHERE id = $1")
        .bind(*user.as_uuid())
        .fetch_one(owner)
        .await
        .unwrap();
    let person = sqlx::query_scalar("INSERT INTO persons (org_id) VALUES ($1) RETURNING id")
        .bind(org)
        .fetch_one(owner)
        .await
        .unwrap();
    (bind_user_to_person(owner, user, person).await, person)
}

/// Preserve the employee link and explicitly replace its fixture person binding.
pub async fn bind_user_to_person(owner: &PgPool, user: UserId, person: Uuid) -> Uuid {
    let (org, linked): (Uuid, Option<Uuid>) =
        sqlx::query_as("SELECT org_id, employee_id FROM users WHERE id = $1")
            .bind(*user.as_uuid())
            .fetch_one(owner)
            .await
            .unwrap();
    let employee = match linked {
        Some(employee) => employee,
        None => sqlx::query_scalar(
            "INSERT INTO employees \
                 (org_id, company, name, source_filename, source_sheet, source_row, source_key) \
                 VALUES ($1, 'ACME', $2, 'person-fixture.xlsx', 'People', 1, $2) RETURNING id",
        )
        .bind(org)
        .bind(format!("person-fixture-{user}"))
        .fetch_one(owner)
        .await
        .unwrap(),
    };
    sqlx::query("DELETE FROM employee_person_bindings WHERE org_id = $1 AND employee_id = $2")
        .bind(org)
        .bind(employee)
        .execute(owner)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employee_person_bindings \
         (org_id, employee_id, person_id, actor_id, payload_digest) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(org)
    .bind(employee)
    .bind(person)
    .bind(*user.as_uuid())
    .bind([7_u8; 32].as_slice())
    .execute(owner)
    .await
    .unwrap();
    sqlx::query("UPDATE employees SET identity_review_required=false WHERE org_id=$1 AND id=$2")
        .bind(org)
        .bind(employee)
        .execute(owner)
        .await
        .unwrap();
    sqlx::query("INSERT INTO employee_identity_resolutions(org_id,employee_id,verdict,reason_code,resolved_by) SELECT $1,$2,'DIFFERENT','fixture-verified',$3 WHERE EXISTS(SELECT 1 FROM person_binding_reviews_open WHERE org_id=$1 AND subject_kind='EMPLOYEE' AND subject_id=$2)")
        .bind(org).bind(employee).bind(user.as_uuid()).execute(owner).await.unwrap();
    sqlx::query("UPDATE users SET employee_id = $1 WHERE id = $2 AND org_id = $3")
        .bind(employee)
        .bind(*user.as_uuid())
        .bind(org)
        .execute(owner)
        .await
        .unwrap();
    employee
}

/// Real G5 account shapes: a minted Person alone is not decision evidence.
#[allow(dead_code)]
pub async fn unverified_decision_parties(
    owner: &PgPool,
    maker: UserId,
    checker: UserId,
) -> Vec<(&'static str, UserId, UserId)> {
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM users WHERE id=$1")
        .bind(maker.as_uuid())
        .fetch_one(owner)
        .await
        .unwrap();
    let mut accounts = Vec::new();
    for _ in 0..7 {
        let id: Uuid = sqlx::query_scalar("INSERT INTO users(org_id,display_name,roles) SELECT org_id,display_name,ARRAY['ADMIN'] FROM users WHERE id=$1 RETURNING id")
            .bind(maker.as_uuid()).fetch_one(owner).await.unwrap();
        accounts.push(UserId::from_uuid(id));
    }
    for (account, kind) in [(accounts[2], "ACCOUNT"), (accounts[3], "EMPLOYEE")] {
        let (employee, _) = bind_user_to_distinct_person(owner, account).await;
        sqlx::query("INSERT INTO person_binding_reviews(org_id,subject_kind,subject_id,reason,evidence) VALUES($1,$2,$3,'NUMBER_BIRTH_AMBIGUOUS','{}')")
            .bind(org).bind(kind).bind(if kind=="ACCOUNT" {*account.as_uuid()} else {employee})
            .execute(owner).await.unwrap();
    }
    // Reproduce onboarding's operations principal with a Person but no employee record.
    sqlx::query("INSERT INTO persons(org_id,id) VALUES($1,$2) ON CONFLICT DO NOTHING")
        .bind(org)
        .bind(accounts[4].as_uuid())
        .execute(owner)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(accounts[4].as_uuid())
        .execute(owner)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET person_id=id WHERE id=$1")
        .bind(accounts[4].as_uuid())
        .execute(owner)
        .await
        .unwrap();
    let (employee, _) = bind_user_to_distinct_person(owner, accounts[5]).await;
    sqlx::query("DELETE FROM employee_person_bindings WHERE org_id=$1 AND employee_id=$2")
        .bind(org)
        .bind(employee)
        .execute(owner)
        .await
        .unwrap();
    sqlx::query("INSERT INTO person_binding_reviews(org_id,subject_kind,subject_id,reason,evidence) VALUES($1,'ACCOUNT',$2,'EMPLOYEE_LINK_MISSING','{}')")
        .bind(org).bind(accounts[6].as_uuid()).execute(owner).await.unwrap();
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at=now(),go_live_by=$2,go_live_preview_digest=repeat('a',64) WHERE org_id=$1")
        .bind(org).bind(maker.as_uuid()).execute(owner).await.unwrap();
    vec![
        (
            "linked maker and unlinked second account",
            maker,
            accounts[0],
        ),
        ("two unlinked accounts", accounts[0], accounts[1]),
        ("open missing-employee review", maker, accounts[6]),
        ("open account review", maker, accounts[2]),
        ("open employee review", maker, accounts[3]),
        ("reviewed maker", accounts[3], checker),
        ("bootstrap operator after go-live", maker, accounts[4]),
        ("missing employee binding", maker, accounts[5]),
    ]
}
