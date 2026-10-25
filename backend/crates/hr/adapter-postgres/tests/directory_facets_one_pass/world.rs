//! The seeded tenant: fourteen people over every value a facet group reads.

use console_kernel_core::UserId;
use sqlx::PgPool;
use uuid::Uuid;

pub async fn seed(pool: &PgPool, sql: String) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    // Test fixture SQL built from generated ids only.
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

pub struct World {
    pub org: Uuid,
    pub actor: UserId,
    pub branch: Uuid,
    pub entities: [Uuid; 2],
    pub workplaces: [Uuid; 2],
    pub people: Vec<Uuid>,
}

/// Fourteen people spread over every value each facet group reads.
pub async fn world(pool: &PgPool, org: Uuid, actor: UserId) -> World {
    world_count(pool, org, actor, 14).await
}

/// The same facet fixture at a caller-selected capacity.
pub async fn world_count(pool: &PgPool, org: Uuid, actor: UserId, count: usize) -> World {
    let (region, branch, other_branch) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let entities = [Uuid::new_v4(), Uuid::new_v4()];
    let workplaces = [Uuid::new_v4(), Uuid::new_v4()];
    let actor_id = actor.as_uuid();
    let mut sql = format!(
        "INSERT INTO regions (id, name, org_id) VALUES ('{region}', 'R', '{org}'); \
         INSERT INTO branches (id, region_id, name, org_id) VALUES \
           ('{branch}', '{region}', 'A', '{org}'), ('{other_branch}', '{region}', 'B', '{org}');"
    );
    for (entity, workplace) in entities.iter().zip(workplaces) {
        sql.push_str(&format!(
            "INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) \
               VALUES ('{org}', '{entity}', true, 'MIGRATION'); \
             INSERT INTO legal_entity_revisions (org_id, legal_entity_id, version, command_id, \
               effective_from, name, display_name, change_mode, reason_code, payload_digest, \
               settings_snapshot) VALUES ('{org}', '{entity}', 1, gen_random_uuid(), \
               '2020-01-01', 'E 주식회사', 'E', 'MIGRATION', 'test', sha256('x'::bytea), '{{}}'); \
             INSERT INTO workplaces (org_id, id, legal_entity_id, needs_confirmation, \
               created_change_mode) VALUES ('{org}', '{workplace}', '{entity}', true, 'MIGRATION');"
        ));
    }
    let statuses = [
        "ACTIVE", "ACTIVE", "ON_LEAVE", "EXITED", "PRE_HIRE", "ACTIVE", "EXITED",
    ];
    let types = [Some("REGULAR"), Some("CONTRACT"), Some("PART_TIME"), None];
    let mut people = Vec::with_capacity(count);
    for n in 0..count {
        let id = Uuid::new_v4();
        people.push(id);
        let status = statuses[n % statuses.len()];
        let home = match n % 3 {
            0 => format!("'{branch}'"),
            1 => format!("'{other_branch}'"),
            _ => "NULL".to_owned(),
        };
        sql.push_str(&format!(
            "INSERT INTO employees (id, org_id, company, name, employee_number, employment_status, \
             identity_review_required, home_branch_id, source_filename, source_sheet, source_row, \
             source_key, raw_row, source_metadata) VALUES ('{id}', '{org}', 'Test', 'P{n}', \
             'N-{n}', '{status}', {}, {home}, 'test.xlsx', 'Sheet', 1, 'key-{id}', '{{}}', '{{}}');",
            n % 4 == 1
        ));
        if let Some(kind) = types[n % types.len()] {
            let end = match n % 5 {
                0 => "'2020-01-31'",
                1 => "'2099-12-31'",
                2 => "'2026-11-30'",
                _ => "NULL",
            };
            sql.push_str(&format!(
                "INSERT INTO employee_employment_profiles (employee_id, org_id, employment_type, \
                 phone_e164, base_pay, idempotency_key, request_hash, created_by, contract_end_date) \
                 VALUES ('{id}', '{org}', '{kind}', '+821012345678', 0, 'p-{id}', repeat('a', 64), \
                 '{actor_id}', {end});"
            ));
        }
        // 0, 1: one 법인/사업장 each; 2: a 법인 with no 사업장; 3: none; plus a
        // superseded row that must never count.
        let pick = n % 4;
        if pick < 3 {
            let entity = entities[pick % 2];
            let workplace = if pick == 2 {
                "NULL".to_owned()
            } else {
                format!("'{}'", workplaces[pick])
            };
            sql.push_str(&format!(
                "INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, \
                 workplace_id, valid_from, cause, command_id) VALUES ('{org}', '{id}', \
                 '{entity}', {workplace}, '2024-01-01', 'MIGRATION', gen_random_uuid()); \
                 INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, \
                 workplace_id, valid_from, cause, superseded_at, command_id) VALUES ('{org}', \
                 '{id}', '{}', NULL, '2024-01-01', 'MIGRATION', now(), gen_random_uuid());",
                entities[(pick + 1) % 2]
            ));
        }
        // Failed actions: 0 mod 5 failed, 1 mod 5 failed then redone, the
        // rest none; an exited person's failure never counts.
        let failed = |at: &str| {
            format!(
                "INSERT INTO employee_lifecycle_events (org_id, employee_id, event_type, to_status, \
                 effective_date, comment, created_by, state, failure_code, created_at) VALUES \
                 ('{org}', '{id}', 'TRANSFER', 'ACTIVE', '2026-01-01', 'f', '{actor_id}', \
                 'APPLY_FAILED', 'org_unit_closed', {at});"
            )
        };
        match n % 5 {
            0 => sql.push_str(&failed("now() - interval '1 day'")),
            1 => {
                sql.push_str(&failed("now() - interval '2 day'"));
                sql.push_str(&format!(
                    "INSERT INTO employee_lifecycle_events (org_id, employee_id, event_type, \
                     to_status, effective_date, comment, created_by, state, created_at) VALUES \
                     ('{org}', '{id}', 'TRANSFER', 'ACTIVE', '2026-01-02', 'redo', '{actor_id}', \
                     'APPLIED', now() - interval '1 day');"
                ));
            }
            _ => {}
        }
    }
    seed(pool, sql).await;
    World {
        org,
        actor,
        branch,
        entities,
        workplaces,
        people,
    }
}

/// Pre-import-routing shape: every current placement has a NULL routing copy.
pub async fn place_except_last(pool: &PgPool, w: &World) {
    let org = w.org;
    let entity = w.entities[0];
    let workplace = w.workplaces[0];
    let missing = w.people.last().unwrap();
    seed(pool, format!(
        "UPDATE employees SET employment_status='ACTIVE', home_branch_id=NULL, org_unit_id=NULL, \
           source_metadata='{{}}' WHERE org_id='{org}'; \
         DELETE FROM employee_lifecycle_events WHERE org_id='{org}'; \
         DELETE FROM employment_assignments WHERE org_id='{org}'; \
         INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id, \
           valid_from,cause,command_id) \
         SELECT '{org}',id,'{entity}','{workplace}',entity_today()-1,'MIGRATION',gen_random_uuid() \
         FROM employees WHERE org_id='{org}' AND id<>'{missing}';"
    )).await;
}
