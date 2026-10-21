#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::super::{access_tests::Fixture, may_read};
use console_kernel_core::BranchScope;
use console_platform_test_support::MIGRATOR;
use sqlx::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;

async fn evidence(f: &Fixture, untriaged: bool) -> [Uuid; 3] {
    let ticket: Uuid = sqlx::query_scalar("INSERT INTO support_tickets (org_id,branch_id,origin,category,priority,status,title,body,requester_name,requester_contact) VALUES ($1,$2,'CUSTOMER','OTHER','LOW','CLOSED','Test','Test','Customer','Contact') RETURNING id")
        .bind(f.org.as_uuid()).bind(if untriaged { None } else { Some(*f.branches[0].as_uuid()) })
        .fetch_one(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
    let acceptance: Uuid = sqlx::query_scalar("INSERT INTO support_ticket_acceptances (org_id,ticket_id,kind,channel,accepted_by,recorded_by_user_id,occurred_at,idempotency_key,request_fingerprint) VALUES ($1,$2,'CUSTOMER_ACCEPTED','PHONE','Customer',$3,now(),$4,$5) RETURNING id")
        .bind(f.org.as_uuid()).bind(ticket).bind(f.actor.as_uuid()).bind(Uuid::new_v4().to_string())
        .bind("a".repeat(64)).fetch_one(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
    let comment: Uuid = sqlx::query_scalar("INSERT INTO support_ticket_comments (org_id,ticket_id,author_user_id,body) VALUES ($1,$2,$3,'Test') RETURNING id")
        .bind(f.org.as_uuid()).bind(ticket).bind(f.actor.as_uuid())
        .fetch_one(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
    [ticket, acceptance, comment]
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn ticket_evidence_read_follows_current_tenant_and_parent_branch(pool: PgPool) {
    let f = Fixture::new(pool.clone()).await;
    let foreign = Fixture::new(pool).await;
    let ids = evidence(&f, false).await;
    let others = evidence(&foreign, false).await;
    let untriaged = evidence(&f, true).await;
    let p = f.principal(BranchScope::Branches(BTreeSet::from([f.branches[0]])));
    let outside = f.principal(BranchScope::Branches(BTreeSet::from([f.branches[1]])));
    let empty = f.principal(BranchScope::none());
    let wide = f.principal(BranchScope::All);
    for (index, kind) in [
        "support_ticket",
        "support_ticket_acceptance",
        "support_ticket_comment",
    ]
    .iter()
    .enumerate()
    {
        assert!(
            may_read(
                &f.rt,
                &p,
                kind,
                &ids[index].to_string(),
                Some(*f.branches[1].as_uuid())
            )
            .await
        );
        for denied in [&outside, &empty] {
            assert!(
                !may_read(
                    &f.rt,
                    denied,
                    kind,
                    &ids[index].to_string(),
                    Some(*f.branches[0].as_uuid())
                )
                .await
            );
        }
        for id in [
            others[index].to_string(),
            Uuid::new_v4().to_string(),
            "invalid".into(),
            untriaged[index].to_string(),
        ] {
            assert!(!may_read(&f.rt, &p, kind, &id, None).await);
        }
        assert!(may_read(&f.rt, &wide, kind, &untriaged[index].to_string(), None).await);
    }
    sqlx::query("UPDATE support_tickets SET branch_id=$3 WHERE org_id=$1 AND id=$2")
        .bind(f.org.as_uuid())
        .bind(ids[0])
        .bind(f.branches[1].as_uuid())
        .execute(&f.owner)
        .await
        .unwrap(); // rls-arming: ok owner fixture
    for (index, kind) in [
        "support_ticket",
        "support_ticket_acceptance",
        "support_ticket_comment",
    ]
    .iter()
    .enumerate()
    {
        assert!(
            !may_read(
                &f.rt,
                &p,
                kind,
                &ids[index].to_string(),
                Some(*f.branches[0].as_uuid())
            )
            .await
        );
        assert!(may_read(&f.rt, &outside, kind, &ids[index].to_string(), None).await);
    }
}
