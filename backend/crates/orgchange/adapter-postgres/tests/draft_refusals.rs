// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]
use console_kernel_core::{ErrorKind, OrgId};
use console_orgchange_adapter_postgres::{
    CreateOrgChange, DraftPatch, PgOrgChangeError, PgOrgChangeStore,
};
use console_orgchange_domain::{
    OrgChangeKind, OrgChangeTarget, OrgProposalOp, OrgUnitKind, TargetKind,
};
use console_platform_request_context::scope_org;
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn create_admission_refuses_before_any_business_or_audit_write(pool: PgPool) {
    let org = OrgId::new();
    seed_org_and_super_admin(&pool, *org.as_uuid(), "draft-refusal").await;
    let member = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "drafter").await;
    let store = PgOrgChangeStore::new(runtime_role_pool(&pool).await);
    let before = snapshot(&pool).await;
    for (kind, target_ref, error_kind) in [
        (
            TargetKind::OrgUnit,
            "not-a-uuid".to_owned(),
            ErrorKind::Validation,
        ),
        (
            TargetKind::Region,
            Uuid::new_v4().to_string(),
            ErrorKind::Forbidden,
        ),
    ] {
        let command = CreateOrgChange {
            kind: OrgChangeKind::New,
            target: OrgChangeTarget {
                kind,
                target_ref,
                label: "조직".into(),
            },
            effective_date: time::OffsetDateTime::now_utc().date() + time::Duration::days(1),
            reason: "기안 거절 검증".into(),
            proposal: vec![OrgProposalOp::DeactivateRegion {
                region_id: Uuid::new_v4(),
            }],
            supersedes_id: None,
            idempotency_key: Uuid::new_v4().to_string(),
            fingerprint_input: json!({}),
        };
        let error = scope_org(org, store.create(member, command))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), error_kind);
        if error_kind == ErrorKind::Forbidden {
            assert!(
                matches!(error, PgOrgChangeError::Domain(e) if e.code == Some("org_change.refuse.missing_grant"))
            );
        }
        assert_eq!(snapshot(&pool).await, before);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scoped_admin_cannot_draft_a_change_that_touches_another_unit(pool: PgPool) {
    let org = OrgId::new();
    let maker = seed_org_and_super_admin(&pool, *org.as_uuid(), "proposal-scope").await;
    let actor = seed_active_user(&pool, *org.as_uuid(), "ADMIN", "scoped-drafter").await;
    let entity = Uuid::new_v4();
    let workplace = Uuid::new_v4();
    sqlx::query("INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION')")
        .bind(org.as_uuid()).bind(entity).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO workplaces (org_id,id,legal_entity_id,needs_confirmation,created_change_mode) VALUES ($1,$2,$3,true,'MIGRATION')")
        .bind(org.as_uuid()).bind(workplace).bind(entity).execute(&pool).await.unwrap();
    let inside = seed_unit(&pool, org, maker, entity, workplace, "범위 안").await;
    let outside = seed_unit(&pool, org, maker, entity, workplace, "범위 밖").await;
    let store = PgOrgChangeStore::new(runtime_role_pool(&pool).await);
    let ungranted_before = snapshot(&pool).await;
    assert_scope_refusal(
        scope_org(
            org,
            store.create(
                actor,
                change(
                    inside,
                    vec![OrgProposalOp::RenameOrgUnit {
                        org_unit_id: inside,
                        name: "범위 안 변경".into(),
                    }],
                ),
            ),
        )
        .await,
    );
    assert_eq!(snapshot(&pool).await, ungranted_before);
    grant_org_edit(&pool, org, maker, actor, Some(inside)).await;
    let editable = scope_org(org, store.list_org_units(Some(actor)))
        .await
        .unwrap();
    assert!(editable.draftable_ids.contains(&inside));
    assert!(!editable.draftable_ids.contains(&outside));
    assert!(!editable.draftable_ids.contains(org.as_uuid()));
    let owner_editable = scope_org(org, store.list_org_units(Some(maker)))
        .await
        .unwrap();
    assert!(owner_editable.draftable_ids.contains(&inside));
    assert!(owner_editable.draftable_ids.contains(&outside));
    let before = snapshot(&pool).await;
    let cases = [
        vec![
            OrgProposalOp::RenameOrgUnit {
                org_unit_id: inside,
                name: "범위 안 변경".into(),
            },
            OrgProposalOp::RenameOrgUnit {
                org_unit_id: outside,
                name: "범위 밖 변경".into(),
            },
        ],
        vec![OrgProposalOp::CreateOrgUnit {
            kind: OrgUnitKind::Department,
            parent_id: Some(outside),
            name: "새 부서".into(),
        }],
        vec![OrgProposalOp::MoveOrgUnit {
            org_unit_id: inside,
            parent_id: outside,
        }],
        vec![OrgProposalOp::MoveOrgUnit {
            org_unit_id: outside,
            parent_id: inside,
        }],
        vec![OrgProposalOp::DissolveOrgUnit {
            org_unit_id: outside,
            merged_into: None,
        }],
        vec![OrgProposalOp::DissolveOrgUnit {
            org_unit_id: inside,
            merged_into: Some(outside),
        }],
        vec![OrgProposalOp::ReassignOrgUnit {
            from_org_unit: inside.to_string(),
            to_org_unit: outside.to_string(),
            scope: console_orgchange_domain::ReassignScope {
                company: "회사".into(),
            },
            employee_ids: None,
        }],
        vec![OrgProposalOp::ReassignOrgUnit {
            from_org_unit: outside.to_string(),
            to_org_unit: inside.to_string(),
            scope: console_orgchange_domain::ReassignScope {
                company: "회사".into(),
            },
            employee_ids: None,
        }],
    ];
    for proposal in cases {
        assert_scope_refusal(scope_org(org, store.create(actor, change(inside, proposal))).await);
        assert_eq!(snapshot(&pool).await, before);
    }

    let (stored, _) = scope_org(
        org,
        store.create(
            actor,
            change(
                inside,
                vec![OrgProposalOp::RenameOrgUnit {
                    org_unit_id: inside,
                    name: "범위 안 변경".into(),
                }],
            ),
        ),
    )
    .await
    .unwrap();
    let draft_before = scope_org(org, store.get(stored.summary.id)).await.unwrap();
    let counts_before = snapshot(&pool).await;
    assert_scope_refusal(
        scope_org(
            org,
            store.update_draft(
                actor,
                stored.summary.id,
                DraftPatch {
                    proposal: Some(vec![OrgProposalOp::RenameOrgUnit {
                        org_unit_id: outside,
                        name: "범위 밖 변경".into(),
                    }]),
                    ..DraftPatch::default()
                },
            ),
        )
        .await,
    );
    assert_eq!(snapshot(&pool).await, counts_before);
    assert_eq!(
        serde_json::to_value(scope_org(org, store.get(stored.summary.id)).await.unwrap()).unwrap(),
        serde_json::to_value(draft_before).unwrap()
    );
    sqlx::query("UPDATE org_change_requests SET proposal=$2 WHERE id=$1")
        .bind(stored.summary.id)
        .bind(json!([{"op":"RENAME_ORG_UNIT","orgUnitId":outside,"name":"범위 밖 변경"}]))
        .execute(&pool)
        .await
        .unwrap();
    let stored_before = snapshot(&pool).await;
    assert_scope_refusal(
        scope_org(
            org,
            store.update_draft(
                actor,
                stored.summary.id,
                DraftPatch {
                    reason: Some("수정 시도".into()),
                    ..DraftPatch::default()
                },
            ),
        )
        .await,
    );
    assert_eq!(snapshot(&pool).await, stored_before);
    assert_scope_refusal(scope_org(org, store.preflight(actor, stored.summary.id)).await);
    assert_eq!(snapshot(&pool).await, stored_before);
    assert_scope_refusal(scope_org(org, store.submit(actor, stored.summary.id)).await);
    assert_eq!(snapshot(&pool).await, stored_before);
    grant_org_edit(&pool, org, maker, actor, None).await;
    let tenant_editable = scope_org(org, store.list_org_units(Some(actor)))
        .await
        .unwrap();
    assert!(tenant_editable.draftable_ids.contains(org.as_uuid()));
    assert!(tenant_editable.draftable_ids.contains(&outside));
}

fn change(anchor: Uuid, proposal: Vec<OrgProposalOp>) -> CreateOrgChange {
    CreateOrgChange {
        kind: OrgChangeKind::Reorg,
        target: OrgChangeTarget {
            kind: TargetKind::OrgUnit,
            target_ref: anchor.to_string(),
            label: "범위 안".into(),
        },
        effective_date: time::OffsetDateTime::now_utc().date() + time::Duration::days(1),
        reason: "조직 범위 검증".into(),
        proposal,
        supersedes_id: None,
        idempotency_key: Uuid::new_v4().to_string(),
        fingerprint_input: json!({}),
    }
}

fn assert_scope_refusal<T>(result: Result<T, PgOrgChangeError>) {
    let error = result.err().expect("out-of-scope proposal must be refused");
    assert!(
        matches!(error, PgOrgChangeError::Domain(e) if matches!(e.kind, ErrorKind::Forbidden | ErrorKind::NotFound) && e.code == Some("org_change.refuse.missing_grant"))
    );
}

async fn seed_unit(
    pool: &PgPool,
    org: OrgId,
    maker: console_kernel_core::UserId,
    entity: Uuid,
    workplace: Uuid,
    name: &str,
) -> Uuid {
    let unit: Uuid = sqlx::query_scalar("INSERT INTO org_units (org_id) VALUES ($1) RETURNING id")
        .bind(org.as_uuid())
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES ($1,$2,1,$3,$4,$5,$6,'{}')")
        .bind(org.as_uuid()).bind(unit).bind(Uuid::new_v4()).bind(maker.as_uuid())
        .bind(vec![0_u8; 32]).bind(json!({ "name": name, "kind": "department", "status": "active" }))
        .execute(pool).await.unwrap();
    sqlx::query("INSERT INTO org_unit_placements (org_id,org_unit_id,legal_entity_id,workplace_id,valid_from,change_mode,command_id) VALUES ($1,$2,$3,$4,'2026-01-01','MIGRATION',$5)")
        .bind(org.as_uuid()).bind(unit).bind(entity).bind(workplace).bind(Uuid::new_v4())
        .execute(pool).await.unwrap();
    unit
}

async fn grant_org_edit(
    pool: &PgPool,
    org: OrgId,
    maker: console_kernel_core::UserId,
    actor: console_kernel_core::UserId,
    unit: Option<Uuid>,
) {
    let role = Uuid::new_v4();
    let name = format!("조직 편집 {role}");
    sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,$4,'ACTIVE',1,$3)")
        .bind(org.as_uuid()).bind(role).bind(maker.as_uuid()).bind(&name).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,$4,'ACTIVE','SETUP',$3)")
        .bind(org.as_uuid()).bind(role).bind(maker.as_uuid()).bind(&name).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'org',ARRAY['edit'])")
        .bind(org.as_uuid()).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,org_unit_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,$6,$4,now()-interval '1 day',true,'SETUP','TEST',$5)")
        .bind(org.as_uuid()).bind(actor.as_uuid()).bind(role).bind(unit).bind(maker.as_uuid())
        .bind(if unit.is_some() { "DEPARTMENT" } else { "TENANT" })
        .execute(pool).await.unwrap();
}

async fn snapshot(pool: &PgPool) -> serde_json::Value {
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT count(*) FROM org_change_requests),(SELECT count(*) FROM org_change_approval_steps),(SELECT count(*) FROM org_change_events),(SELECT count(*) FROM audit_events))")
        .fetch_one(pool).await.unwrap()
}
