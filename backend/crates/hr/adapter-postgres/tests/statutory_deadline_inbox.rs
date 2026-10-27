// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;
#[path = "statutory/world.rs"]
mod world;

use console_hr_adapter_postgres::statutory::{FilingQuery, FilingTask};
use console_kernel_core::{BranchScope, OrgId};
use console_platform_authz::{
    Feature, Principal, Role,
    access::{NodeKind, ScopeGrant},
};
use sqlx::PgPool;
use std::collections::{BTreeMap, BTreeSet};
use support::{principal, tenant, user};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;
use world::{complete, inbox_position as position, register_rules, world};

fn query(limit: usize) -> FilingQuery {
    FilingQuery {
        state: Some("PENDING".into()),
        limit: Some(limit),
        ..FilingQuery::default()
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rule_deadlines_rank_before_creation_and_small_keyset_pages_preserve_every_task(
    pool: PgPool,
) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let rules = register_rules(&pool).await;
    let older = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    // The older-created hire has a later statutory deadline than the fixture's September 1 hire.
    sqlx::query("INSERT INTO employee_lifecycle_events(org_id,id,employee_id,event_type,to_status,effective_date,comment,created_by,state,created_at) VALUES ($1,$2,$3,'ONBOARD','ACTIVE','2026-09-20','later legal deadline',$4,'APPLIED',$5)")
        .bind(w.tenant.org).bind(older).bind(w.employee).bind(w.user.as_uuid())
        .bind(OffsetDateTime::now_utc()-Duration::hours(1)).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let as_of = OffsetDateTime::now_utc();
    let ordinary = w
        .tenant
        .hr
        .insurance_filings(p.clone(), query(200), rules.clone())
        .await
        .unwrap();
    assert_eq!(ordinary.total, 8);
    assert_eq!(ordinary.pending, 8);
    assert_eq!(
        ordinary
            .items
            .iter()
            .min_by_key(|item| item.created_at)
            .unwrap()
            .event_id,
        older
    );
    let mut expected = ordinary.items.iter().collect::<Vec<_>>();
    expected.sort_by_key(|item| {
        (
            item.due_date.is_none(),
            item.due_date.clone(),
            item.created_at,
            item.inbox_id(),
        )
    });
    assert_eq!(
        expected[0].event_id, w.event,
        "the newer-created, earlier-due hire must be on page one"
    );
    let expected_ids = expected
        .iter()
        .map(|item| item.inbox_id())
        .collect::<Vec<_>>();
    let (canonical, _) = w
        .tenant
        .hr
        .insurance_inbox_page(p.clone(), query(3), rules.clone(), None)
        .await
        .unwrap();
    assert_eq!(
        canonical
            .items
            .iter()
            .map(FilingTask::inbox_id)
            .collect::<Vec<_>>(),
        expected_ids[..3],
        "the statutory boundary and AGE60 suites must exercise the production deadline read"
    );
    let expected_projection = ordinary
        .items
        .iter()
        .map(|item| (item.inbox_id(), serde_json::to_value(item).unwrap()))
        .collect::<BTreeMap<_, _>>();
    let mut actual_projection = BTreeMap::new();
    let mut group_counts = BTreeMap::new();
    let mut actual_ids = Vec::new();
    let mut after = None;
    loop {
        let (page, exact) = w
            .tenant
            .hr
            .insurance_inbox_page(
                p.clone(),
                FilingQuery {
                    inbox_as_of: Some(as_of),
                    ..query(3)
                },
                rules.clone(),
                after.clone(),
            )
            .await
            .unwrap();
        assert!(exact);
        assert_eq!(
            page.total, ordinary.total,
            "the cursor must not reduce the source count"
        );
        assert_eq!(page.pending, ordinary.pending);
        assert!(!page.items.is_empty());
        assert!(page.items.len() <= 3);
        let next = position(page.items.last().unwrap());
        assert_ne!(after.as_ref(), Some(&next));
        for item in page.items {
            let id = item.inbox_id();
            assert!(
                actual_projection
                    .insert(id.clone(), serde_json::to_value(&item).unwrap())
                    .is_none(),
                "a keyset page must never repeat a task"
            );
            *group_counts
                .entry((item.event_id, item.kind.clone()))
                .or_insert(0) += 1;
            actual_ids.push(id);
        }
        assert!(actual_ids.len() <= expected_ids.len());
        if page.next.is_none() {
            break;
        }
        after = Some(next);
    }
    assert_eq!(actual_ids, expected_ids);
    assert_eq!(
        actual_projection, expected_projection,
        "ranking must preserve the canonical filing/group projection"
    );
    assert_eq!(
        group_counts,
        BTreeMap::from([
            ((w.event, "ACQUIRE".into()), 4),
            ((older, "ACQUIRE".into()), 4)
        ])
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn completed_receipts_and_covered_accident_tasks_leave_the_ranked_inbox(pool: PgPool) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let rules = register_rules(&pool).await;
    w.tenant
        .hr
        .record_insurance_filing(
            p.clone(),
            (w.event, "ACQUIRE".into(), "EI".into()),
            "deadline-ei-receipt".into(),
            complete(0),
            rules.clone(),
        )
        .await
        .unwrap();
    let ordinary = w
        .tenant
        .hr
        .insurance_filings(p.clone(), query(200), rules.clone())
        .await
        .unwrap();
    let (ranked, exact) = w
        .tenant
        .hr
        .insurance_inbox_page(p, query(200), rules, None)
        .await
        .unwrap();
    assert!(exact);
    assert_eq!(ordinary.pending, 2);
    assert_eq!(ranked.total, ordinary.pending);
    assert_eq!(ranked.pending, ordinary.pending);
    assert!(ranked.next.is_none());
    assert_eq!(ranked.items.len(), 2);
    assert!(ranked.items.iter().all(|item| item.event_id == w.event
        && !item.resolved()
        && !["EI", "IACI"].contains(&item.insurer.as_str())));
    assert_eq!(
        ranked
            .items
            .iter()
            .map(FilingTask::inbox_id)
            .collect::<BTreeSet<_>>(),
        ordinary.items.iter().map(FilingTask::inbox_id).collect()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn deadline_projection_enforces_grants_tenant_and_workplace_reach(pool: PgPool) {
    let w = world(&pool).await;
    let rules = register_rules(&pool).await;
    let denied = Principal::new(
        w.user,
        OrgId::from_uuid(w.tenant.org),
        BTreeSet::new(),
        BranchScope::All,
    );
    let Err(refused) = w
        .tenant
        .hr
        .insurance_inbox_page(denied, query(1), rules.clone(), None)
        .await
    else {
        panic!("a missing statutory grant must be refused");
    };
    assert_eq!((refused.status.as_u16(), refused.code), (403, "forbidden"));
    let scoped = |site| {
        Principal::new(
            w.user,
            OrgId::from_uuid(w.tenant.org),
            BTreeSet::from([Role::Member]),
            BranchScope::All,
        )
        .with_scope_grants(vec![ScopeGrant {
            feature: Feature::EmployeeDirectoryManage,
            kind: NodeKind::Workplace,
            id: site,
        }])
    };
    let (allowed, exact) = w
        .tenant
        .hr
        .insurance_inbox_page(scoped(w.site), query(200), rules.clone(), None)
        .await
        .unwrap();
    assert!(exact);
    assert_eq!(allowed.total, 4);
    assert_eq!(allowed.items.len(), 4);
    assert!(
        allowed
            .items
            .iter()
            .all(|task| task.workplace_id == Some(w.site)
                && task.applicability_facts.birth_date.is_none()
                && !task.can_record_sensitive_facts)
    );
    let other = tenant(&pool).await;
    let other_user = user(&pool, other.org, None).await;
    for reader in [scoped(Uuid::new_v4()), principal(other.org, other_user)] {
        let (page, exact) = w
            .tenant
            .hr
            .insurance_inbox_page(
                reader,
                FilingQuery {
                    workplace_id: Some(w.site),
                    ..query(200)
                },
                rules.clone(),
                None,
            )
            .await
            .unwrap();
        assert!(exact);
        assert_eq!(page.total, 0);
        assert_eq!(page.pending, 0);
        assert!(page.items.is_empty());
        assert!(page.next.is_none());
    }
}
