// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Real-router, runtime-RLS parity for chart, comparison, cards and dated inspector members.

#[path = "support/http.rs"]
mod support;

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use support::{Ctx, ctx, tenant, today_kst};
use time::{Date, Duration, format_description::well_known::Iso8601};
use uuid::Uuid;

const ADMIN: &[&str] = &["SUPER_ADMIN"];

struct Group {
    entity: Uuid,
    workplace: Uuid,
    department: Uuid,
}

async fn group(tx: &mut Transaction<'_, Postgres>, c: &Ctx, index: usize, opens: Date) -> Group {
    let (entity, workplace, site, department) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let org = c.org;
    let actor = c.user;
    let crn = ["0002110006241", "0001110000003"][index];
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "INSERT INTO legal_entities (org_id,id,biz_kind,crn,needs_confirmation,created_change_mode) \
           VALUES ('{org}','{entity}','CORPORATION','{crn}',true,'MIGRATION'); \
         INSERT INTO legal_entity_revisions (org_id,legal_entity_id,version,command_id, \
           effective_from,name,display_name,incorporated_on,change_mode,reason_code,payload_digest,settings_snapshot) \
           VALUES ('{org}','{entity}',1,gen_random_uuid(),'{opens}','기준법인 {index}','기준법인 {index}', \
             '{opens}','MIGRATION','TEST',decode(repeat('00',32),'hex'),'{{}}'); \
         INSERT INTO workplaces (org_id,id,legal_entity_id,needs_confirmation,created_change_mode) \
           VALUES ('{org}','{workplace}','{entity}',true,'MIGRATION'); \
         INSERT INTO workplace_revisions (org_id,workplace_id,version,command_id,effective_from, \
           name,opened_on,status,change_mode,reason_code,payload_digest,settings_snapshot) \
           VALUES ('{org}','{workplace}',1,gen_random_uuid(),'{opens}','사업장 {index}','{opens}', \
             'CONTINUING','MIGRATION','TEST',decode(repeat('00',32),'hex'),'{{}}'); \
         INSERT INTO org_units (org_id,id) VALUES ('{org}','{site}'),('{org}','{department}'); \
         INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) \
           VALUES ('{org}','{site}',1,gen_random_uuid(),'{actor}',decode(repeat('00',32),'hex'), \
             '{{\"kind\":\"site\",\"name\":\"사업장 {index}\",\"effective_from\":\"{opens}\"}}','{{}}'), \
           ('{org}','{department}',1,gen_random_uuid(),'{actor}',decode(repeat('00',32),'hex'), \
             '{{\"kind\":\"department\",\"name\":\"부서 {index}\",\"parent_id\":\"{site}\",\"effective_from\":\"{opens}\"}}','{{}}'); \
         INSERT INTO org_unit_placements (org_id,org_unit_id,legal_entity_id,workplace_id, \
           represents_workplace,valid_from,change_mode,command_id) \
           VALUES ('{org}','{site}','{entity}','{workplace}',true,'{opens}','MIGRATION',gen_random_uuid())"
    )))
    .execute(tx.as_mut())
    .await
    .unwrap();
    Group {
        entity,
        workplace,
        department,
    }
}

async fn person(
    tx: &mut Transaction<'_, Postgres>,
    c: &Ctx,
    g: &Group,
    number: &str,
    hire: Date,
    last: Option<Date>,
    status: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO employees (org_id,id,company,name,employee_number,hire_date,hire_on, \
         exit_date,exit_on,employment_status,org_unit_id,source_filename,source_sheet,source_row,source_key) \
         VALUES ($1,$2,'기준법인',$3,$3,$4::date::text,$4,$5::date::text,$5,$6,$7,'test','test',1,$2::text)",
    )
    .bind(c.org).bind(id).bind(number).bind(hire).bind(last).bind(status).bind(g.department)
    .execute(tx.as_mut()).await.unwrap();
    sqlx::query(
        "INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id, \
         valid_from,valid_to,cause,actor_id,command_id) VALUES ($1,$2,$3,$4,$5,$6,'HIRE',$7,$8)",
    )
    .bind(c.org)
    .bind(id)
    .bind(g.entity)
    .bind(g.workplace)
    .bind(hire)
    .bind(last.and_then(Date::next_day))
    .bind(*c.user.as_uuid())
    .bind(Uuid::new_v4())
    .execute(tx.as_mut())
    .await
    .unwrap();
    if let Some(last) = last {
        sqlx::query(
            "INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,from_status, \
             to_status,from_org_unit_id,from_org_unit,effective_date,comment,created_by,state) \
             VALUES ($1,$2,'TERMINATE','ACTIVE','EXITED',$3,$3::text,$4::date::text, \
               '마지막 근무일 검증',$5,$6)",
        )
        .bind(c.org)
        .bind(id)
        .bind(g.department)
        .bind(last)
        .bind(*c.user.as_uuid())
        .bind(if status == "EXITED" {
            "APPLIED"
        } else {
            "SCHEDULED"
        })
        .execute(tx.as_mut())
        .await
        .unwrap();
    }
    if status == "ON_LEAVE" {
        sqlx::query(
            "INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,from_status, \
             to_status,from_org_unit_id,to_org_unit_id,effective_date,leave_type,comment,created_by,state) \
             VALUES ($1,$2,'LEAVE_OF_ABSENCE','ACTIVE','ON_LEAVE',$3,$3,$4::date::text, \
               'PERSONAL','휴직 시작 검증',$5,'APPLIED')",
        )
        .bind(c.org).bind(id).bind(g.department).bind(hire + Duration::days(10))
        .bind(*c.user.as_uuid()).execute(tx.as_mut()).await.unwrap();
    }
    id
}

async fn get(c: &Ctx, path: &str) -> Value {
    let (status, body) = c.call("GET", path, None).await;
    assert_eq!(status, StatusCode::OK, "{path}: {body}");
    body
}

fn node(nodes: &Value, id: Uuid) -> Option<&Value> {
    nodes.as_array()?.iter().find_map(|n| {
        if n["id"] == json!(id) {
            Some(n)
        } else {
            node(&n["children"], id)
        }
    })
}

fn ids(members: &Value) -> Vec<Uuid> {
    let mut ids = members["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["employeeId"].as_str().unwrap().parse().unwrap())
        .collect::<Vec<_>>();
    ids.sort();
    ids
}

async fn parity(c: &Ctx, groups: &[Group; 2], on: Date, expected: &[Vec<Uuid>; 2], live: bool) {
    let query = if live {
        String::new()
    } else {
        format!("?as_of={on}")
    };
    let chart = get(c, &format!("/api/v1/org-structure{query}")).await;
    let cards = get(c, &format!("/api/v1/legal-entities{query}")).await;
    let diff = get(c, &format!("/api/v1/org-structure/diff?a={on}&b={on}")).await;
    for (g, expected) in groups.iter().zip(expected) {
        let total = expected.len() as i64;
        for snapshot in [&chart, &diff["structure"]] {
            for id in [g.entity, g.workplace, g.department] {
                assert_eq!(
                    node(&snapshot["entities"], id).map_or(0, |n| n["headcount"].as_i64().unwrap()),
                    total,
                    "node {id} at {on}: {snapshot}"
                );
            }
        }
        let card = cards["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == json!(g.entity))
            .unwrap();
        assert_eq!(card["regular_workers"]["live_headcount"], total);
        let workplace = get(c, &format!("/api/v1/workplaces/{}{query}", g.workplace)).await;
        assert_eq!(workplace["headcount"], total);
        assert_eq!(workplace["regular_workers"]["live_headcount"], total);
        let path = format!(
            "/api/v1/org-structure/units/{}/members{query}",
            g.department
        );
        if node(&chart["entities"], g.department).is_none() {
            let (status, _) = c.call("GET", &path, None).await;
            assert_eq!(status, StatusCode::NOT_FOUND);
        } else {
            let members = get(c, &path).await;
            assert_eq!(members["headcount"], total);
            assert_eq!(
                node(&chart["entities"], g.department).unwrap()["direct_headcount"],
                total
            );
            let mut expected = expected.clone();
            expected.sort();
            assert_eq!(ids(&members), expected, "members at {on}");
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn all_authorized_http_snapshots_share_exit_hire_and_workplace_boundaries(pool: PgPool) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let c = ctx(&pool, org, user, ADMIN, None).await;
    let today = Date::parse(&today_kst(), &Iso8601::DATE).unwrap();
    let d = today - Duration::days(2);
    let hired = today - Duration::days(30);
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    let groups = [
        group(&mut tx, &c, 0, hired).await,
        group(&mut tx, &c, 1, d).await,
    ];
    let a = &groups[0];
    let active = person(&mut tx, &c, a, "ACTIVE", hired, None, "ACTIVE").await;
    let leave = person(&mut tx, &c, a, "LEAVE", hired, None, "ON_LEAVE").await;
    let exit_d = person(&mut tx, &c, a, "EXIT-D", hired, Some(d), "EXITED").await;
    let exit_before = person(
        &mut tx,
        &c,
        a,
        "EXIT-BEFORE",
        hired,
        Some(d - Duration::days(1)),
        "EXITED",
    )
    .await;
    person(
        &mut tx,
        &c,
        a,
        "FUTURE",
        today + Duration::days(2),
        None,
        "PRE_HIRE",
    )
    .await;
    let exit_today = person(&mut tx, &c, a, "EXIT-TODAY", hired, Some(today), "ACTIVE").await;
    let legacy = person(
        &mut tx,
        &c,
        &groups[1],
        "BEFORE-OPEN",
        hired,
        None,
        "ACTIVE",
    )
    .await;
    let new = person(
        &mut tx,
        &c,
        &groups[1],
        "HIRED-AFTER",
        d + Duration::days(1),
        None,
        "ACTIVE",
    )
    .await;
    tx.commit().await.unwrap();
    for (on, expected) in [
        (
            d - Duration::days(1),
            [vec![active, leave, exit_d, exit_before, exit_today], vec![]],
        ),
        (d, [vec![active, leave, exit_d, exit_today], vec![legacy]]),
        (
            d + Duration::days(1),
            [vec![active, leave, exit_today], vec![legacy, new]],
        ),
        (today, [vec![active, leave, exit_today], vec![legacy, new]]),
    ] {
        parity(&c, &groups, on, &expected, false).await;
        if on == today {
            parity(&c, &groups, on, &expected, true).await;
        }
    }
    let uri = format!(
        "/api/v1/org-structure/units/{}/members?as_of=2026-02-30",
        groups[0].department
    );
    let (status, body) = c.call("GET", &uri, None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"]["code"], "validation_failed");
    let (other_org, other_user) = tenant(&pool, ADMIN).await;
    let other = ctx(&pool, other_org, other_user, ADMIN, None).await;
    let uri = format!(
        "/api/v1/org-structure/units/{}/members?as_of={today}",
        groups[0].department
    );
    let (status, body) = other.call("GET", &uri, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert!(!body.to_string().contains(&active.to_string()));
}
