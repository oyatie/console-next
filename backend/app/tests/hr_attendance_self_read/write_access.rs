// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[path = "../auth_fixtures/attendance_grants.rs"]
pub(super) mod grants;
#[path = "../access_log_reads/support.rs"]
mod requests;

async fn snapshot(pool: &PgPool) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT count(*) FROM employee_attendance_records),(SELECT count(*) FROM payroll_attendance_material_refs),(SELECT count(*) FROM data_import_runs),(SELECT count(*) FROM data_import_rows),(SELECT count(*) FROM attendance_direct_import_events),(SELECT count(*) FROM audit_events WHERE outcome='ALLOWED' AND action IN ('employee_attendance.record','payroll_attendance.link','attendance_import.preview','attendance_import.dry_run','attendance_import.apply')))")
        .fetch_one(pool).await.unwrap()
}

fn refused(response: &JsonResponse) {
    assert_eq!(response.status, StatusCode::FORBIDDEN, "{}", response.json);
    assert_eq!(
        response.json["error"]["code"],
        "attendance.refuse.missing_grant"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn linked_employee_write_requires_live_attendance_authority(pool: PgPool) {
    let keys = keys();
    // Account roles and an employee link alone confer no attendance authority.
    for role in ["MEMBER", "SUPER_ADMIN"] {
        let actor = UserId::new();
        seed_linked_employee(&pool, actor, role, role).await;
        let app = build_router(
            app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap(),
        );
        let token = bearer(&pool, &keys, actor, role).await;
        let body = json!({"kind":"CLOCK_IN","idempotency_key":"attendance-admission"});
        let before = snapshot(&pool).await;
        refused(&post(app.clone(), ME_PATH, &token, body.clone()).await);
        assert_eq!(snapshot(&pool).await, before);
        let grant_role = grants::grant(&pool, OrgId::one(), actor, None).await;
        assert_eq!(
            post(app.clone(), ME_PATH, &token, body.clone())
                .await
                .status,
            StatusCode::OK
        );
        sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE role_id=$1")
            .bind(grant_role)
            .execute(&pool)
            .await
            .unwrap();
        let before = snapshot(&pool).await;
        // A replay must recheck live authority rather than returning a cached success.
        refused(&post(app, ME_PATH, &token, body).await);
        assert_eq!(snapshot(&pool).await, before);
    }
}

async fn import_refusal(pool: PgPool, stage: &str) {
    let keys = keys();
    let actor = UserId::new();
    seed_user(&pool, actor, "SUPER_ADMIN").await;
    let token = bearer(&pool, &keys, actor, "SUPER_ADMIN").await;
    let app =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let workplace = workplace(&pool, actor).await.0;
    for scoped in [false, true] {
        if scoped {
            grants::grant(&pool, OrgId::one(), actor, Some(workplace)).await;
        }
        let before = snapshot(&pool).await;
        let response = if stage == "preview" {
            let mut request = requests::import_preview(&token, "name,date\n직원,2026-06-01\n");
            let (_, bytes) = request.body.as_mut().unwrap();
            *bytes = String::from_utf8(bytes.clone())
                .unwrap()
                .replace("근태.csv", "근태.txt")
                .into_bytes();
            let (status, json) = requests::send(&app, request).await;
            JsonResponse { status, json }
        } else {
            post(
                app.clone(),
                &format!("/api/v1/hr/attendance-import/{}/{stage}", Uuid::new_v4()),
                &token,
                json!({"checklist_all_acknowledged":true}),
            )
            .await
        };
        refused(&response);
        assert_eq!(snapshot(&pool).await, before);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attendance_preview_refuses_before_creating_a_run(pool: PgPool) {
    import_refusal(pool, "preview").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attendance_dry_run_refuses_before_loading_a_run(pool: PgPool) {
    import_refusal(pool, "dry-run").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attendance_apply_refuses_before_loading_a_run(pool: PgPool) {
    import_refusal(pool, "apply").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attendance_preview_rechecks_authority_before_persisting(pool: PgPool) {
    let keys = keys();
    let actor = UserId::new();
    seed_user(&pool, actor, "SUPER_ADMIN").await;
    let role = grants::grant(&pool, OrgId::one(), actor, None).await;
    let token = bearer(&pool, &keys, actor, "SUPER_ADMIN").await;
    let app =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    // Only the upload cap read pauses; session settings use the unchanged rows.
    let cap = console_settings_domain::SettingKey::ImportUploadMaxMib;
    sqlx::query("INSERT INTO platform_setting_overrides (key,value) VALUES ($1,$2)")
        .bind(cap.as_str())
        .bind(json!(cap.def().default.unwrap().as_int().unwrap()))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::raw_sql("ALTER TABLE platform_setting_overrides RENAME TO stored_platform_overrides;
        CREATE FUNCTION pause_upload_cap(value jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('upload_cap_read',0)); RETURN value; END $$;
        CREATE VIEW platform_setting_overrides AS SELECT id,key,pause_upload_cap(value) AS value,effective_from FROM stored_platform_overrides;
        GRANT SELECT ON platform_setting_overrides TO console_rt;")
        .execute(&pool).await.unwrap();
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('upload_cap_read',0))")
        .execute(lock.as_mut())
        .await
        .unwrap();
    let lock_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(lock.as_mut())
        .await
        .unwrap();
    let request = tokio::spawn(async move {
        requests::send(
            &app,
            requests::import_preview(
                &token,
                "사번,성명,지점,근무일,출근,퇴근\nE-1,직원,본사,2026-06-01,09:00,18:00\n",
            ),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_locks w JOIN pg_locks h USING (locktype,database,classid,objid,objsubid) WHERE NOT w.granted AND h.granted AND h.pid=$1 AND w.locktype='advisory')")
                .bind(lock_pid).fetch_one(&pool).await.unwrap();
            if waiting { break; }
            assert!(!request.is_finished(), "preview must reach the caps read");
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE role_id=$1")
        .bind(role).execute(&pool).await.unwrap();
    let before = snapshot(&pool).await;
    lock.commit().await.unwrap();
    let (status, json) = request.await.unwrap();
    refused(&JsonResponse { status, json });
    assert_eq!(snapshot(&pool).await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attendance_record_checks_the_linked_employees_placement(pool: PgPool) {
    let keys = keys();
    let actor = UserId::new();
    let employee = seed_linked_employee(&pool, actor, "MEMBER", "범위 확인").await;
    let (inside, unit) = workplace(&pool, actor).await;
    let (outside, _) = workplace(&pool, actor).await;
    sqlx::query("UPDATE employees SET org_unit_id=$2 WHERE id=$1")
        .bind(employee)
        .bind(unit)
        .execute(&pool)
        .await
        .unwrap();
    let wrong = grants::grant(&pool, OrgId::one(), actor, Some(outside)).await;
    let app =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let token = bearer(&pool, &keys, actor, "MEMBER").await;
    let body = json!({"kind":"CLOCK_IN","idempotency_key":"scoped-attendance"});
    let before = snapshot(&pool).await;
    refused(&post(app.clone(), ME_PATH, &token, body.clone()).await);
    assert_eq!(snapshot(&pool).await, before);
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE role_id=$1")
        .bind(wrong)
        .execute(&pool)
        .await
        .unwrap();
    grants::grant(&pool, OrgId::one(), actor, Some(inside)).await;
    let allowed = post(app, ME_PATH, &token, body).await;
    assert_eq!(allowed.status, StatusCode::OK, "{}", allowed.json);
}

async fn workplace(pool: &PgPool, actor: UserId) -> (Uuid, Uuid) {
    let org = OrgId::one();
    let (entity, workplace, unit) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION')")
        .bind(org.as_uuid()).bind(entity).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO workplaces (org_id,id,legal_entity_id,needs_confirmation,created_change_mode) VALUES ($1,$2,$3,true,'MIGRATION')")
        .bind(org.as_uuid()).bind(workplace).bind(entity).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO org_units (org_id,id) VALUES ($1,$2)")
        .bind(org.as_uuid())
        .bind(unit)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES ($1,$2,1,$3,$4,$5,$6,'{}')")
        .bind(org.as_uuid()).bind(unit).bind(Uuid::new_v4()).bind(actor.as_uuid())
        .bind(vec![0_u8;32]).bind(json!({"name":"부서","kind":"department","status":"active"})).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO org_unit_placements (org_id,org_unit_id,legal_entity_id,workplace_id,valid_from,change_mode,command_id) VALUES ($1,$2,$3,$4,'2026-01-01','MIGRATION',$5)")
        .bind(org.as_uuid()).bind(unit).bind(entity).bind(workplace).bind(Uuid::new_v4()).execute(pool).await.unwrap();
    (workplace, unit)
}
