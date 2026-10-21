//! MR-27: a change set goes beyond TRANSFER / PROMOTE. Each line carries its
//! own MR-24/25 values (an APPOINT per person, a 고용형태 전환, a 직급 PROMOTE)
//! and the commit records them as one lifecycle batch.

use console_hr_adapter_postgres::change_sets::{
    CommitChangeSetRequest, OpenChangeSetRequest, PutChangeSetLineRequest,
};
use console_hr_adapter_postgres::clock::today_kst;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{Fixture, fixture};

fn line(employee_id: Uuid, extra: Value) -> PutChangeSetLineRequest {
    let mut body = json!({
        "employee_id": employee_id,
        "effective_date": today_kst().to_string(),
        "comment": "MR-27",
    });
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(body).unwrap()
}

impl Fixture {
    async fn draft(&self, intent: &str, lines: Vec<PutChangeSetLineRequest>) -> Uuid {
        let open = OpenChangeSetRequest {
            intent: intent.to_owned(),
        };
        let set = self
            .hr
            .open_change_set(self.principal.clone(), open)
            .await
            .unwrap()
            .summary
            .id;
        for body in lines {
            self.hr
                .put_change_set_line(self.principal.clone(), set, body)
                .await
                .unwrap();
        }
        set
    }

    async fn commit(&self, set: Uuid) -> Value {
        let signed: CommitChangeSetRequest =
            serde_json::from_value(json!({ "signoffs": {} })).unwrap();
        self.hr
            .commit_change_set(
                self.principal.clone(),
                set,
                Some(format!("mr27-{}", Uuid::new_v4())),
                signed,
            )
            .await
            .unwrap()
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_change_set_commits_a_different_appointment_per_line(pool: PgPool) {
    let f = fixture(pool).await;
    let (a, b) = (f.employee(None).await, f.employee(None).await);
    let lead = f.entry("POSITION", "팀장", None).await;
    let part = f.entry("POSITION", "파트장", None).await;
    let set = f
        .draft(
            "APPOINT",
            vec![
                line(a, json!({ "to_position_kind_id": lead })),
                line(
                    b,
                    json!({ "to_position_kind_id": part, "to_job": "품질 관리" }),
                ),
            ],
        )
        .await;
    let drafted = f.hr.change_set(f.principal.clone(), set).await.unwrap();
    let kinds: Vec<Option<Uuid>> = drafted
        .lines
        .iter()
        .map(|l| l.classify.to_position_kind_id)
        .collect();
    assert!(kinds.contains(&Some(lead)) && kinds.contains(&Some(part)));
    let done = f.commit(set).await;
    assert_eq!(done["items"].as_array().unwrap().len(), 2);
    assert_eq!(f.head(a).await.1, Some(lead));
    let (_, kind, _, job, _) = f.head(b).await;
    assert_eq!((kind, job.as_deref()), (Some(part), Some("품질 관리")));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_change_set_converts_employment_types_and_promotes_by_grade(pool: PgPool) {
    let f = fixture(pool).await;
    let e = f.employee(Some("REGULAR")).await;
    // To CONTRACT needs the new contract's end; the draft says so at once.
    let open = OpenChangeSetRequest {
        intent: "EMPLOYMENT_TYPE_CHANGE".to_owned(),
    };
    let set =
        f.hr.open_change_set(f.principal.clone(), open)
            .await
            .unwrap()
            .summary
            .id;
    let missing =
        f.hr.put_change_set_line(
            f.principal.clone(),
            set,
            line(e, json!({ "to_employment_type": "CONTRACT" })),
        )
        .await
        .unwrap_err();
    assert_eq!(missing.status.as_u16(), 422);
    f.hr.put_change_set_line(
        f.principal.clone(),
        set,
        line(
            e,
            json!({ "to_employment_type": "CONTRACT", "contract_end_date": "2027-06-30" }),
        ),
    )
    .await
    .unwrap();
    f.commit(set).await;
    let (kind, start, end) = f.employment(e).await;
    assert_eq!(
        (kind.as_str(), end.as_deref()),
        ("CONTRACT", Some("2027-06-30"))
    );
    assert_eq!(start, Some(today_kst().to_string()));

    let grade = f.entry("GRADE", "3급", Some(3)).await;
    let set = f
        .draft("PROMOTE", vec![line(e, json!({ "to_grade_id": grade }))])
        .await;
    f.commit(set).await;
    assert_eq!(f.head(e).await.0, Some(grade));

    // A kind outside the bulk ones is still refused.
    let exit = OpenChangeSetRequest {
        intent: "EXIT".to_owned(),
    };
    assert_eq!(
        f.hr.open_change_set(f.principal.clone(), exit)
            .await
            .unwrap_err()
            .status
            .as_u16(),
        422
    );
}
