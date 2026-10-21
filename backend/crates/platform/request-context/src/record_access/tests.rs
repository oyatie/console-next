#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::*;
use console_kernel_core::{AccessScope, AccessScopeLevel, OrgId, ScopeNodeId, UserId};
use console_platform_authz::{EffectiveFeatureGrant, Role};
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use serde_json::json;
use std::collections::BTreeSet;

struct Fixture {
    owner: PgPool,
    rt: PgPool,
    org: OrgId,
    actor: UserId,
    branches: [BranchId; 2],
}
impl Fixture {
    async fn new(owner: PgPool) -> Self {
        let org = OrgId::new();
        let actor = seed_org_and_super_admin(&owner, *org.as_uuid(), "record-access").await;
        let region: Uuid = sqlx::query_scalar(
            "INSERT INTO regions (org_id,name) VALUES ($1,'region') RETURNING id",
        )
        .bind(org.as_uuid())
        .fetch_one(&owner)
        .await
        .unwrap(); // rls-arming: ok owner fixture
        let mut branches = [BranchId::new(), BranchId::new()];
        for (index, branch) in branches.iter_mut().enumerate() {
            let id = sqlx::query_scalar(
                "INSERT INTO branches (org_id,region_id,name) VALUES ($1,$2,$3) RETURNING id",
            )
            .bind(org.as_uuid())
            .bind(region)
            .bind(format!("branch-{index}"))
            .fetch_one(&owner)
            .await
            .unwrap(); // rls-arming: ok owner fixture
            *branch = BranchId::from_uuid(id);
        }
        Self {
            rt: runtime_role_pool(&owner).await,
            owner,
            org,
            actor,
            branches,
        }
    }
    fn principal(&self, role: Role, scope: BranchScope) -> Principal {
        Principal::new(self.actor, self.org, BTreeSet::from([role]), scope)
    }
    async fn member(&self, branch: Option<BranchId>) -> UserId {
        let user = seed_active_user(&self.owner, *self.org.as_uuid(), "MEMBER", "target").await;
        if let Some(branch) = branch {
            sqlx::query("INSERT INTO user_branches (org_id,user_id,branch_id) VALUES ($1,$2,$3)")
                .bind(self.org.as_uuid())
                .bind(user.as_uuid())
                .bind(branch.as_uuid())
                .execute(&self.owner)
                .await
                .unwrap(); // rls-arming: ok owner fixture
        }
        user
    }
    async fn workplace(&self, le: Uuid, branch: BranchId) {
        sqlx::query("INSERT INTO workplaces (org_id,legal_entity_id,default_branch_id,created_change_mode,created_by) VALUES ($1,$2,$3,'SETUP',$4)")
            .bind(self.org.as_uuid()).bind(le).bind(branch.as_uuid()).bind(self.actor.as_uuid())
            .execute(&self.owner).await.unwrap(); // rls-arming: ok owner fixture
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn account_reads_match_membership_scope_and_fail_closed(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let [a, b] = f.branches;
    let inside = f.member(Some(a)).await;
    let outside = f.member(Some(b)).await;
    let unassigned = f.member(None).await;
    let foreign = seed_org_and_super_admin(&f.owner, *OrgId::new().as_uuid(), "foreign").await;
    let scoped = f.principal(Role::Admin, BranchScope::Branches(BTreeSet::from([a])));
    assert!(may_read(&f.rt, &scoped, "user", &inside.to_string(), None).await);
    for target in [outside, unassigned, foreign, UserId::new()] {
        assert!(
            !may_read(
                &f.rt,
                &scoped,
                "user",
                &target.to_string(),
                Some(*a.as_uuid())
            )
            .await
        );
    }
    assert!(!may_read(&f.rt, &scoped, "user", "bad-id", None).await);
    let denied = f.principal(Role::Member, scoped.branch_scope.clone());
    assert!(!may_read(&f.rt, &denied, "user", &inside.to_string(), None).await);
    let empty = f.principal(Role::SuperAdmin, BranchScope::none());
    assert!(!may_read(&f.rt, &empty, "user", &inside.to_string(), None).await);
    let org_wide = f.principal(Role::Admin, BranchScope::All);
    assert!(may_read(&f.rt, &org_wide, "user", &unassigned.to_string(), None).await);
    assert!(!may_read(&f.rt, &org_wide, "user", &foreign.to_string(), None).await);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn account_feature_scope_is_independent_of_other_grants(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let [a, b] = f.branches;
    let inside = f.member(Some(a)).await;
    let outside = f.member(Some(b)).await;
    let unassigned = f.member(None).await;
    let limited = BranchScope::Branches(BTreeSet::from([a]));
    let scoped = f
        .principal(Role::Member, limited.clone())
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::UserManage,
            PermissionLevel::Allow,
            limited,
        )]);
    assert!(may_read(&f.rt, &scoped, "user", &inside.to_string(), None).await);
    assert!(!may_read(&f.rt, &scoped, "user", &outside.to_string(), None).await);
    assert!(!may_read(&f.rt, &scoped, "user", &unassigned.to_string(), None).await);
    let mut tenant_access = scoped.clone();
    tenant_access.effective_feature_grants[0].branch_scope = BranchScope::All;
    assert!(may_read(&f.rt, &tenant_access, "user", &outside.to_string(), None).await);
    assert!(may_read(&f.rt, &tenant_access, "user", &unassigned.to_string(), None).await);
    let mut partial = scoped;
    partial.branch_scope = BranchScope::All;
    assert!(!may_read(&f.rt, &partial, "user", &inside.to_string(), None).await);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scoped_registration_reads_use_parent_legal_entity_branches(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let le = Uuid::new_v4();
    let registration = Uuid::new_v4();
    let role = Uuid::new_v4();
    let reader = f.member(None).await;
    sqlx::query("INSERT INTO legal_entities (org_id,id,biz_kind,created_change_mode,created_by) VALUES ($1,$2,'INDIVIDUAL','SETUP',$3)")
        .bind(f.org.as_uuid()).bind(le).bind(f.actor.as_uuid()).execute(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
    sqlx::query("INSERT INTO business_registrations (org_id,id,legal_entity_id,brn_pending_reason,created_change_mode,created_by) VALUES ($1,$2,$3,'NEW_REGISTRATION_PENDING','SETUP',$4)")
        .bind(f.org.as_uuid()).bind(registration).bind(le).bind(f.actor.as_uuid()).execute(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
    f.workplace(le, f.branches[0]).await;
    sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'record reader','ACTIVE',1,$3)")
        .bind(f.org.as_uuid()).bind(role).bind(f.actor.as_uuid()).execute(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'record reader','ACTIVE','SETUP',$3)")
        .bind(f.org.as_uuid()).bind(role).bind(f.actor.as_uuid()).execute(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'org',ARRAY['view'])")
        .bind(f.org.as_uuid()).bind(role).execute(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,legal_entity_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'LEGAL_ENTITY',$4,now()-interval '1 minute',true,'SETUP','TEST',$5)")
        .bind(f.org.as_uuid()).bind(reader.as_uuid()).bind(role).bind(le).bind(f.actor.as_uuid()).execute(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
    let mut p = Principal::new(
        reader,
        f.org,
        BTreeSet::new(),
        BranchScope::Branches(BTreeSet::from([f.branches[0]])),
    )
    .with_access_scope(AccessScope::new(
        AccessScopeLevel::Branch,
        ScopeNodeId::from_uuid(*f.branches[0].as_uuid()),
    ));
    assert!(
        may_read(
            &f.rt,
            &p,
            "business_registration",
            &registration.to_string(),
            None
        )
        .await
    );
    f.workplace(le, f.branches[1]).await;
    assert!(
        !may_read(
            &f.rt,
            &p,
            "business_registration",
            &registration.to_string(),
            None
        )
        .await
    );
    p.branch_scope = BranchScope::Branches(BTreeSet::from(f.branches));
    assert!(
        may_read(
            &f.rt,
            &p,
            "business_registration",
            &registration.to_string(),
            None
        )
        .await
    );
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$2 WHERE org_id=$1 AND account_id=$3")
        .bind(f.org.as_uuid()).bind(f.actor.as_uuid()).bind(reader.as_uuid()).execute(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
    assert!(
        !may_read(
            &f.rt,
            &p,
            "business_registration",
            &registration.to_string(),
            None
        )
        .await
    );
}

fn lifecycle_result() -> Value {
    json!({"items":[{"wrapper":{"employee_id":Uuid::new_v4(),"event_type":"GROUP_TRANSFER",
        "to_status":"ACTIVE","leave_type":"ILLNESS","cancel_reason":"private reason",
        "comment":"public note","group_transfer":{"consent_evidence_ref":"private-consent",
        "succession_evidence_ref":"private-succession","continuity":"CARRIED"}}}],
        "unrelated":{"leave_type":"unchanged","cancel_reason":"unchanged",
          "group_transfer":{"consent_evidence_ref":"unchanged"}}})
}
fn person_principal(role: Role) -> Principal {
    Principal::new(
        UserId::new(),
        OrgId::new(),
        BTreeSet::from([role]),
        BranchScope::All,
    )
}
#[test]
fn lost_manage_access_masks_lifecycle_results_recursively() {
    let reader = person_principal(Role::Executive);
    assert!(authorize_org_wide(&reader, Action::new(Feature::EmployeeDirectoryRead)).is_ok());
    let mut result = lifecycle_result();
    let unrelated = result["unrelated"].clone();
    mask_result(&reader, &mut result);
    let item = &result["items"][0]["wrapper"];
    assert!(item.get("leave_type").is_none());
    assert!(item.get("cancel_reason").is_none());
    assert!(item["group_transfer"].get("consent_evidence_ref").is_none());
    assert!(
        item["group_transfer"]
            .get("succession_evidence_ref")
            .is_none()
    );
    assert_eq!(item["comment"], "public note");
    assert_eq!(item["group_transfer"]["continuity"], "CARRIED");
    assert_eq!(result["unrelated"], unrelated);
}
#[test]
fn current_manager_keeps_lifecycle_details() {
    let mut result = lifecycle_result();
    let before = result.clone();
    mask_result(&person_principal(Role::SuperAdmin), &mut result);
    assert_eq!(result, before);
}
#[test]
fn scoped_manage_grant_does_not_unmask_org_wide_history() {
    let mut manager = person_principal(Role::Member);
    manager.effective_feature_grants = vec![EffectiveFeatureGrant::new(
        Feature::EmployeeDirectoryManage,
        PermissionLevel::Allow,
        BranchScope::Branches(BTreeSet::from([BranchId::new()])),
    )];
    let mut result = lifecycle_result();
    mask_result(&manager, &mut result);
    assert!(result["items"][0]["wrapper"].get("leave_type").is_none());
}
