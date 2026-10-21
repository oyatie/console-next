// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_routed_http_request_refuses_the_requester_then_a_second_holder_applies_with_live_frames(
    pool: PgPool,
) {
    let i = import_fixture::importer(pool.clone()).await;
    let second = user(&pool, i.org(), "SUPER_ADMIN").await;
    for id in [i.f.principal.user_id, second] {
        eligible_holder(&i, id).await;
    }
    let run = applied_run(&i).await;
    import_policy(&i, true, false).await;
    let keys = keys();
    let service = router(&pool, &keys).await;
    let requester = Caller {
        service: service.clone(),
        token: Some(token(&pool, &keys, i.org(), i.f.principal.user_id, "SUPER_ADMIN").await),
    };
    let decider = Caller {
        service,
        token: Some(token(&pool, &keys, i.org(), second, "SUPER_ADMIN").await),
    };
    let record = format!("/api/v1/employee-import-runs/{run}");
    let path = format!("{record}/rollback");
    let (status, preview) = requester
        .call("POST", &format!("{path}/preview"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["basis"], "SECOND_PERSON");
    let command = serde_json::json!({"preview_digest":preview["preview_digest"],"reason_code":"WRONG_FILE","acknowledged":true});
    let (status, request) = requester.call("POST", &path, Some(command.clone())).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{request}");
    assert_eq!(request["status"], "ROLLBACK_REQUESTED");
    let request_id = request["request_id"].as_str().unwrap();
    assert_eq!(
        rollback_frames(&i, run).await,
        ["data_import.rollback_request"]
    );
    let (status, pending) = requester.call("GET", &record, None).await;
    assert_eq!(status, StatusCode::OK, "{pending}");
    assert_eq!(pending["status"], "ROLLBACK_REQUESTED");
    assert_eq!(
        pending["rollback"]["pending_request"]["requested_by"],
        i.f.principal.user_id.to_string()
    );
    let (status, error) = requester.call("POST", &path, Some(command)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["error"]["code"], "import_rollback_pending");
    let decide = format!("/api/v1/change-requests/{request_id}/decide");
    let decision = serde_json::json!({"decision":"APPLY","reason_code":"CONFIRMED"});
    let (status, error) = requester
        .call("POST", &decide, Some(decision.clone()))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
    assert_eq!(error["error"]["code"], "authz_sod_requester");
    assert_eq!(
        rollback_frames(&i, run).await,
        ["data_import.rollback_request"]
    );
    let (status, applied) = decider.call("POST", &decide, Some(decision)).await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["status"], "APPLIED");
    let (status, done) = requester.call("GET", &record, None).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["status"], "ROLLED_BACK");
    assert!(done["rollback"]["pending_request"].is_null());
    assert_eq!(done["rolled_back_by"]["id"], second.to_string());
    let actors: (Uuid,Uuid) = sqlx::query_as("SELECT rollback_requested_by,rolled_back_by FROM data_import_runs WHERE org_id=$1 AND id=$2")
        .bind(i.org()).bind(run).fetch_one(&pool).await.unwrap();
    assert_eq!(
        actors,
        (*i.f.principal.user_id.as_uuid(), *second.as_uuid())
    );
    assert_eq!(
        rollback_frames(&i, run).await,
        ["data_import.rollback_request", "data_import.rollback"]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_http_run_policy_and_step_up_refusal_matrix(pool: PgPool) {
    for code in [
        "import_run_not_applied",
        "import_run_predates_ledger",
        "import_rollback_window_closed",
        "reason_code",
        "step_up_required",
        "step_up_failed",
        "import_rollback_sole_holder_refused",
    ] {
        let i = import_fixture::importer(pool.clone()).await;
        let run = if code == "import_run_not_applied" {
            i.preview(
                "preview-only.xlsx",
                &[import_fixture::table(
                    "명부",
                    0,
                    &[
                        &["사번", "성명", "입사일"],
                        &["HTTP-ONLY", "미적용", "2024-03-04"],
                    ],
                )],
                &Default::default(),
            )
            .await
            .unwrap()
            .run_id
        } else {
            applied_run(&i).await
        };
        if code == "import_run_predates_ledger" {
            sqlx::query("UPDATE data_import_runs SET rollback_ledger_complete=false WHERE org_id=$1 AND id=$2")
                .bind(i.org()).bind(run).execute(&pool).await.unwrap();
        } else if code != "import_run_not_applied" {
            let sole = code == "import_rollback_sole_holder_refused";
            import_policy(&i, sole, sole).await;
        }
        if code == "import_rollback_window_closed" {
            let mut tx = pool.begin().await.unwrap();
            sqlx::query("SELECT set_config('app.current_org',$1,true)")
                .bind(i.org().to_string())
                .execute(tx.as_mut())
                .await
                .unwrap();
            sqlx::query("SET LOCAL ROLE console_leave_definer")
                .execute(tx.as_mut())
                .await
                .unwrap();
            sqlx::query("UPDATE data_import_runs SET applied_at=now()-interval '31 days' WHERE org_id=$1 AND id=$2")
                .bind(i.org()).bind(run).execute(tx.as_mut()).await.unwrap();
            tx.commit().await.unwrap();
        }
        let keys = keys();
        let caller = Caller {
            service: router(&pool, &keys).await,
            token: Some(token(&pool, &keys, i.org(), i.f.principal.user_id, "SUPER_ADMIN").await),
        };
        let path = format!("/api/v1/employee-import-runs/{run}/rollback");
        let digest =
            i.f.hr
                .preview_import_rollback(i.f.principal.clone(), run)
                .await
                .map(|p| p.preview_digest)
                .unwrap_or_else(|_| "unused".into());
        let mut body = serde_json::json!({"preview_digest":digest,"acknowledged":true});
        if code != "reason_code" {
            body["reason_code"] = serde_json::json!("WRONG_FILE");
        }
        if code == "step_up_failed" {
            use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};
            let mut key = SoftKey::enroll(&pool, i.f.principal.org_id, i.f.principal.user_id).await;
            let binding = console_hr_adapter_postgres::import::rollback::rollback_binding(
                Uuid::new_v4(),
                &digest,
            );
            let start = passkey_service()
                .start_mobile_step_up(&pool, *i.f.principal.user_id.as_uuid(), binding.clone())
                .await
                .unwrap();
            let mut challenge = serde_json::to_value(start.challenge).unwrap();
            challenge["publicKey"]["allowCredentials"] =
                serde_json::json!([{"type":"public-key","id":key.credential_id()}]);
            body["step_up"] = serde_json::json!({"binding":binding,"assertion":{"ceremony_id":start.ceremony_id,"credential":key.assert(&challenge).unwrap()}});
        }
        let (status, error) = caller.call("POST", &path, Some(body)).await;
        let expected = match code {
            "reason_code" => StatusCode::UNPROCESSABLE_ENTITY,
            "step_up_required" | "step_up_failed" => StatusCode::UNAUTHORIZED,
            "import_rollback_sole_holder_refused" => StatusCode::FORBIDDEN,
            _ => StatusCode::CONFLICT,
        };
        assert_eq!(status, expected, "{code}: {error}");
        assert_eq!(error["error"]["code"], code, "{error}");
        let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND target_id=$2 AND action IN ('data_import.rollback_request','data_import.rollback')")
            .bind(i.org()).bind(run.to_string()).fetch_one(&pool).await.unwrap();
        assert_eq!(audits, 0, "{code}");
        let record = i.f.hr.import_run(i.f.principal.clone(), run).await.unwrap();
        assert_eq!(
            record.status,
            if code == "import_run_not_applied" {
                "PREVIEWED"
            } else {
                "APPLIED"
            }
        );
    }
}
