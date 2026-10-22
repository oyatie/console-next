//! TR-33 (move walk M22, decisions #30): a 전보 never crosses 법인. A TRANSFER
//! to a 부서 under another 법인's 사업장 — single, bulk or future-dated — is
//! 422 `transfer_cross_entity` naming the target, and writes nothing: no
//! event, no assignment, no audit row. The 부서 has no placement of its own;
//! its 법인 is its 사업장's.

use console_hr_adapter_postgres::lifecycle::requests::{
    BulkEmployeeLifecycleEventRequest, CreateEmployeeLifecycleEventRequest,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use super::*;

impl Fixture {
    /// A unit, drawn as `placed`'s 사업장 (a SITE) when given; a 부서 names
    /// its `parent_id` and has no placement of its own (what the structure
    /// editor makes).
    async fn unit(&self, attributes: Value, placed: Option<(Uuid, Uuid)>) -> Uuid {
        let (org, user, unit) = (self.org, self.user, Uuid::new_v4());
        let mut sql = format!(
            "INSERT INTO org_units (org_id, id) VALUES ('{org}', '{unit}'); \
             INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, \
             payload_digest, attributes, receipt) VALUES ('{org}', '{unit}', 1, gen_random_uuid(), \
             '{user}', decode(repeat('ab', 32), 'hex'), '{attributes}', '{{}}');"
        );
        if let Some((entity, workplace)) = placed {
            sql.push_str(&format!(
                "INSERT INTO org_unit_placements (org_id, org_unit_id, legal_entity_id, \
                 workplace_id, represents_workplace, valid_from, change_mode, command_id) VALUES \
                 ('{org}', '{unit}', '{entity}', '{workplace}', true, '2026-01-01', 'MIGRATION', \
                 gen_random_uuid());"
            ));
        }
        seed(&self.owner, org, sql).await;
        unit
    }

    /// The SITE unit of `workplace` and one 부서 under it: `(site, 부서)`.
    pub(crate) async fn department_under(
        &self,
        entity: Uuid,
        workplace: Uuid,
        name: &str,
    ) -> (Uuid, Uuid) {
        let site = self
            .unit(
                json!({"kind": "site", "name": "사업장"}),
                Some((entity, workplace)),
            )
            .await;
        (site, self.department(site, name).await)
    }

    pub(crate) async fn department(&self, site: Uuid, name: &str) -> Uuid {
        let attributes = json!({"kind": "department", "name": name, "parent_id": site});
        self.unit(attributes, None).await
    }

    /// One row read in the tenant (RLS armed).
    async fn read<T>(&self, sql: &str) -> T
    where
        T: for<'r> sqlx::FromRow<'r, sqlx::postgres::PgRow> + Send + Unpin,
    {
        let mut tx = self.owner.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(self.org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query_as(sqlx::AssertSqlSafe(sql))
            .bind(self.org)
            .bind(self.employee)
            .fetch_one(tx.as_mut())
            .await
            .unwrap()
    }

    /// What a refused write must leave untouched: lifecycle events, live
    /// assignments, lifecycle audits and the employee's unit.
    pub(crate) async fn written(&self) -> (i64, i64, i64, Option<Uuid>) {
        self.read(
            "SELECT (SELECT count(*) FROM employee_lifecycle_events WHERE employee_id = $2), \
                    (SELECT count(*) FROM employment_assignments WHERE employee_id = $2), \
                    (SELECT count(*) FROM audit_events WHERE org_id = $1 \
                       AND action LIKE 'employee.lifecycle.%'), \
                    (SELECT org_unit_id FROM employees WHERE id = $2)",
        )
        .await
    }

    /// The single command's full refusal: `(status, code, refusals)`.
    async fn refused(&self, body: Value) -> (u16, String, Value) {
        let body: CreateEmployeeLifecycleEventRequest = serde_json::from_value(body).unwrap();
        let e = self
            .hr
            .record_lifecycle_event(self.principal.clone(), self.employee, key(), body)
            .await
            .unwrap_err();
        (
            e.status.as_u16(),
            e.code.to_owned(),
            *e.refusals.unwrap_or_default(),
        )
    }

    async fn bulk(&self, unit: Uuid, on: &str) -> Result<Value, (u16, String, Value)> {
        let body: BulkEmployeeLifecycleEventRequest = serde_json::from_value(json!({
            "event_type": "TRANSFER", "employee_ids": [self.employee], "to_org_unit_id": unit,
            "effective_date": on, "comment": "TR-33",
        }))
        .unwrap();
        self.hr
            .bulk_lifecycle_events(self.principal.clone(), key(), body)
            .await
            .map_err(|e| {
                (
                    e.status.as_u16(),
                    e.code.to_owned(),
                    *e.refusals.unwrap_or_default(),
                )
            })
    }
}

fn key() -> String {
    format!("tr33-{}", Uuid::new_v4())
}

fn transfer(on: &str, unit: Uuid) -> Value {
    event("TRANSFER", on, json!({"to_org_unit_id": unit}))
}

/// Two 법인 A and B, the employee placed at A's 사업장, a 부서 under each:
/// `(a, b, ours, theirs, [A's SITE unit, B's])`.
async fn two_entities(f: &Fixture) -> (Uuid, Uuid, Uuid, Uuid, [Uuid; 2]) {
    let (a, wa) = f.entity(1).await;
    let (b, wb) = f.entity(1).await;
    f.place(a, wa[0]).await;
    let (site_a, ours) = f.department_under(a, wa[0], "인사팀").await;
    let (site_b, theirs) = f.department_under(b, wb[0], "기획팀").await;
    (a, b, ours, theirs, [site_a, site_b])
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_m22_a_transfer_into_another_entitys_department_is_refused(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (a, b, ours, theirs, [site_a, _]) = two_entities(&f).await;
    let before = f.written().await;
    // Today and future-dated (a reservation is judged on its date): the same refusal.
    for on in [day(0), day(-1), day(10)] {
        let (status, code, refusals) = f.refused(transfer(&on, theirs)).await;
        assert_eq!(
            (status, code.as_str()),
            (422, "transfer_cross_entity"),
            "{on}"
        );
        assert_eq!(
            refusals,
            json!([{
                "field": "to_org_unit_id", "code": "transfer_cross_entity", "value": theirs,
                "from_legal_entity_id": a, "to_legal_entity_id": b,
            }])
        );
        assert_eq!(f.written().await, before, "nothing written ({on})");
    }
    // The same 법인's 부서 still records, now and on a later date; no 전근
    // (the 부서 is at the 사업장 they work at), so the assignment stays one row.
    f.record(transfer(&day(0), ours)).await.unwrap();
    let after = f.written().await;
    assert_eq!((after.0, after.1, after.3), (1, 1, Some(ours)));
    let sibling = f.department(site_a, "총무팀").await;
    let reserved = f.record(transfer(&day(10), sibling)).await.unwrap();
    assert_eq!(reserved["state"], json!("SCHEDULED"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_m22_a_bulk_transfer_into_another_entity_refuses_the_employee(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (_, _, ours, theirs, _) = two_entities(&f).await;
    let before = f.written().await;
    for on in [day(0), day(10)] {
        let (status, code, refusals) = f.bulk(theirs, &on).await.unwrap_err();
        assert_eq!((status, code.as_str()), (422, "bulk_lifecycle_refused"));
        assert_eq!(refusals[0]["employee_id"], json!(f.employee));
        assert_eq!(refusals[0]["code"], json!("transfer_cross_entity"));
        assert_eq!(refusals[0]["field"], json!("to_org_unit_id"));
        assert_eq!(f.written().await, before, "nothing written ({on})");
    }
    let done = f.bulk(ours, &day(0)).await.unwrap();
    assert_eq!(done["items"].as_array().unwrap().len(), 1);
    assert_eq!(f.written().await.3, Some(ours));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_reservation_whose_department_left_the_entity_fails_on_its_date(pool: PgPool) {
    // A transfer scheduled before its 부서 was placed under another 법인 (or
    // before this guard) is re-judged on its date: APPLY_FAILED, not applied.
    let f = fixture(pool, true).await;
    let (_, _, ours, _, [_, site_b]) = two_entities(&f).await;
    let reserved = f.record(transfer(&day(5), ours)).await.unwrap();
    let id = reserved["id"].as_str().unwrap().to_owned();
    let (org, user) = (f.org, f.user);
    let moved = json!({"kind": "department", "name": "인사팀", "parent_id": site_b});
    seed(
        &f.owner,
        org,
        format!(
            "INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, \
             payload_digest, attributes, receipt) VALUES ('{org}', '{ours}', 2, gen_random_uuid(), \
             '{user}', decode(repeat('ab', 32), 'hex'), '{moved}', '{{}}')"
        ),
    )
    .await;
    let before = f.written().await;
    f.hr.apply_due(today() + Duration::days(5)).await.unwrap();
    let (state, failure): (String, Option<String>) = f
        .read(&format!(
            "SELECT state, failure_code FROM employee_lifecycle_events \
             WHERE org_id = $1 AND employee_id = $2 AND id = '{id}'"
        ))
        .await;
    assert_eq!(
        (state.as_str(), failure.as_deref()),
        ("APPLY_FAILED", Some("transfer_cross_entity"))
    );
    let after = f.written().await;
    assert_eq!((after.1, after.3), (before.1, before.3), "not moved");
}
