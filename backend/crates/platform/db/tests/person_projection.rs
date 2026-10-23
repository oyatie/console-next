// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use sqlx::{PgPool, Row};
use uuid::Uuid;
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[sqlx::test(migrator = "MIGRATOR")]
async fn legacy_edits_and_person_revisions_keep_every_projection_current(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Projection')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,birth_date,source_filename,source_sheet,source_row,source_key) VALUES($1,'Co','Before','1990-01-01','test','test',1,'a') RETURNING id")
        .bind(org).fetch_one(&pool).await.unwrap();
    let account: Uuid = sqlx::query_scalar("INSERT INTO users(org_id,employee_id,display_name) VALUES($1,$2,'Invite snapshot') RETURNING id")
        .bind(org).bind(employee).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO employee_employment_profiles(org_id,employee_id,employment_type,phone_e164,idempotency_key,request_hash,created_by) VALUES($1,$2,'REGULAR','+821011112222','projection',repeat('a',64),$3)")
        .bind(org).bind(employee).bind(account).execute(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    // The released HR correction writes these raw columns; raw attendance searches must find it.
    sqlx::query("UPDATE employees SET name='After',birth_date='1991-02-02' WHERE id=$1")
        .bind(employee)
        .execute(tx.as_mut())
        .await
        .unwrap();
    let matches: i64 = sqlx::query_scalar("SELECT count(*) FROM employees e WHERE e.id=$1 AND e.name ILIKE '%After%' AND e.birth_date='1991-02-02'")
        .bind(employee).fetch_one(tx.as_mut()).await.unwrap();
    assert_eq!(
        matches, 1,
        "unswitched search and date readers stay current"
    );
    let invited: String = sqlx::query_scalar("SELECT display_name FROM users WHERE id=$1")
        .bind(account)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(invited, "After");
    // The account edit path must revise Person (M6), not merely its own label.
    sqlx::query("UPDATE users SET display_name='Preferred',phone='+821033334444' WHERE id=$1")
        .bind(account)
        .execute(tx.as_mut())
        .await
        .unwrap();
    let facts: serde_json::Value = sqlx::query_scalar("SELECT console_employee_facts($1,$2)")
        .bind(org)
        .bind(employee)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(facts["display_name"], "Preferred");
    assert_eq!(facts["legal_name"], "After");
    assert_eq!(facts["phone"], "+821033334444");
    let phone: String = sqlx::query_scalar(
        "SELECT phone_e164 FROM employee_employment_profiles WHERE employee_id=$1",
    )
    .bind(employee)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    assert_eq!(phone, "+821033334444");
    sqlx::query("SELECT console_revise_person_facts($1,console_employee_person($1,$2),'{\"legal_name\":\"Canonical\",\"birth_date\":null,\"phone\":null}'::jsonb,NULL)")
        .bind(org).bind(employee).execute(tx.as_mut()).await.unwrap();
    let raw = sqlx::query("SELECT e.name,e.birth_date,p.phone_e164,u.display_name,u.phone FROM employees e JOIN employee_employment_profiles p ON p.employee_id=e.id JOIN users u ON u.employee_id=e.id WHERE e.id=$1")
        .bind(employee).fetch_one(tx.as_mut()).await.unwrap();
    assert_eq!(raw.get::<String, _>("name"), "Canonical");
    assert_eq!(raw.get::<Option<time::Date>, _>("birth_date"), None);
    assert_eq!(raw.get::<Option<String>, _>("phone_e164"), None);
    assert_eq!(raw.get::<String, _>("display_name"), "Preferred");
    assert_eq!(raw.get::<Option<String>, _>("phone"), None);
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn unflagged_number_birth_matches_never_merge_different_people_and_reuse_equal_people(
    pool: PgPool,
) {
    sqlx::query("DROP INDEX employees_org_employee_number_key")
        .execute(&pool)
        .await
        .unwrap();
    for import in [false, true] {
        for same_birth in [false, true] {
            let org = Uuid::new_v4();
            sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Birth matching')")
                .bind(org)
                .bind(org.to_string())
                .execute(&pool)
                .await
                .unwrap();
            let mut tx = pool.begin().await.unwrap();
            sqlx::query("SELECT set_config('app.current_org',$1,true)")
                .bind(org.to_string())
                .execute(tx.as_mut())
                .await
                .unwrap();
            if import {
                sqlx::query("SET LOCAL ROLE console_leave_definer")
                    .execute(tx.as_mut())
                    .await
                    .unwrap();
            }
            let mut people = Vec::new();
            for (key, birth) in [
                ("a", "1990-01-01"),
                (
                    "b",
                    if same_birth {
                        "1990-01-01"
                    } else {
                        "1991-02-02"
                    },
                ),
            ] {
                let employee: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,employee_number,birth_date,identity_review_required,source_filename,source_sheet,source_row,source_key) VALUES($1,'Co','Person','DUP',$2::date,false,'test','test',1,$3) RETURNING id")
                    .bind(org).bind(birth).bind(key).fetch_one(tx.as_mut()).await.unwrap();
                if !import {
                    sqlx::query("SELECT console_bind_employee_person($1,$2,NULL)")
                        .bind(org)
                        .bind(employee)
                        .execute(tx.as_mut())
                        .await
                        .unwrap();
                }
                let person: Uuid = sqlx::query_scalar("SELECT console_employee_person($1,$2)")
                    .bind(org)
                    .bind(employee)
                    .fetch_one(tx.as_mut())
                    .await
                    .unwrap();
                people.push(person);
            }
            assert_eq!(
                people[0] == people[1],
                same_birth,
                "import={import}, equal birth={same_birth}"
            );
            sqlx::query("RESET ROLE")
                .execute(tx.as_mut())
                .await
                .unwrap();
            for _ in 0..2 {
                sqlx::query("SELECT console_backfill_person_bindings($1)")
                    .bind(org)
                    .execute(tx.as_mut())
                    .await
                    .unwrap();
            }
            let reviews: i64 = sqlx::query_scalar("SELECT count(*) FROM person_binding_reviews WHERE org_id=$1 AND reason='NUMBER_BIRTH_AMBIGUOUS'")
                .bind(org).fetch_one(tx.as_mut()).await.unwrap();
            assert_eq!(
                reviews,
                if same_birth { 0 } else { 2 },
                "one durable review per ambiguous subject"
            );
            tx.commit().await.unwrap();
        }
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn linking_and_ops_handover_settle_the_person_projection_in_the_same_transaction(
    pool: PgPool,
) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Account transitions')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let employee: Uuid=sqlx::query_scalar("INSERT INTO employees(org_id,company,name,identity_review_required,source_filename,source_sheet,source_row,source_key) VALUES($1,'Co','Employee',false,'test','test',1,'link') RETURNING id")
        .bind(org).fetch_one(&pool).await.unwrap();
    let account: Uuid = sqlx::query_scalar(
        "INSERT INTO users(org_id,display_name) VALUES($1,'Old account') RETURNING id",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    let ops: Uuid=sqlx::query_scalar("INSERT INTO users(org_id,display_name,is_tenant_ops) VALUES($1,'Operator',true) RETURNING id")
        .bind(org).fetch_one(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let linked: (Uuid, String) = sqlx::query_as(
        "UPDATE users SET employee_id=$1 WHERE id=$2 RETURNING person_id,display_name",
    )
    .bind(employee)
    .bind(account)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    assert_eq!(
        linked,
        (employee, "Employee".into()),
        "an existing account projects immediately when linked"
    );
    sqlx::query("UPDATE users SET is_tenant_ops=false WHERE id=$1")
        .bind(ops)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(account)
        .execute(tx.as_mut())
        .await
        .unwrap();
    let former: (Uuid, String) =
        sqlx::query_as("SELECT person_id,principal_kind FROM users WHERE id=$1")
            .bind(ops)
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
    assert_eq!(former, (ops, "TENANT_PERSON".into()));
    let facts: serde_json::Value = sqlx::query_scalar("SELECT console_person_facts($1,$2)")
        .bind(org)
        .bind(ops)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(facts["legal_name"], "Operator");
    tx.commit().await.unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn an_account_attached_before_employee_binding_follows_employee_facts(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Early account')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let employee: Uuid=sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES($1,'Co','Employee fact','test','test',1,'early') RETURNING id")
        .bind(org).fetch_one(&pool).await.unwrap();
    // A retained pre-binding account: its own Person must not overwrite employee facts during sync.
    sqlx::query("ALTER TABLE users DISABLE TRIGGER person_bind_account")
        .execute(&pool)
        .await
        .unwrap();
    let account = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,org_id,employee_id,person_id,display_name) VALUES($1,$2,$3,$1,'Old account fact')")
        .bind(account).bind(org).bind(employee).execute(&pool).await.unwrap();
    sqlx::query("ALTER TABLE users ENABLE TRIGGER person_bind_account")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("SELECT console_bind_employee_person($1,$2,NULL)")
        .bind(org)
        .bind(employee)
        .execute(&pool)
        .await
        .unwrap();
    let bound: (Uuid, String) =
        sqlx::query_as("SELECT person_id,display_name FROM users WHERE id=$1")
            .bind(account)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(bound, (employee, "Employee fact".into()));
}
