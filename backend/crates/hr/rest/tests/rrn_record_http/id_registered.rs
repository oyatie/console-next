// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use axum::http::Request;
use console_hr_adapter_postgres::import::row_identifier::import_row_identifier_binding;
use console_hr_domain::profile::enums::IdType;
use serde_json::json;

pub(super) async fn draft_binding_body(
    pool: &PgPool,
    f: &mut Fixture,
    run_id: Uuid,
    source_key: &str,
    rrn: &str,
    id_type: Option<&str>,
) -> Value {
    let binding = import_row_identifier_binding(run_id, source_key);
    let start = passkey_service()
        .start_mobile_step_up(pool, *f.principal.user_id.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{"type": "public-key", "id": f.key.credential_id()}]);
    let mut body = json!({
        "rrn": rrn,
        "step_up": {
            "binding": binding,
            "assertion": {
                "ceremony_id": start.ceremony_id,
                "credential": f.key.assert(&challenge).unwrap()
            }
        }
    });
    if let Some(t) = id_type {
        body["id_type"] = json!(t);
    }
    body
}

pub(super) async fn put_draft(
    app: Router,
    run_id: Uuid,
    source_key: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!(
                    "/api/v1/employees/import/{run_id}/rows/{source_key}/identifier"
                ))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("5000014"));
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rrn_record_validates_id_type_mod11_and_emits_id_registered_for_pre_hire_not_issued(
    pool: PgPool,
) {
    let mut f = fixture(&pool).await;
    let [id, other] = f.ids;
    sqlx::query(
        "UPDATE employees SET employment_status = 'PRE_HIRE', id_type = 'NOT_ISSUED', hire_date = '2029-01-01', hire_on = '2029-01-01' WHERE id = $1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();

    // Bad Mod-11 on 5..=8 refused (422 rrn_invalid)
    let mut bad_mod11 = body(&pool, &mut f, id).await;
    bad_mod11["rrn"] = json!("900101-5000010");
    bad_mod11["id_type"] = json!("DOMESTIC_RESIDENCE");
    refusal(app(&f, true), id, bad_mod11, 422, "rrn_invalid").await;

    // Digit/type mismatch refused (422 id_type_rrn_mismatch)
    let mut mismatch = body(&pool, &mut f, other).await;
    mismatch["rrn"] = json!("900101-5000014");
    mismatch["id_type"] = json!("RRN");
    refusal(app(&f, true), other, mismatch, 422, "id_type_rrn_mismatch").await;

    // Valid DOMESTIC_RESIDENCE + Mod-11 transitions NOT_ISSUED -> DOMESTIC_RESIDENCE & emits IdRegistered
    let mut valid_dom = body(&pool, &mut f, id).await;
    valid_dom["rrn"] = json!("900101-5000014");
    valid_dom["id_type"] = json!("DOMESTIC_RESIDENCE");
    let (status, res) = put(app(&f, true), id, valid_dom).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");

    let stored_type: Option<String> =
        sqlx::query_scalar("SELECT id_type FROM employees WHERE id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        stored_type.as_deref(),
        Some(IdType::DomesticResidence.as_str())
    );

    let audit: Value = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE org_id = $1 AND target_id = $2 AND action = 'employee.id_registered'",
    )
    .bind(f.principal.org_id.as_uuid())
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit["event_type"], "IdRegistered");
    assert_eq!(audit["previous_id_type"], "NOT_ISSUED");
    assert_eq!(audit["id_type"], "DOMESTIC_RESIDENCE");
    assert_eq!(audit["source"], "FORM");
    assert!(!audit.to_string().contains("5000014"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn import_draft_row_identifier_requires_step_up_and_stages_sealed_identity(pool: PgPool) {
    let mut f = fixture(&pool).await;
    let org = *f.principal.org_id.as_uuid();
    let run_id = Uuid::new_v4();
    let source_key = "draft-row-1";
    sqlx::query(
        "INSERT INTO data_import_runs (org_id, id, entity_type, source_filename, source_format, source_sha256, status, input_rows, candidate_rows, preserved_rows, created_by) \
         VALUES ($1, $2, 'employee_hr', 'draft.xlsx', 'xlsx', repeat('a', 64), 'PREVIEWED', 1, 1, 0, $3)",
    )
    .bind(org)
    .bind(run_id)
    .bind(f.principal.user_id.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO data_import_rows (org_id, run_id, source_sheet, source_row, source_key, row_status, raw_row, canonical_row, validation) \
         VALUES ($1, $2, 'Sheet1', 2, $3, 'CANDIDATE', '{}', '{\"name\":\"Draft\",\"canonical\":{}}', '{}')",
    )
    .bind(org)
    .bind(run_id)
    .bind(source_key)
    .execute(&pool)
    .await
    .unwrap();

    // Missing step-up rejected 401
    let (s, err) = put_draft(
        app(&f, true),
        run_id,
        source_key,
        json!({ "rrn": "900101-5000014" }),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED, "{err}");
    assert_eq!(err["error"]["code"], "step_up_required");

    // Valid step-up stages sealed identity and derives sex
    let body = draft_binding_body(
        &pool,
        &mut f,
        run_id,
        source_key,
        "900101-5000014",
        Some("DOMESTIC_RESIDENCE"),
    )
    .await;
    let (s, ok) = put_draft(app(&f, true), run_id, source_key, body).await;
    assert_eq!(s, StatusCode::OK, "{ok}");
    assert_eq!(ok["recorded"], true);
    assert_eq!(ok["id_type"], "DOMESTIC_RESIDENCE");
    assert_eq!(ok["sex_derived"], "MALE");

    let staged_type: Option<String> = sqlx::query_scalar(
        "SELECT id_type FROM data_import_row_identities WHERE org_id = $1 AND run_id = $2 AND source_key = $3",
    )
    .bind(org)
    .bind(run_id)
    .bind(source_key)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(staged_type.as_deref(), Some("DOMESTIC_RESIDENCE"));
}
