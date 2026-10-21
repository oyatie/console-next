//! Expand/contract for 0356: the release before it keeps inserting 전적 rows
//! without the 연차/근속 pair while blue and green share the schema (and after
//! a rollback). The insert is taken and the new read derives the pair from the
//! one choice, as the 0356 backfill does.

use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use super::*;

/// Re-writes one 전적's facts row with the previous release's INSERT, column
/// for column (no 연차/근속 pair).
const AS_PREVIOUS_RELEASE: &str = "WITH written AS (DELETE FROM employee_group_transfers \
       WHERE lifecycle_event_id = $1 RETURNING *) \
     INSERT INTO employee_group_transfers (org_id, lifecycle_event_id, employee_id, \
       from_legal_entity_id, to_legal_entity_id, to_workplace_id, start_date, continuity, \
       group_service_start_date, consent_date, consent_evidence_ref, succession_evidence_ref, \
       created_by) \
     SELECT org_id, lifecycle_event_id, employee_id, from_legal_entity_id, to_legal_entity_id, \
       to_workplace_id, start_date, continuity, group_service_start_date, consent_date, \
       consent_evidence_ref, succession_evidence_ref, created_by FROM written";

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_group_transfer_the_previous_release_wrote_reads_its_one_choice(pool: PgPool) {
    let cases = [
        (json!({ "continuity": "SETTLED" }), "SETTLED", "RESTART"),
        (
            json!({ "continuity": "CARRIED", "succession_evidence_ref": "포괄 승계 합의서" }),
            "CARRIED",
            "CARRIED",
        ),
    ];
    for (choice, leave, seniority) in cases {
        let f = fixture(pool.clone(), true).await;
        let (a, wa) = f.entity(1).await;
        let (_, wb) = f.entity(1).await;
        f.place(a, wa[0]).await;
        let mut facts = json!({
            "group_service_start_date": HIRE,
            "consent_date": day(-10),
            "consent_evidence_ref": "전적 동의서 (서명본)",
        });
        for (key, value) in choice.as_object().unwrap() {
            facts[key] = value.clone();
        }
        let body = event(
            "GROUP_TRANSFER",
            &day(-2),
            json!({ "to_workplace_id": wb[0], "group_transfer": facts }),
        );
        let moved = f.record(body).await.unwrap();
        let event_id = Uuid::parse_str(moved["id"].as_str().unwrap()).unwrap();

        sqlx::query(AS_PREVIOUS_RELEASE)
            .bind(event_id)
            .execute(&f.owner)
            .await
            .expect("the previous release's insert is taken on the expanded schema");
        let stored: (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT annual_leave_continuity, seniority_continuity FROM employee_group_transfers \
             WHERE lifecycle_event_id = $1",
        )
        .bind(event_id)
        .fetch_one(&f.owner)
        .await
        .unwrap();
        assert_eq!(stored, (None, None));

        let page =
            f.hr.lifecycle_events(f.principal.clone(), f.employee, Default::default(), false)
                .await
                .expect("the new read takes a row without the pair");
        let page = serde_json::to_value(page).unwrap();
        let read: &Value = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == json!(event_id))
            .unwrap();
        let g = &read["group_transfer"];
        assert_eq!(
            (
                &g["continuity"],
                &g["annual_leave_continuity"],
                &g["seniority_continuity"]
            ),
            (&choice["continuity"], &json!(leave), &json!(seniority)),
        );
    }
}
