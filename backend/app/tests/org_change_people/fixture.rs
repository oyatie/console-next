//! An operating tenant with one 법인, two 사업장 (본사, 판교) each with its
//! SITE unit, 부서 under them, people placed in those 부서, and an ops caller
//! on the default `approval.policy.org_structure = none` (decisions #26).

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime, UtcOffset};
use uuid::Uuid;

use super::go_live::live_org;
use super::harness::{Caller, keys, router, token, user};

pub const HIRE: &str = "2026-01-02";
pub const CHANGES: &str = "/api/v1/org-changes";

pub fn today() -> Date {
    OffsetDateTime::now_utc()
        .to_offset(UtcOffset::from_hms(9, 0, 0).unwrap())
        .date()
}

pub fn day(offset: i64) -> String {
    (today() + Duration::days(offset)).to_string()
}

pub fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

pub struct Tenant {
    pub owner: PgPool,
    pub keys: (String, String),
    pub org: Uuid,
    pub actor: Uuid,
    pub ops: Caller,
    pub entity: Uuid,
    /// 본사, 판교.
    pub workplaces: [Uuid; 2],
    /// The SITE unit of each 사업장.
    pub sites: [Uuid; 2],
}

/// Fixture rows written as the owner, in the tenant, triggers and FKs off.
pub async fn seed(pool: &PgPool, org: Uuid, sql: String) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

pub async fn tenant(pool: PgPool) -> Tenant {
    let org = Uuid::new_v4();
    let slug = format!("ocp-{}", &org.simple().to_string()[..12]);
    live_org(&pool, org, slug, "ORGCHANGE people").await;
    let actor = user(&pool, org, "SUPER_ADMIN").await;
    let keys = keys();
    let ops = Caller {
        service: router(&pool, &keys).await,
        token: Some(token(&pool, &keys, org, actor, "SUPER_ADMIN").await),
    };
    let entity = Uuid::new_v4();
    let workplaces = [Uuid::new_v4(), Uuid::new_v4()];
    let sites = [Uuid::new_v4(), Uuid::new_v4()];
    let mut sql = format!(
        "INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) \
         VALUES ('{org}', '{entity}', true, 'MIGRATION');"
    );
    for (w, (site, name)) in workplaces.iter().zip(sites.iter().zip(["본사", "판교"])) {
        sql.push_str(&format!(
            "INSERT INTO workplaces (org_id, id, legal_entity_id, needs_confirmation, \
             created_change_mode) VALUES ('{org}', '{w}', '{entity}', true, 'MIGRATION');"
        ));
        sql.push_str(&unit_sql(org, *actor.as_uuid(), *site, name, "site", None));
        sql.push_str(&format!(
            "INSERT INTO org_unit_placements (org_id, org_unit_id, legal_entity_id, workplace_id, \
             represents_workplace, valid_from, change_mode, command_id) VALUES ('{org}', \
             '{site}', '{entity}', '{w}', true, '2026-01-01', 'MIGRATION', gen_random_uuid());"
        ));
    }
    seed(&pool, org, sql).await;
    Tenant {
        owner: pool,
        keys,
        org,
        actor: *actor.as_uuid(),
        ops,
        entity,
        workplaces,
        sites,
    }
}

fn unit_sql(
    org: Uuid,
    actor: Uuid,
    id: Uuid,
    name: &str,
    kind: &str,
    parent: Option<Uuid>,
) -> String {
    let parent = parent.map_or(String::new(), |p| format!(", \"parent_id\": \"{p}\""));
    format!(
        "INSERT INTO org_units (org_id, id) VALUES ('{org}', '{id}'); \
         INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, \
         payload_digest, attributes, receipt) VALUES ('{org}', '{id}', 1, gen_random_uuid(), \
         '{actor}', decode(repeat('ab', 32), 'hex'), '{{\"kind\": \"{kind}\", \"name\": \
         \"{name}\", \"status\": \"active\"{parent}}}', '{{}}');"
    )
}

impl Tenant {
    /// A caller holding `role` (ADMIN: may draft, may not apply).
    pub async fn caller(&self, role: &str) -> Caller {
        let id = user(&self.owner, self.org, role).await;
        Caller {
            service: router(&self.owner, &self.keys).await,
            token: Some(token(&self.owner, &self.keys, self.org, id, role).await),
        }
    }

    /// Routes org changes through 결재 (`approval.policy.org_structure = route`).
    pub async fn route_org_changes(&self) {
        let (org, actor) = (self.org, self.actor);
        let sql = format!(
            "INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) \
             VALUES ('{org}', 'approval.policy.org_structure', '\"route\"', '{actor}', 'BW01')"
        );
        seed(&self.owner, org, sql).await;
    }

    /// The SITE unit of a 사업장 of another 법인.
    pub async fn other_entity_site(&self) -> Uuid {
        let (org, actor) = (self.org, self.actor);
        let (entity, workplace, site) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let mut sql = format!(
            "INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) \
             VALUES ('{org}', '{entity}', true, 'MIGRATION'); \
             INSERT INTO workplaces (org_id, id, legal_entity_id, needs_confirmation, \
             created_change_mode) VALUES ('{org}', '{workplace}', '{entity}', true, 'MIGRATION');"
        );
        sql.push_str(&unit_sql(org, actor, site, "자회사 본사", "site", None));
        sql.push_str(&format!(
            "INSERT INTO org_unit_placements (org_id, org_unit_id, legal_entity_id, workplace_id, \
             represents_workplace, valid_from, change_mode, command_id) VALUES ('{org}', \
             '{site}', '{entity}', '{workplace}', true, '2026-01-01', 'MIGRATION', gen_random_uuid());"
        ));
        seed(&self.owner, org, sql).await;
        site
    }

    /// The latest revision of `unit`: `(version, attributes)`.
    pub async fn head(&self, unit: Uuid) -> (i64, Value) {
        sqlx::query_as(
            "SELECT version, attributes FROM org_unit_revisions WHERE org_unit_id = $1 \
             ORDER BY version DESC LIMIT 1",
        )
        .bind(unit)
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }

    /// Audit rows of `action` in the tenant.
    pub async fn audits(&self, action: &str) -> i64 {
        let mut tx = self.owner.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(self.org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = $2")
            .bind(self.org)
            .bind(action)
            .fetch_one(tx.as_mut())
            .await
            .unwrap()
    }

    /// Drafts one change without submitting it; returns its id.
    pub async fn draft(&self, kind: &str, unit: Uuid, ops: Value, on: &str) -> String {
        let body = json!({
            "kind": kind,
            "target": {"kind": "ORG_UNIT", "ref": unit, "label": "부서"},
            "effectiveDate": on,
            "reason": "조직 개편",
            "proposal": ops,
        });
        let (status, draft) = self.ops.call("POST", CHANGES, Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "draft: {draft}");
        draft["id"].as_str().unwrap().to_owned()
    }

    /// A 부서 under `parent` (a SITE unit or another 부서).
    pub async fn dept(&self, name: &str, parent: Uuid) -> Uuid {
        let id = Uuid::new_v4();
        let sql = unit_sql(self.org, self.actor, id, name, "department", Some(parent));
        seed(&self.owner, self.org, sql).await;
        id
    }

    /// A person in `unit`, placed at `workplace` from the hire date.
    pub async fn person(&self, name: &str, unit: Uuid, workplace: Uuid, status: &str) -> Uuid {
        let (org, entity, actor, id) = (self.org, self.entity, self.actor, Uuid::new_v4());
        let sql = format!(
            "INSERT INTO employees (id, org_id, company, name, position, source_filename, \
             source_sheet, source_row, source_key, hire_date, org_unit_id, employment_status) \
             VALUES ('{id}', '{org}', 'Co', '{name}', '사원', 'console', 'console', 1, \
             '{id}', '{HIRE}', '{unit}', '{status}'); \
             INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, \
             workplace_id, valid_from, cause, actor_id, command_id) VALUES ('{org}', '{id}', \
             '{entity}', '{workplace}', '{HIRE}', 'HIRE', '{actor}', gen_random_uuid());"
        );
        seed(&self.owner, self.org, sql).await;
        id
    }

    /// Drafts and submits one change; under policy none a change dated today
    /// applies in the submit. Returns the submit's status and body.
    pub async fn change(
        &self,
        kind: &str,
        unit: Uuid,
        ops: Value,
        on: &str,
    ) -> (StatusCode, Value) {
        let id = self.draft(kind, unit, ops, on).await;
        self.ops
            .send("POST", &format!("{CHANGES}/{id}/submit"), None, false)
            .await
    }

    /// Live assignment rows of `employee`, oldest first: `(from, to, workplace, cause)`.
    pub async fn live(&self, employee: Uuid) -> Vec<(String, Option<String>, Uuid, String)> {
        let rows: Vec<(Date, Option<Date>, Uuid, String)> = sqlx::query_as(
            "SELECT valid_from, valid_to, workplace_id, cause FROM employment_assignments \
             WHERE employee_id = $1 AND superseded_at IS NULL ORDER BY valid_from",
        )
        .bind(employee)
        .fetch_all(&self.owner)
        .await
        .unwrap();
        rows.into_iter()
            .map(|(f, t, w, c)| (f.to_string(), t.map(|d| d.to_string()), w, c))
            .collect()
    }

    /// `employee`'s lifecycle events: `(event_type, state, effective_date, batch_id, to_org_unit_id)`.
    pub async fn events(
        &self,
        employee: Uuid,
    ) -> Vec<(String, String, String, Option<Uuid>, Option<Uuid>)> {
        sqlx::query_as(
            "SELECT event_type, state, effective_date::text, batch_id, to_org_unit_id \
             FROM employee_lifecycle_events WHERE employee_id = $1 ORDER BY created_at",
        )
        .bind(employee)
        .fetch_all(&self.owner)
        .await
        .unwrap()
    }

    pub async fn unit_of(&self, employee: Uuid) -> Option<Uuid> {
        sqlx::query_scalar("SELECT org_unit_id FROM employees WHERE id = $1")
            .bind(employee)
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }

    /// People on the roll whose live assignment today is not at their unit's
    /// 사업장 (the unit's nearest placed ancestor's): the data check.
    pub async fn mismatches(&self) -> Vec<Uuid> {
        sqlx::query_scalar(
            "WITH RECURSIVE heads AS ( \
               SELECT DISTINCT ON (org_unit_id) org_unit_id AS id, attributes->>'parent_id' AS parent \
               FROM org_unit_revisions WHERE org_id = $1 ORDER BY org_unit_id, version DESC), \
             up AS ( \
               SELECT e.id AS employee, e.org_unit_id AS unit, 0 AS depth FROM employees e \
               WHERE e.org_id = $1 AND e.employment_status IN ('ACTIVE', 'ON_LEAVE') \
               UNION ALL SELECT up.employee, h.parent::uuid, up.depth + 1 FROM up \
               JOIN heads h ON h.id = up.unit WHERE h.parent IS NOT NULL AND up.depth < 32), \
             placed AS ( \
               SELECT DISTINCT ON (up.employee) up.employee, p.workplace_id FROM up \
               JOIN org_unit_placements p ON p.org_id = $1 AND p.org_unit_id = up.unit \
                 AND p.valid_to IS NULL AND p.workplace_id IS NOT NULL \
               ORDER BY up.employee, up.depth) \
             SELECT placed.employee FROM placed JOIN employment_assignments a \
               ON a.org_id = $1 AND a.employee_id = placed.employee AND a.superseded_at IS NULL \
               AND a.valid_from <= $2 AND (a.valid_to IS NULL OR a.valid_to > $2) \
             WHERE a.workplace_id IS DISTINCT FROM placed.workplace_id ORDER BY 1",
        )
        .bind(self.org)
        .bind(today())
        .fetch_all(&self.owner)
        .await
        .unwrap()
    }

    pub async fn request(&self, id: &str) -> Value {
        let (status, body) = self
            .ops
            .send("GET", &format!("{CHANGES}/{id}"), None, false)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }
}
