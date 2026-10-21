//! E-S3b 전적 (GROUP_TRANSFER): consent, continuity and the move to another 법인.

use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use super::*;

fn group(on: &str, workplace: Uuid, continuity: &str) -> Value {
    event(
        "GROUP_TRANSFER",
        on,
        json!({
            "to_workplace_id": workplace,
            "group_transfer": {
                "continuity": continuity,
                "group_service_start_date": HIRE,
                "consent_date": day(-10),
                "consent_evidence_ref": "전적 동의서 (서명본)",
            },
        }),
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_group_transfer_moves_the_employee_to_the_other_entity_until_rescinded(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (a, wa) = f.entity(1).await;
    let (b, wb) = f.entity(2).await;
    f.place(a, wa[0]).await;
    let on = day(-2);

    // The facts are required, with no defaults; 포괄 승계 needs its agreement.
    let mut bare = group(&on, wb[0], "SETTLED");
    bare.as_object_mut().unwrap().remove("group_transfer");
    assert_eq!(f.record(bare).await.unwrap_err().0, 422);
    assert_eq!(
        f.record(group(&on, wb[0], "CARRIED")).await.unwrap_err().0,
        422
    );
    // A 사업장 of the employee's own 법인 is a 전근, not a 전적.
    assert_eq!(
        f.record(group(&on, wa[0], "SETTLED")).await.unwrap_err(),
        (422, "group_transfer_same_entity".to_owned())
    );

    let moved = f.record(group(&on, wb[0], "SETTLED")).await.unwrap();
    assert_eq!(moved["event_type"], "GROUP_TRANSFER");
    assert_eq!(moved["to_status"], "ACTIVE");
    assert_eq!(moved["to_workplace_id"], json!(wb[0]));
    let facts = &moved["group_transfer"];
    assert_eq!(facts["continuity"], "SETTLED");
    assert_eq!(facts["from_legal_entity_id"], json!(a));
    assert_eq!(facts["to_legal_entity_id"], json!(b));
    assert_eq!(facts["group_service_start_date"], HIRE);
    assert_eq!(facts["consent_evidence_ref"], "전적 동의서 (서명본)");
    assert_eq!(
        f.live().await,
        [
            (
                HIRE.to_owned(),
                Some(on.clone()),
                Some(wa[0]),
                "HIRE".to_owned()
            ),
            (on.clone(), None, Some(wb[0]), "GROUP_TRANSFER".to_owned()),
        ]
    );
    let linked: Option<Uuid> = sqlx::query_scalar(
        "SELECT group_transfer_id FROM employment_assignments \
         WHERE employee_id = $1 AND superseded_at IS NULL AND cause = 'GROUP_TRANSFER'",
    )
    .bind(f.employee)
    .fetch_one(&f.owner)
    .await
    .unwrap();
    assert_eq!(
        linked.map(|id| id.to_string()).as_deref(),
        moved["id"].as_str()
    );

    f.rescind(&moved).await;
    assert_eq!(
        f.live().await,
        [(HIRE.to_owned(), None, Some(wa[0]), "HIRE".to_owned())]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_group_transfer_is_a_setup_record_in_setup(pool: PgPool) {
    let f = fixture(pool, false).await;
    let (a, wa) = f.entity(1).await;
    let (_, wb) = f.entity(1).await;
    f.place(a, wa[0]).await;
    let moved = f.record(group(&day(-1), wb[0], "SETTLED")).await.unwrap();
    assert_eq!(f.live().await.last().unwrap().2, Some(wb[0]));
    assert_eq!(f.setup_records().await, 1);
    f.rescind(&moved).await;
    assert_eq!(f.live().await.last().unwrap().2, Some(wa[0]));
}

/// The card offers 전적 by the state rule (it used to be missing from
/// `allowed_events`, so the console never opened it).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_detail_offers_a_group_transfer(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (a, wa) = f.entity(1).await;
    f.place(a, wa[0]).await;
    let detail =
        f.hr.employee_detail(f.principal.clone(), f.employee)
            .await
            .unwrap();
    let offered: Vec<&str> = detail.allowed_events.iter().map(|e| e.event_type).collect();
    assert!(offered.contains(&"GROUP_TRANSFER"), "{offered:?}");
}

impl Fixture {
    async fn record_as(&self, principal: Principal, employee: Uuid, body: Value) -> (u16, String) {
        let body: CreateEmployeeLifecycleEventRequest = serde_json::from_value(body).unwrap();
        let err = self
            .hr
            .record_lifecycle_event(principal, employee, Uuid::new_v4().to_string(), body)
            .await
            .unwrap_err();
        (err.status.as_u16(), err.code.to_owned())
    }

    /// Lifecycle rows of the employee, any state.
    pub(super) async fn events(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM employee_lifecycle_events WHERE employee_id = $1")
            .bind(self.employee)
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }
}

/// A holder of 인사 over the sending 법인 only may not place the person in
/// another: the receiving 사업장 is outside the grant set (403 out_of_scope),
/// and nothing is written.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_group_transfer_needs_the_receiving_entity_in_the_grant(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (a, wa) = f.entity(1).await;
    let (_, wb) = f.entity(1).await;
    f.place(a, wa[0]).await;
    let (before, events) = (f.live().await, f.events().await);
    let scoped = Principal::new(
        f.principal.user_id,
        f.principal.org_id,
        Default::default(),
        BranchScope::All,
    )
    // 인사 실무 over 법인 A: both appointment keys, nowhere else.
    .with_scope_grants(
        APPOINTMENT_KEYS
            .map(|feature| ScopeGrant {
                feature,
                kind: NodeKind::LegalEntity,
                id: a,
            })
            .to_vec(),
    );
    let body = group(&day(-2), wb[0], "SETTLED");
    assert_eq!(
        f.record_as(scoped, f.employee, body).await,
        (403, "out_of_scope".to_owned())
    );
    assert_eq!(f.live().await, before);
    assert_eq!(f.events().await, events);
    assert!(f.cases().await.is_empty(), "no settlement case either");
}

/// Another tenant's account does not find the person (404, no existence
/// leak), and a 사업장 of another tenant is no target: refused, nothing written.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_group_transfer_never_crosses_tenants(pool: PgPool) {
    let f = fixture(pool.clone(), true).await;
    let other = fixture(pool, true).await;
    let (a, wa) = f.entity(1).await;
    let (_, wb) = f.entity(1).await;
    let (_, theirs) = other.entity(1).await;
    f.place(a, wa[0]).await;
    let (before, events) = (f.live().await, f.events().await);
    let on = day(-2);

    let (status, code) = f
        .record_as(
            other.principal.clone(),
            f.employee,
            group(&on, wb[0], "SETTLED"),
        )
        .await;
    assert_eq!((status, code.as_str()), (404, "not_found"));
    let (status, code) = f
        .record_as(
            f.principal.clone(),
            f.employee,
            group(&on, theirs[0], "SETTLED"),
        )
        .await;
    assert_eq!((status, code.as_str()), (422, "workplace_not_open"));
    assert_eq!(f.live().await, before);
    assert_eq!(f.events().await, events);
    assert_eq!(other.events().await, 0);
    assert!(f.cases().await.is_empty(), "no settlement case either");
}
