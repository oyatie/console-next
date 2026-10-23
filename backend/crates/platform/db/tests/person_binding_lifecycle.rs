// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use sqlx::PgPool;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

async fn tenant(pool: &PgPool) -> Uuid {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Binding lifecycle')")
        .bind(org)
        .bind(org.to_string())
        .execute(pool)
        .await
        .unwrap();
    org
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn account_conflicts_never_create_duplicate_or_orphan_people(pool: PgPool) {
    let org = tenant(&pool).await;
    let account: Uuid = sqlx::query_scalar("INSERT INTO users(org_id,display_name,phone) VALUES($1,'Original','01099998888') RETURNING id")
        .bind(org).fetch_one(&pool).await.unwrap();
    for id in [account, Uuid::new_v4()] {
        let skipped = sqlx::query("INSERT INTO users(id,org_id,display_name,phone) VALUES($1,$2,'Ignored','01099998888') ON CONFLICT DO NOTHING")
            .bind(id).bind(org).execute(&pool).await.unwrap();
        assert_eq!(skipped.rows_affected(), 0);
    }
    let updated: Uuid = sqlx::query_scalar("INSERT INTO users(org_id,display_name,phone) VALUES($1,'Updated','01099998888') ON CONFLICT(phone) WHERE phone IS NOT NULL DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(updated, account);
    let counts: (i64, i64, i64) = sqlx::query_as("SELECT (SELECT count(*) FROM persons WHERE org_id=$1),(SELECT count(*) FROM users WHERE org_id=$1),(SELECT count(*) FROM person_revisions WHERE org_id=$1)")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (1, 1, 2));
    let name: String =
        sqlx::query_scalar("SELECT display_name FROM person_accounts_current WHERE id=$1")
            .bind(account)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(name, "Updated");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn tenant_removal_clears_people_only_after_eligibility_passes(pool: PgPool) {
    let kept = tenant(&pool).await;
    for force in [false, true] {
        let org = tenant(&pool).await;
        let account: Uuid = sqlx::query_scalar(
            "INSERT INTO users(org_id,display_name) VALUES($1,'Owner') RETURNING id",
        )
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
        if force {
            let employee: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES($1,'Co','Owner','test','test',1,'owner') RETURNING id")
                .bind(org).fetch_one(&pool).await.unwrap();
            sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2")
                .bind(employee)
                .bind(account)
                .execute(&pool)
                .await
                .unwrap();
            let refused: String =
                sqlx::query_scalar("SELECT platform_force_remove_organization($1)")
                    .bind(org)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(refused, "blocked_active");
            let still_bound: Option<Uuid> =
                sqlx::query_scalar("SELECT person_id FROM users WHERE id=$1")
                    .bind(account)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert!(still_bound.is_some());
            sqlx::query("UPDATE organizations SET status='ARCHIVED' WHERE id=$1")
                .bind(org)
                .execute(&pool)
                .await
                .unwrap();
        }
        let sql = if force {
            "SELECT platform_force_remove_organization($1)"
        } else {
            "SELECT platform_remove_organization($1)"
        };
        let removed: String = sqlx::query_scalar(sql)
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(removed, "removed");
        let remaining: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM persons WHERE org_id=$1)+(SELECT count(*) FROM person_revisions WHERE org_id=$1)+(SELECT count(*) FROM employee_person_bindings WHERE org_id=$1)")
            .bind(org).fetch_one(&pool).await.unwrap();
        assert_eq!(remaining, 0);
    }
    let untouched: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1)")
            .bind(kept)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(untouched);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn runtime_cannot_forge_person_revision_erasure(pool: PgPool) {
    let org = tenant(&pool).await;
    sqlx::query("INSERT INTO users(org_id,display_name) VALUES($1,'Retained')")
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("GRANT DELETE ON person_revisions TO console_rt")
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "SELECT set_config('app.current_org',$1,true),set_config('app.person_erasure_org',$1,true)",
    )
    .bind(org.to_string())
    .execute(tx.as_mut())
    .await
    .unwrap();
    let error = sqlx::query("DELETE FROM person_revisions WHERE org_id=$1")
        .bind(org)
        .execute(tx.as_mut())
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("P0001")
    );
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn compatibility_revisions_never_invent_a_human_actor(pool: PgPool) {
    let org = tenant(&pool).await;
    let creator: Uuid = sqlx::query_scalar(
        "INSERT INTO users(org_id,display_name) VALUES($1,'Creator') RETURNING id",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES($1,'Co','Subject','test','test',1,'subject') RETURNING id")
        .bind(org).fetch_one(&pool).await.unwrap();
    let account: Uuid = sqlx::query_scalar(
        "INSERT INTO users(org_id,employee_id,display_name) VALUES($1,$2,'Subject') RETURNING id",
    )
    .bind(org)
    .bind(employee)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO employee_employment_profiles(org_id,employee_id,employment_type,phone_e164,idempotency_key,request_hash,created_by) VALUES($1,$2,'REGULAR','+821098761234','subject',repeat('a',64),$3)")
        .bind(org).bind(employee).bind(creator).execute(&pool).await.unwrap();
    sqlx::query("UPDATE users SET display_name='Edited' WHERE id=$1")
        .bind(account)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE employee_employment_profiles SET phone_e164='+821012349876' WHERE employee_id=$1",
    )
    .bind(employee)
    .execute(&pool)
    .await
    .unwrap();
    let attributed: i64 = sqlx::query_scalar("SELECT count(*) FROM person_revisions WHERE org_id=$1 AND origin='binding' AND actor_id IS NOT NULL")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(
        attributed, 0,
        "the subject and original creator are not evidence of who edited"
    );
}
