// SPDX-License-Identifier: LicenseRef-Proprietary
//! Verifier regressions: role edits and exits cannot bypass a pending grant.
use super::*;
use console_kernel_core::{BranchScope, FixedClock, UserId};
use console_platform_authz::Principal;
use serde_json::json;

#[sqlx::test(migrator = "MIGRATOR")]
async fn held_role_approve_elevation_is_delayed_only_after_go_live(pool: PgPool) {
    for setup in [false, true] {
        let (org, actor, target, _) = if setup {
            fixture_in_setup(&pool).await
        } else {
            fixture(&pool).await
        };
        let service = crate::AccessService::new(pool.clone(), None);
        let principal = Principal::new(
            UserId::from_uuid(actor),
            org,
            Default::default(),
            BranchScope::All,
        )
        .with_tenant_ops(true);
        let role = crate::roles::create(
            &service,
            principal.clone(),
            serde_json::from_value(json!({
                "name_ko": "조회 역할", "lines": [{"domain":"org","levels":["view"]}]
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by)
            VALUES ($1,$2,$3,'TENANT',now(),true,'SETUP','NEW_HIRE',$4)")
            .bind(org.as_uuid()).bind(target).bind(role.id).bind(actor).execute(&pool).await.unwrap();
        let error = crate::roles::update(&service, principal.clone(), role.id, serde_json::from_value(json!({
            "expected_version":1,"lines":[{"domain":"org","levels":["view","approve"]}],"reason_code":"PROMOTION_OR_REASSIGNMENT"
        })).unwrap()).await.unwrap_err();
        assert_eq!(
            error.code,
            if setup {
                "passkey_step_up_required"
            } else {
                "held_role_elevation_delayed"
            }
        );
        if !setup {
            assert_eq!(error.kind, crate::error::Refusal::Conflict);
        }
        assert_eq!(
            crate::roles::get_one(&service, principal, role.id)
                .await
                .unwrap()
                .version,
            1
        );
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn activating_a_held_elevated_draft_is_delayed_only_after_go_live(pool: PgPool) {
    for setup in [false, true] {
        let (org, actor, target, _) = if setup {
            fixture_in_setup(&pool).await
        } else {
            fixture(&pool).await
        };
        let service = crate::AccessService::new(pool.clone(), None);
        let principal = Principal::new(
            UserId::from_uuid(actor),
            org,
            Default::default(),
            BranchScope::All,
        )
        .with_tenant_ops(true);
        let role = crate::roles::create(&service, principal.clone(), serde_json::from_value(json!({
            "name_ko":"결재 초안","status":"DRAFT","lines":[{"domain":"org","levels":["approve"]}]
        })).unwrap()).await.unwrap();
        sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by)
            VALUES ($1,$2,$3,'TENANT',now(),true,'SETUP','NEW_HIRE',$4)")
            .bind(org.as_uuid()).bind(target).bind(role.id).bind(actor).execute(&pool).await.unwrap();
        let result = crate::roles::set_status(
            &service,
            principal,
            role.id,
            serde_json::from_value(json!({"expected_version":1,"status":"ACTIVE"})).unwrap(),
        )
        .await;
        if setup {
            assert_eq!(result.unwrap().status, "ACTIVE");
        } else {
            let error = result.unwrap_err();
            assert_eq!(
                (error.kind, error.code),
                (
                    crate::error::Refusal::Conflict,
                    "held_role_elevation_delayed"
                )
            );
        }
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn an_exit_ends_or_cancels_pending_grants_before_activation(pool: PgPool) {
    for starts_after_exit in [false, true] {
        let (org, actor, target, role) = fixture(&pool).await;
        let now = OffsetDateTime::now_utc();
        let ends_at = now + time::Duration::days(30);
        let employee: Uuid = sqlx::query_scalar("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key)
            VALUES ($1,'Synthetic','퇴직자','fixture','fixture',1,$2) RETURNING id")
            .bind(org.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(&pool).await.unwrap();
        sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2")
            .bind(employee)
            .bind(target)
            .execute(&pool)
            .await
            .unwrap();
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let row = GrantRow {
            id: Uuid::new_v4(),
            account_id: target,
            role_id: role,
            kind: NodeKind::Tenant,
            node_id: None,
            valid_from: if starts_after_exit { ends_at } else { now },
            valid_to: None,
            revoked: false,
            effective_in_setup: true,
        };
        insert(
            &mut tx,
            org,
            &NewGrant {
                row: &row,
                change_mode: "OPERATING",
                reason_code: "NEW_HIRE",
                reason_note: None,
                granted_by: actor,
            },
        )
        .await
        .unwrap();
        let due: OffsetDateTime = sqlx::query_scalar(
            "SELECT activates_at FROM user_role_grants_pending WHERE org_id=$1 AND grant_id=$2",
        )
        .bind(org.as_uuid())
        .bind(row.id)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
        let (exit, _) = console_platform_authz::access::revoke_privileged_access(
            &mut tx,
            org,
            employee,
            ends_at,
            UserId::from_uuid(actor),
            now,
        )
        .await
        .unwrap();
        assert_eq!(exit.grants_ended, 1);
        let activation =
            crate::pending::activate_in_tx(&mut tx, org, row.id, &FixedClock(due)).await;
        if starts_after_exit {
            assert_eq!(activation.unwrap_err().code, "grant_ended");
        } else {
            activation.unwrap();
            let end: Option<OffsetDateTime> =
                sqlx::query_scalar("SELECT valid_to FROM access_grants WHERE org_id=$1 AND id=$2")
                    .bind(org.as_uuid())
                    .bind(row.id)
                    .fetch_one(tx.as_mut())
                    .await
                    .unwrap();
            assert_eq!(end, Some(ends_at));
            assert!(
                load_access_subject(&mut tx, org, target, ends_at)
                    .await
                    .unwrap()
                    .grants
                    .is_empty()
            );
        }
        tx.commit().await.unwrap();
    }
}
