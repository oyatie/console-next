// SPDX-License-Identifier: LicenseRef-Proprietary
//! Preview and renewal reads use current tenant grants before exposing validation or facts.
use console_hr_adapter_postgres::lifecycle::requests::BulkEmployeeLifecycleEventRequest;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{Fixture, fixture, lifecycle_grant, status};

async fn replace_hr_grant(f: &Fixture, levels: &[&str]) {
    sqlx::query("UPDATE access_grants SET valid_to=now()-interval '1 second' WHERE org_id=$1 AND account_id=$2")
        .bind(f.org).bind(f.user).execute(&f.owner).await.unwrap();
    lifecycle_grant::grant_hr_basic(&f.owner, f.org, f.user, levels).await;
}

fn promotion(employee: Uuid, date: &str) -> BulkEmployeeLifecycleEventRequest {
    serde_json::from_value(json!({"event_type":"PROMOTE","employee_ids":[employee],
        "effective_date":date,"to_position":"과장","comment":"정기 인사"}))
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bulk_preview_refuses_revoked_and_scoped_grants_despite_stale_roles(pool: PgPool) {
    let f = fixture(pool, true).await;
    let employee = f.employee().await;
    let before = f.count("audit_events").await;
    sqlx::query("UPDATE access_grants SET valid_to=now()-interval '1 second' WHERE org_id=$1 AND account_id=$2")
        .bind(f.org).bind(f.user).execute(&f.owner).await.unwrap();
    for date in ["2027-03-01", "invalid"] {
        let error =
            f.hr.preview_bulk_lifecycle_events(f.ops.clone(), promotion(employee, date))
                .await
                .unwrap_err();
        assert_eq!(status(&error), (403, "forbidden"));
        assert!(error.refusals.is_none());
        assert!(error.errors.is_none());
    }
    let entity = Uuid::new_v4();
    sqlx::query("INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION')")
        .bind(f.org).bind(entity).execute(&f.owner).await.unwrap();
    sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,legal_entity_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) SELECT org_id,account_id,role_id,'LEGAL_ENTITY',$3,valid_from,effective_in_setup,change_mode,reason_code,granted_by FROM access_grants WHERE org_id=$1 AND account_id=$2")
        .bind(f.org).bind(f.user).bind(entity).execute(&f.owner).await.unwrap();
    assert_eq!(
        status(
            &f.hr
                .preview_bulk_lifecycle_events(f.ops.clone(), promotion(employee, "2027-03-01"))
                .await
                .unwrap_err()
        ),
        (403, "forbidden")
    );
    sqlx::query("UPDATE access_grants SET valid_to=CASE WHEN scope_kind='TENANT' THEN NULL ELSE now()-interval '1 second' END WHERE org_id=$1 AND account_id=$2")
        .bind(f.org).bind(f.user).execute(&f.owner).await.unwrap();
    let mut live = f.ops.clone();
    live.roles.clear();
    assert_eq!(
        f.hr.preview_bulk_lifecycle_events(live, promotion(employee, "2027-03-01"))
            .await
            .unwrap()
            .counts
            .selected,
        1
    );
    assert_eq!(f.count("employee_lifecycle_events").await, 0);
    assert_eq!(f.count("audit_events").await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn fixed_term_read_refuses_revoked_grants_before_disclosing_the_employee(pool: PgPool) {
    let f = fixture(pool, true).await;
    let employee = f.employee().await;
    let before = f.count("audit_events").await;
    sqlx::query("UPDATE access_grants SET valid_to=now()-interval '1 second' WHERE org_id=$1 AND account_id=$2")
        .bind(f.org).bind(f.user).execute(&f.owner).await.unwrap();
    for employee in [employee, Uuid::new_v4()] {
        assert_eq!(
            status(
                &f.hr
                    .employee_fixed_term(f.ops.clone(), employee)
                    .await
                    .unwrap_err()
            ),
            (403, "forbidden")
        );
    }
    sqlx::query("UPDATE access_grants SET valid_to=NULL WHERE org_id=$1 AND account_id=$2")
        .bind(f.org)
        .bind(f.user)
        .execute(&f.owner)
        .await
        .unwrap();
    let mut live = f.ops.clone();
    live.roles.clear();
    assert!(f.hr.employee_fixed_term(live, employee).await.is_ok());
    sqlx::query("UPDATE users SET is_active=false WHERE org_id=$1 AND id=$2")
        .bind(f.org)
        .bind(f.user)
        .execute(&f.owner)
        .await
        .unwrap();
    assert_eq!(
        status(
            &f.hr
                .employee_fixed_term(f.ops.clone(), employee)
                .await
                .unwrap_err()
        ),
        (403, "forbidden")
    );
    assert_eq!(f.count("audit_events").await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn renewal_options_require_live_edit_as_well_as_read_before_parsing_the_date(pool: PgPool) {
    let f = fixture(pool, true).await;
    let employee = f.employee().await;
    replace_hr_grant(&f, &["view"]).await;
    assert!(
        f.hr.employee_fixed_term(f.ops.clone(), employee)
            .await
            .is_ok()
    );
    for date in ["2027-03-01", "invalid"] {
        let error =
            f.hr.employee_fixed_term_for_renewal(f.ops.clone(), employee, Some(date.into()))
                .await
                .unwrap_err();
        assert_eq!(status(&error), (403, "forbidden"));
        assert!(error.errors.is_none());
    }
    replace_hr_grant(&f, &["edit"]).await;
    // Edit does not silently supply the distinct read decision.
    assert_eq!(
        status(
            &f.hr
                .employee_fixed_term_for_renewal(f.ops.clone(), employee, Some("2027-03-01".into()))
                .await
                .unwrap_err()
        ),
        (403, "forbidden")
    );
    replace_hr_grant(&f, &["view", "edit"]).await;
    let mut live = f.ops.clone();
    live.roles.clear();
    assert!(
        f.hr.employee_fixed_term_for_renewal(live, employee, Some("2027-03-01".into()))
            .await
            .is_ok()
    );
}
