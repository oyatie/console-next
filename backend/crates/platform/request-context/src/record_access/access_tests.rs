#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::{all_readable, may_read};
use console_kernel_core::{BranchId, BranchScope, OrgId, UserId};
use console_platform_authz::access::{
    AccessSlice, Domain, Level, NodeKind, action_group, load_access_subject, scope_path,
};
use console_platform_authz::{EffectiveFeatureGrant, Feature, PermissionLevel, Principal, Role};
use console_platform_db::{DbError, with_org_conn};
use console_platform_test_support::{
    MIGRATOR, runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;

pub(super) struct Fixture {
    pub(super) owner: PgPool,
    pub(super) rt: PgPool,
    pub(super) org: OrgId,
    pub(super) actor: UserId,
    pub(super) reader: UserId,
    pub(super) target: UserId,
    pub(super) branches: [BranchId; 2],
    pub(super) entities: [Uuid; 2],
}
impl Fixture {
    pub(super) async fn new(owner: PgPool) -> Self {
        let org = OrgId::new();
        let actor = seed_org_and_super_admin(&owner, *org.as_uuid(), "outcome-records").await;
        let reader = seed_active_user(&owner, *org.as_uuid(), "MEMBER", "reader").await;
        let target = seed_active_user(&owner, *org.as_uuid(), "MEMBER", "target").await;
        let region: Uuid = sqlx::query_scalar(
            "INSERT INTO regions (org_id,name) VALUES ($1,'region') RETURNING id",
        )
        .bind(org.as_uuid())
        .fetch_one(&owner)
        .await
        .unwrap(); // rls-arming: ok owner fixture
        let branches = [BranchId::new(), BranchId::new()];
        let entities = [Uuid::new_v4(), Uuid::new_v4()];
        for (index, (branch, entity)) in branches.iter().zip(entities).enumerate() {
            sqlx::query("INSERT INTO branches (org_id,id,region_id,name) VALUES ($1,$2,$3,$4)")
                .bind(org.as_uuid())
                .bind(branch.as_uuid())
                .bind(region)
                .bind(format!("branch-{index}"))
                .execute(&owner)
                .await
                .unwrap(); // rls-arming: ok owner fixture
            sqlx::query("INSERT INTO legal_entities (org_id,id,biz_kind,created_change_mode,created_by) VALUES ($1,$2,'INDIVIDUAL','SETUP',$3)")
                .bind(org.as_uuid()).bind(entity).bind(actor.as_uuid()).execute(&owner).await.unwrap(); // rls-arming: ok owner fixture
            sqlx::query("INSERT INTO workplaces (org_id,legal_entity_id,default_branch_id,created_change_mode,created_by) VALUES ($1,$2,$3,'SETUP',$4)")
                .bind(org.as_uuid()).bind(entity).bind(branch.as_uuid()).bind(actor.as_uuid())
                .execute(&owner).await.unwrap(); // rls-arming: ok owner fixture
        }
        Self {
            rt: runtime_role_pool(&owner).await,
            owner,
            org,
            actor,
            reader,
            target,
            branches,
            entities,
        }
    }
    pub(super) fn principal(&self, scope: BranchScope) -> Principal {
        Principal::new(self.reader, self.org, BTreeSet::from([Role::Member]), scope)
    }
    pub(super) async fn role(&self) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'view-only outcome reader','ACTIVE',1,$3)")
            .bind(self.org.as_uuid()).bind(id).bind(self.actor.as_uuid()).execute(&self.owner).await.unwrap(); // rls-arming: ok owner fixture
        sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'view-only outcome reader','ACTIVE','SETUP',$3)")
            .bind(self.org.as_uuid()).bind(id).bind(self.actor.as_uuid()).execute(&self.owner).await.unwrap(); // rls-arming: ok owner fixture
        sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'access',ARRAY['view'])")
            .bind(self.org.as_uuid()).bind(id).execute(&self.owner).await.unwrap(); // rls-arming: ok owner fixture
        id
    }
    pub(super) async fn grant(&self, role: Uuid, account: UserId, entity: Option<Uuid>) -> Uuid {
        sqlx::query_scalar("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,legal_entity_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by)
            VALUES ($1,$2,$3,$4,$5,now()-interval '1 minute',true,'SETUP','TEST',$6) RETURNING id")
            .bind(self.org.as_uuid()).bind(account.as_uuid()).bind(role)
            .bind(if entity.is_some() { "LEGAL_ENTITY" } else { "TENANT" }).bind(entity).bind(self.actor.as_uuid())
            .fetch_one(&self.owner).await.unwrap() // rls-arming: ok owner fixture
    }
    async fn list_authority(&self, p: &Principal, entity: Uuid) -> bool {
        let org = p.org_id;
        let actor = *p.user_id.as_uuid();
        with_org_conn::<_, _, DbError>(&self.rt, org, move |tx| {
            Box::pin(async move {
                let subject = load_access_subject(tx, org, actor, time::OffsetDateTime::now_utc())
                    .await
                    .map_err(|e| DbError::Sqlx(sqlx::Error::Protocol(e.to_string())))?;
                let path = scope_path(org, NodeKind::LegalEntity, Some(entity), Some(entity));
                Ok(AccessSlice::compile(&subject)
                    .unwrap()
                    .allows(&action_group(Domain::Access, Level::View), &path)
                    .unwrap())
            })
        })
        .await
        .unwrap()
    }
    pub(super) async fn employee(&self, branch: BranchId) -> Uuid {
        let id = Uuid::new_v4();
        let mut tx = self.owner.begin().await.unwrap();
        sqlx::query("SET LOCAL ROLE console_leave_cmd")
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("SELECT * FROM leave_api.create_employee($1,$2,$3,'employee','company','REGULAR','+821012345678','Operations','Member','Seoul',$4,0::numeric,$5,$6,$7,$8,$9)")
            .bind(self.org.as_uuid()).bind(id).bind(format!("OUTCOME-{id}"))
            .bind(branch.as_uuid()).bind(format!("outcome-employee-{id}"))
            .bind("a".repeat(64)).bind(self.actor.as_uuid())
            .bind("0123456789abcdef0123456789abcdef").bind("0123456789abcdef")
            .fetch_one(tx.as_mut()).await.unwrap();
        tx.commit().await.unwrap();
        id
    }
}
fn touched(kind: &str, id: Uuid) -> Value {
    json!({"type":kind,"id":id,"audit_id":Uuid::new_v4(),"branch_id":null})
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn tenant_access_view_grant_reader_sees_grant_refs_but_unknown_grant_is_denied(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let role = f.role().await;
    f.grant(role, f.reader, None).await;
    let p = f.principal(BranchScope::All);
    assert!(
        p.effective_feature_grants.is_empty(),
        "view is not a legacy RoleManage edit grant"
    );
    let first = f.grant(role, f.target, Some(f.entities[0])).await;
    let second = f.grant(role, f.target, Some(f.entities[1])).await;
    for entity in f.entities {
        assert!(
            f.list_authority(&p, entity).await,
            "grant list allows access view"
        );
    }
    assert!(
        all_readable(
            &f.rt,
            &p,
            &json!([
                touched("access_grant", first),
                touched("access_grant", second)
            ])
        )
        .await
    );
    assert!(!may_read(&f.rt, &p, "access_grant", &Uuid::new_v4().to_string(), None).await);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn scoped_access_view_grant_reader_sees_only_the_granted_node(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let role = f.role().await;
    f.grant(role, f.reader, Some(f.entities[0])).await;
    let inside = f.grant(role, f.target, Some(f.entities[0])).await;
    let outside = f.grant(role, f.target, Some(f.entities[1])).await;
    let tenant = f.grant(role, f.target, None).await;
    let p = f.principal(BranchScope::Branches(BTreeSet::from([f.branches[0]])));
    assert!(f.list_authority(&p, f.entities[0]).await);
    assert!(!f.list_authority(&p, f.entities[1]).await);
    assert!(may_read(&f.rt, &p, "access_grant", &inside.to_string(), None).await);
    for id in [outside, tenant, Uuid::new_v4()] {
        assert!(!may_read(&f.rt, &p, "access_grant", &id.to_string(), None).await);
    }
    assert!(
        !all_readable(
            &f.rt,
            &p,
            &json!([
                touched("access_grant", inside),
                touched("access_grant", outside)
            ])
        )
        .await
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn lifecycle_batch_summary_with_readable_concrete_children_keeps_outcome_readable(
    pool: PgPool,
) {
    let f = Fixture::new(pool).await;
    let first = f.employee(f.branches[0]).await;
    let second = f.employee(f.branches[0]).await;
    let scope = BranchScope::Branches(BTreeSet::from([f.branches[0]]));
    let p = f
        .principal(scope.clone())
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::EmployeeDirectoryRead,
            PermissionLevel::Allow,
            scope,
        )]);
    assert!(may_read(&f.rt, &p, "employee", &first.to_string(), None).await);
    assert!(may_read(&f.rt, &p, "employee", &second.to_string(), None).await);
    let aggregate = touched("employee_lifecycle_batch", Uuid::new_v4());
    let child_a = touched("employee", first);
    let child_b = touched("employee", second);
    for refs in [
        json!([aggregate.clone(), child_a.clone(), child_b.clone()]),
        json!([child_a, child_b, aggregate]),
    ] {
        assert!(
            all_readable(&f.rt, &p, &refs).await,
            "summary cannot hide authorized concrete children"
        );
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn lifecycle_batch_summary_alone_or_an_unreadable_child_fails_closed(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let inside = f.employee(f.branches[0]).await;
    let outside = f.employee(f.branches[1]).await;
    let scope = BranchScope::Branches(BTreeSet::from([f.branches[0]]));
    let p = f
        .principal(scope.clone())
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::EmployeeDirectoryRead,
            PermissionLevel::Allow,
            scope,
        )]);
    let aggregate = touched("employee_lifecycle_batch", Uuid::new_v4());
    assert!(may_read(&f.rt, &p, "employee", &inside.to_string(), None).await);
    assert!(!may_read(&f.rt, &p, "employee", &outside.to_string(), None).await);
    assert!(!all_readable(&f.rt, &p, &json!([aggregate.clone()])).await);
    assert!(
        !all_readable(
            &f.rt,
            &p,
            &json!([
                touched("employee", inside),
                aggregate,
                touched("employee", outside)
            ])
        )
        .await
    );
}
