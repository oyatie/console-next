// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_authz::Role;
use sqlx::PgPool;
use uuid::Uuid;

use crate::harness::{Importer, decisions, importer, table};
use crate::mig_job::body;

async fn directory_holder(i: &mut Importer) -> Uuid {
    let role = Uuid::new_v4();
    let actor = *i.f.principal.user_id.as_uuid();
    let grantor = console_platform_test_support::seed_active_user(
        &i.owner,
        i.org(),
        "SUPER_ADMIN",
        "Grant administrator",
    )
    .await;
    let mut tx = i.owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(i.org().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING' WHERE org_id=$1")
        .bind(i.org())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'Directory','ACTIVE',1,$3)")
        .bind(i.org()).bind(role).bind(actor).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'Directory','ACTIVE','SETUP',$3)")
        .bind(i.org()).bind(role).bind(actor).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'hr_basic',ARRAY['edit'])")
        .bind(i.org()).bind(role).execute(tx.as_mut()).await.unwrap();
    let grant = sqlx::query_scalar("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',false,'SETUP','TEST',$4) RETURNING id")
        .bind(i.org()).bind(actor).bind(role).bind(grantor.as_uuid()).fetch_one(tx.as_mut()).await.unwrap();
    sqlx::query("UPDATE users SET roles=ARRAY['MEMBER'] WHERE org_id=$1 AND id=$2")
        .bind(i.org())
        .bind(actor)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    i.f.principal.roles = [Role::Member].into();
    grant
}

async fn staged(i: &Importer) -> (Uuid, String) {
    let run = i
        .preview(
            "people.xlsx",
            &[table(
                "Roster",
                0,
                &[
                    &[
                        "Employee Number",
                        "Employee Name",
                        "Hire Date",
                        "Employment Type",
                        "leave_accrued",
                        "leave_used",
                        "leave_remaining",
                    ],
                    &[
                        "AUTH-1",
                        "Employee One",
                        "2024-03-04",
                        "REGULAR",
                        "15",
                        "3",
                        "12",
                    ],
                ],
            )],
            &Default::default(),
        )
        .await
        .unwrap()
        .run_id;
    let plan = i.dry_run(run, decisions()).await;
    assert_eq!(plan.review.blocking, 0, "{:?}", plan.review.items);
    (run, plan.dry_run_digest)
}

async fn revoke(i: &Importer, grant: Uuid) {
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_by=$2,revoked_at=now() WHERE org_id=$1 AND id=$3")
        .bind(i.org()).bind(i.f.principal.user_id.as_uuid()).bind(grant)
        .execute(&i.owner).await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn operating_directory_holder_applies_roster_and_leave_balances(pool: PgPool) {
    let mut i = importer(pool).await;
    directory_holder(&mut i).await;
    let (run, digest) = staged(&i).await;
    let report = i.apply(run, &digest).await.unwrap();
    assert_eq!(report.inserted, 1);
    let balance: (String, String, String) = sqlx::query_as(
        "SELECT leave_accrued::text,leave_used::text,leave_remaining::text FROM employees WHERE org_id=$1",
    ).bind(i.org()).fetch_one(&i.owner).await.unwrap();
    assert_eq!(
        balance,
        ("15.000000".into(), "3.000000".into(), "12.000000".into())
    );
    assert_eq!(
        i.count("SELECT count(*) FROM leave_balance_import_receipts WHERE org_id=$1")
            .await,
        1
    );
    assert_eq!(i.count("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='employee.leave_balance_import'").await, 1);

    let mut tx = i.owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(i.org().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO tenant_setting_overrides (org_id,key,value,set_by,reason_code,effective_from) VALUES ($1,'approval.policy.import_rollback','\"route\"',$2,'TEST',now()-interval '1 day')")
        .bind(i.org()).bind(i.f.principal.user_id.as_uuid()).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let (second, digest) = staged(&i).await;
    assert_ne!(second, run);
    assert_eq!(i.apply(second, &digest).await.unwrap().inserted, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn revoked_directory_holder_gets_typed_forbidden_before_start(pool: PgPool) {
    let mut i = importer(pool).await;
    let grant = directory_holder(&mut i).await;
    let (run, digest) = staged(&i).await;
    revoke(&i, grant).await;
    let error = i.apply(run, &digest).await.unwrap_err();
    assert_eq!((error.status.as_u16(), error.code), (403, "forbidden"));
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id=$1")
            .await,
        0
    );
    assert_eq!(
        i.f.hr
            .apply_job(i.f.principal.org_id, run)
            .await
            .unwrap_err()
            .status
            .as_u16(),
        404
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn revoked_directory_holder_gets_typed_forbidden_before_write(pool: PgPool) {
    let mut i = importer(pool).await;
    let grant = directory_holder(&mut i).await;
    let (run, digest) = staged(&i).await;
    i.f.hr
        .start_apply(i.f.principal.clone(), run, body(&digest))
        .await
        .unwrap();
    revoke(&i, grant).await;
    let error =
        i.f.hr
            .drive_apply(Some(i.store.clone()), i.f.principal.org_id, run)
            .await
            .unwrap_err();
    assert_eq!((error.status.as_u16(), error.code), (403, "forbidden"));
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id=$1")
            .await,
        0
    );
    assert_eq!(
        i.f.hr
            .apply_job(i.f.principal.org_id, run)
            .await
            .unwrap()
            .error
            .unwrap()["code"],
        "forbidden"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn super_admin_still_applies_roster_and_leave_balances(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = staged(&i).await;
    assert_eq!(i.apply(run, &digest).await.unwrap().inserted, 1);
    assert_eq!(
        i.count("SELECT count(*) FROM leave_balance_import_receipts WHERE org_id=$1")
            .await,
        1
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn import_capability_is_bound_to_command_and_cannot_be_replayed(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = staged(&i).await;
    let org = i.f.principal.org_id;
    let actor = i.f.principal.user_id;
    i.f.hr
        .start_apply(i.f.principal.clone(), run, body(&digest))
        .await
        .unwrap();
    let token = console_platform_request_context::scope_org(
        org,
        i.store.employee_import_capability(run, actor),
    )
    .await
    .unwrap()
    .unwrap();
    for (command_org, command_run, command_actor, allowed) in [
        (Uuid::new_v4(), run, *actor.as_uuid(), false),
        (i.org(), Uuid::new_v4(), *actor.as_uuid(), false),
        (i.org(), run, Uuid::new_v4(), false),
        (i.org(), run, *actor.as_uuid(), true),
        (i.org(), run, *actor.as_uuid(), false),
    ] {
        let mut tx = i.f.rt.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(command_org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let result = sqlx::query("SELECT * FROM import_api.apply_employee_import_batch($1,$2,'run:'||$2::text,'[]'::jsonb,$3,$4,repeat('a',32),repeat('b',16),$5)")
            .bind(command_org).bind(command_run).bind(command_actor)
            .bind(serde_json::json!({"dry_run_digest": digest})).bind(token)
            .execute(tx.as_mut()).await;
        if allowed {
            result.unwrap();
            tx.commit().await.unwrap();
        } else {
            let error = result.unwrap_err();
            let db = error.as_database_error().unwrap();
            assert_eq!(db.code().as_deref(), Some("42501"));
            assert_eq!(db.message(), "import_apply.capability_required");
            tx.rollback().await.unwrap();
        }
    }
    assert_eq!(
        i.count("SELECT count(*) FROM import_apply_capabilities WHERE org_id=$1")
            .await,
        0
    );
}
