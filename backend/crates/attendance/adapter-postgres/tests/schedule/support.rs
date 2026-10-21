//! A tenant with one 법인, two 사업장 (평택, 서울) each with its site unit and
//! branch, 생산부 › 생산1팀 under 평택, and people placed there.
#![allow(dead_code)]

use console_attendance_adapter_postgres::{PgAttendanceStore, ScheduleStoreError};
use console_attendance_application::CallerScope;
use console_attendance_application::schedule::{AssignInput, AssignTarget, PatternInput};
use console_attendance_domain::schedule::Level;
use console_kernel_core::OrgId;
use console_platform_test_support::{runtime_role_pool, seed_branch, seed_user};
use serde_json::json;
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

pub struct World {
    pub owner: PgPool,
    pub store: PgAttendanceStore,
    pub org: Uuid,
    pub admin: Uuid,
    pub entity: Uuid,
    /// 평택, 서울.
    pub workplaces: [Uuid; 2],
    pub branches: [Uuid; 2],
    pub dept: Uuid,
    pub team: Uuid,
    /// Two people in 생산1팀 (평택) and one at 서울 with no 부서.
    pub people: [Uuid; 3],
}

impl World {
    pub fn hr(&self) -> CallerScope {
        CallerScope {
            org_id: self.org,
            user_id: self.admin,
            branch_ids: vec![],
            org_wide: true,
        }
    }
    /// An HR worker scoped to 서울 only.
    pub fn seoul_hr(&self) -> CallerScope {
        CallerScope {
            org_id: self.org,
            user_id: self.admin,
            branch_ids: vec![self.branches[1]],
            org_wide: false,
        }
    }
}

pub async fn seed(pool: &PgPool, sql: String) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(OrgId::one().as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

fn unit(org: Uuid, actor: Uuid, id: Uuid, name: &str, kind: &str, parent: Option<Uuid>) -> String {
    let parent = parent
        .map(|p| format!(", \"parent_id\": \"{p}\""))
        .unwrap_or_default();
    format!(
        "INSERT INTO org_units (org_id, id) VALUES ('{org}', '{id}'); \
         INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
         VALUES ('{org}', '{id}', 1, gen_random_uuid(), '{actor}', decode(repeat('ab', 32), 'hex'), \
         '{{\"kind\": \"{kind}\", \"name\": \"{name}\", \"status\": \"active\"{parent}}}', '{{}}');"
    )
}

pub async fn world(owner: PgPool) -> World {
    let org = *OrgId::one().as_uuid();
    let branches = [
        *seed_branch(&owner, "r", "평택").await.as_uuid(),
        *seed_branch(&owner, "r", "서울").await.as_uuid(),
    ];
    let admin = *seed_user(
        &owner,
        "문지호",
        "SUPER_ADMIN",
        console_kernel_core::BranchId::from_uuid(branches[0]),
    )
    .await
    .as_uuid();
    let (entity, workplaces, sites) = (
        Uuid::new_v4(),
        [Uuid::new_v4(), Uuid::new_v4()],
        [Uuid::new_v4(), Uuid::new_v4()],
    );
    let (dept, team) = (Uuid::new_v4(), Uuid::new_v4());
    let people = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    let mut sql = format!(
        "INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) VALUES ('{org}', '{entity}', true, 'MIGRATION'); \
         INSERT INTO legal_entity_revisions (org_id, legal_entity_id, version, command_id, effective_from, name, change_mode, \
         reason_code, payload_digest, settings_snapshot) VALUES ('{org}', '{entity}', 1, gen_random_uuid(), '2020-01-01', \
         '(주)새온정밀', 'MIGRATION', 'MIGRATION', decode(repeat('ab', 32), 'hex'), '{{}}');"
    );
    for (i, name) in ["평택공장", "서울 본사"].iter().enumerate() {
        let (w, s, b) = (workplaces[i], sites[i], branches[i]);
        sql.push_str(&format!(
            "INSERT INTO workplaces (org_id, id, legal_entity_id, default_branch_id, needs_confirmation, created_change_mode) \
             VALUES ('{org}', '{w}', '{entity}', '{b}', true, 'MIGRATION'); \
             INSERT INTO workplace_revisions (org_id, workplace_id, version, command_id, effective_from, name, status, change_mode, \
             reason_code, payload_digest, settings_snapshot) VALUES ('{org}', '{w}', 1, gen_random_uuid(), '2020-01-01', '{name}', \
             'CONTINUING', 'MIGRATION', 'MIGRATION', decode(repeat('ab', 32), 'hex'), '{{}}');"
        ));
        sql.push_str(&unit(org, admin, s, name, "site", None));
        sql.push_str(&format!(
            "INSERT INTO org_unit_placements (org_id, org_unit_id, legal_entity_id, workplace_id, represents_workplace, valid_from, change_mode, command_id) \
             VALUES ('{org}', '{s}', '{entity}', '{w}', true, '2020-01-01', 'MIGRATION', gen_random_uuid());"
        ));
    }
    sql.push_str(&unit(
        org,
        admin,
        dept,
        "생산부",
        "department",
        Some(sites[0]),
    ));
    sql.push_str(&unit(org, admin, team, "생산1팀", "department", Some(dept)));
    for (i, (name, number)) in [
        ("윤하준", "10587"),
        ("황정우", "10267"),
        ("김서울", "20001"),
    ]
    .iter()
    .enumerate()
    {
        let (id, w) = (people[i], workplaces[usize::from(i == 2)]);
        let unit = if i == 2 {
            "NULL".to_owned()
        } else {
            format!("'{team}'")
        };
        sql.push_str(&format!(
            "INSERT INTO employees (id, org_id, company, name, position, source_filename, source_sheet, source_row, source_key, \
             hire_date, hire_on, employee_number, org_unit_id, employment_status) VALUES ('{id}', '{org}', 'Co', '{name}', '사원', \
             'console', 'console', 1, '{id}', '2020-01-02', '2020-01-02', '{number}', {unit}, 'ACTIVE'); \
             INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, cause, actor_id, command_id) \
             VALUES ('{org}', '{id}', '{entity}', '{w}', '2020-01-02', 'HIRE', '{admin}', gen_random_uuid());"
        ));
    }
    seed(&owner, sql).await;
    let store = PgAttendanceStore::new(runtime_role_pool(&owner).await);
    World {
        owner,
        store,
        org,
        admin,
        entity,
        workplaces,
        branches,
        dept,
        team,
        people,
    }
}

pub fn key() -> String {
    format!("att-s1-{}", Uuid::new_v4().simple())
}

/// 주 5일 09–18, 휴게 12–13, 토 휴무, 일 주휴.
pub fn office(name: &str) -> PatternInput {
    let work = json!({"kind": "WORK", "shift": {"start": 540, "end": 1080, "breaks": [{"start": 720, "end": 780}]}});
    PatternInput {
        name: name.into(),
        kind: "WEEKLY".into(),
        holiday_rule: None,
        days: Some(
            json!([work, work, work, work, work, {"kind": "REST_DAY"}, {"kind": "WEEKLY_HOLIDAY"}]),
        ),
        slots: None,
        start_choices: None,
    }
}

pub fn assign(level: Level, scope: Uuid, pattern: Uuid, from: Date) -> AssignInput {
    AssignInput {
        targets: vec![AssignTarget {
            scope_kind: level,
            scope_id: scope,
            rotation_start: None,
            start_choice: None,
        }],
        pattern_id: pattern,
        effective_from: from,
        effective_to: None,
        reason: "STANDARD".into(),
        evidence_ref: None,
    }
}

pub fn today() -> Date {
    (OffsetDateTime::now_utc() + Duration::hours(9)).date()
}

/// The first day of the month after next: always in the future.
pub fn future() -> Date {
    let next = (today().replace_day(28).unwrap() + Duration::days(4))
        .replace_day(28)
        .unwrap()
        + Duration::days(4);
    next.replace_day(1).unwrap()
}

/// The wire code of a refused store call.
pub fn code<T: std::fmt::Debug>(r: Result<T, ScheduleStoreError>) -> &'static str {
    refused(r.unwrap_err())
}

pub fn refused(e: ScheduleStoreError) -> &'static str {
    match e {
        ScheduleStoreError::Refused(r) => r.code(),
        ScheduleStoreError::Conflict(c)
        | ScheduleStoreError::Invalid(c)
        | ScheduleStoreError::NotFound(c) => c,
        ScheduleStoreError::Forbidden => "forbidden",
        other => panic!("unexpected {other:?}"),
    }
}

pub async fn rows(w: &World, table: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*) FROM {table}")))
        .fetch_one(&w.owner)
        .await
        .unwrap()
}
