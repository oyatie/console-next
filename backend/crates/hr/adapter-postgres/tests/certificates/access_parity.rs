// SPDX-License-Identifier: LicenseRef-Proprietary
use super::fixture::World;
use console_kernel_core::{BranchScope, UserId};
use console_platform_authz::{Principal, Role};
use sqlx::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn certificate_person_access_preserves_role_parity(pool: PgPool) {
    let w = World::new(pool).await;
    w.configure().await;
    for (role, allowed) in [
        (Role::SuperAdmin, true),
        (Role::Executive, false),
        (Role::Member, false),
    ] {
        let user = UserId::new();
        sqlx::query("INSERT INTO users(id,org_id,display_name,roles,is_tenant_ops) VALUES($1,$2,'Certificate actor',$3,false)")
            .bind(user.as_uuid()).bind(w.actor.org_id.as_uuid())
            .bind(vec![role.as_str()]).execute(&w.owner).await.unwrap();
        let p = Principal::new(
            user,
            w.actor.org_id,
            BTreeSet::from([role]),
            BranchScope::All,
        );
        let grants: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM access_grants WHERE org_id=$1 AND account_id=$2",
        )
        .bind(p.org_id.as_uuid())
        .bind(user.as_uuid())
        .fetch_one(&w.owner)
        .await
        .unwrap();
        assert_eq!(grants, 0);
        let existing = w.issue(&Uuid::new_v4().to_string()).await;
        let id = Uuid::parse_str(existing["id"].as_str().unwrap()).unwrap();
        let issued =
            w.hr.issue_certificate(p.clone(), Some(Uuid::new_v4().to_string()), w.issue_body())
                .await;
        let read = w.hr.certificate(p.clone(), id).await;
        let voided =
            w.hr.void_certificate(p, id, Some(Uuid::new_v4().to_string()), World::reason())
                .await;
        for (action, result) in [
            ("issue", issued.map(|_| ())),
            ("read", read.map(|_| ())),
            ("void", voided.map(|_| ())),
        ] {
            assert_eq!(result.is_ok(), allowed, "{role:?} {action}: {result:?}");
            if let Err(error) = result {
                assert_eq!(error.status, http::StatusCode::FORBIDDEN);
                assert_eq!(error.code, "certificate_forbidden");
            }
        }
    }
}
