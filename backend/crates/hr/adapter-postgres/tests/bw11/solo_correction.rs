// SPDX-License-Identifier: LicenseRef-Proprietary
//! The original recorder's governed solo correction, using real passkeys.

use console_hr_adapter_postgres::lifecycle::correct::{
    CorrectLifecycleEventRequest, lifecycle_correction_binding,
};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope};
use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{Fixture, fixture};

#[path = "../../../../identity/adapter-postgres/tests/second_person_support/mod.rs"]
mod second_person_support;

fn body(date: &str) -> CorrectLifecycleEventRequest {
    serde_json::from_value(json!({
        "replacement": {
            "event_type": "LEAVE_OF_ABSENCE", "leave_type": "PERSONAL",
            "effective_date": "2026-09-01", "expected_return_date": date,
            "comment": "정정"
        },
        "reason_code": "INPUT_ERROR"
    }))
    .unwrap()
}

async fn original(f: &Fixture) -> Uuid {
    let recorded = f
        .record(serde_json::from_value(body("2026-12-01").replacement).unwrap())
        .await
        .unwrap();
    recorded["id"].as_str().unwrap().parse().unwrap()
}

async fn solo(pool: PgPool) -> Fixture {
    let mut f = fixture(pool).await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(f.principal.user_id.as_uuid())
        .execute(&f.owner)
        .await
        .unwrap();
    f.principal = f.principal.with_tenant_ops(true);
    f
}

async fn sign(
    f: &Fixture,
    key: &mut SoftKey,
    binding: MobilePasskeyStepUpBinding,
) -> MobilePasskeyStepUpEnvelope {
    let start = passkey_service()
        .start_mobile_step_up(&f.owner, *f.principal.user_id.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{ "type": "public-key", "id": key.credential_id() }]);
    serde_json::from_value(json!({
        "binding": binding,
        "assertion": {"ceremony_id": start.ceremony_id, "credential": key.assert(&challenge).unwrap()}
    })).unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn solo_correction_requires_the_bound_assertion_and_leaves_review_evidence(pool: PgPool) {
    let f = solo(pool).await;
    let event = original(&f).await;
    let passkeys = passkey_service();
    let err =
        f.hr.correct_lifecycle_event(
            f.principal.clone(),
            f.employee,
            event,
            body("2026-12-15"),
            Some(&passkeys),
        )
        .await
        .unwrap_err();
    assert_eq!((err.status.as_u16(), err.code), (401, "step_up_required"));
    let mut key = SoftKey::enroll(&f.owner, f.principal.org_id, f.principal.user_id).await;
    let mut request = body("2026-12-15");
    request.step_up = Some(
        sign(
            &f,
            &mut key,
            lifecycle_correction_binding(f.employee, event, &body("2026-12-16")),
        )
        .await,
    );
    let err =
        f.hr.correct_lifecycle_event(
            f.principal.clone(),
            f.employee,
            event,
            request,
            Some(&passkeys),
        )
        .await
        .unwrap_err();
    assert_eq!((err.status.as_u16(), err.code), (401, "step_up_failed"));
    assert_eq!(
        f.version().await,
        1,
        "refusals must not restore or void the original"
    );

    let mut request = body("2026-12-15");
    let assertion = sign(
        &f,
        &mut key,
        lifecycle_correction_binding(f.employee, event, &request),
    )
    .await;
    let assertion = json!({"binding": assertion.binding, "assertion": {
        "ceremony_id": assertion.assertion.ceremony_id,
        "credential": assertion.assertion.credential,
    }});
    request.step_up = Some(serde_json::from_value(assertion.clone()).unwrap());
    let err =
        f.hr.correct_lifecycle_event(f.principal.clone(), f.employee, event, request, None)
            .await
            .unwrap_err();
    assert_eq!(
        (err.status.as_u16(), err.code),
        (503, "step_up_unavailable")
    );
    let mut request = body("2026-12-15");
    request.step_up = Some(serde_json::from_value(assertion).unwrap());
    let fixed =
        f.hr.correct_lifecycle_event(
            f.principal.clone(),
            f.employee,
            event,
            request,
            Some(&passkeys),
        )
        .await
        .unwrap();
    assert_eq!(fixed.expected_return_date.as_deref(), Some("2026-12-15"));
    assert_eq!(fixed.voids_event_id, Some(event));
    let after: Value = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='employee.lifecycle.correct'")
        .bind(f.principal.org_id.as_uuid()).fetch_one(&f.owner).await.unwrap();
    assert_eq!(after["review_required"], true);
    assert!(after["step_up_assertion_id"].as_str().is_some());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn another_holder_prevents_the_recorders_solo_correction(pool: PgPool) {
    let f = solo(pool).await;
    let event = original(&f).await;
    let other = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id,org_id,display_name,roles) VALUES ($1,$2,'다른 담당자','{}')",
    )
    .bind(other)
    .bind(f.principal.org_id.as_uuid())
    .execute(&f.owner)
    .await
    .unwrap();
    second_person_support::access::grant(
        &f.owner,
        *f.principal.org_id.as_uuid(),
        *f.principal.user_id.as_uuid(),
        other,
        second_person_support::access::Grant {
            domain: "hr_basic",
            level: "edit",
            ..second_person_support::access::CLOSE
        },
    )
    .await;
    let err =
        f.hr.correct_lifecycle_event(
            f.principal.clone(),
            f.employee,
            event,
            body("2026-12-15"),
            Some(&passkey_service()),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (err.status.as_u16(), err.code),
        (403, "second_person_required")
    );
    assert_eq!(f.version().await, 1);
    // A holder cannot check an HR act on their own employee record.
    sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2")
        .bind(f.employee)
        .bind(other)
        .execute(&f.owner)
        .await
        .unwrap();
    let err =
        f.hr.correct_lifecycle_event(
            f.principal.clone(),
            f.employee,
            event,
            body("2026-12-15"),
            Some(&passkey_service()),
        )
        .await
        .unwrap_err();
    assert_eq!((err.status.as_u16(), err.code), (401, "step_up_required"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn refuse_mode_keeps_a_solo_correction_closed(pool: PgPool) {
    let f = solo(pool).await;
    let event = original(&f).await;
    let effective_from: time::OffsetDateTime = sqlx::query_scalar("INSERT INTO tenant_setting_overrides (org_id,key,value,set_by,reason_code) VALUES ($1,'authz.sole_holder.mode','\"refuse\"',$2,'F8') RETURNING effective_from")
        .bind(f.principal.org_id.as_uuid()).bind(f.principal.user_id.as_uuid()).fetch_one(&f.owner).await.unwrap();
    while time::OffsetDateTime::now_utc() < effective_from {
        tokio::task::yield_now().await;
    }
    let err =
        f.hr.correct_lifecycle_event(
            f.principal.clone(),
            f.employee,
            event,
            body("2026-12-15"),
            Some(&passkey_service()),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (err.status.as_u16(), err.code),
        (403, "second_person_required")
    );
    assert_eq!(f.version().await, 1);
}
