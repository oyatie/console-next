// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use console_entity_application::ReadOptions;
use console_ontology_canonical_adapter_postgres::{employment, org_unit};
use console_ontology_canonical_domain::CommandId;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Date, Month, macros::offset};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn member_since_follows_the_winning_dated_membership_and_never_guesses_hire(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "members-since").await;
    let (entity, [(workplace, site), _]) = two_workplaces(&store, &actor).await;
    let batch = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![
                under_workplace("a", "A", workplace),
                under_workplace("b", "B", workplace),
            ],
            port(),
        )
        .await
        .unwrap();
    let [a, b] = [batch.units[0].org_unit_id, batch.units[1].org_unit_id];
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(actor.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    for (id, kind, parent) in [
        (site, "site", None),
        (a, "department", Some(site)),
        (b, "department", Some(site)),
    ] {
        org_unit::write_in_tx(&mut tx, &org_unit::OrgUnitCommand {
            org_id: actor.org, actor_id: actor.user, command_id: CommandId::from_uuid(Uuid::new_v4()),
            query: org_unit::OrgUnitQuery::Revise { org_unit_id: id, source: None,
                attributes: json!({"name":kind,"kind":kind,"parent_id":parent,"status":"active","effective_from":"2026-01-01"}) },
            action_key: "internal.setup.test_org_unit".into(), object_type_id: Uuid::nil(),
        }).await.unwrap();
    }
    tx.commit().await.unwrap();
    let p = person(&owner, &store, &actor, (entity, workplace, a), "moving").await;
    sqlx::query("UPDATE employees SET hire_date='2026-01-02' WHERE id=$1")
        .bind(p)
        .execute(&owner)
        .await
        .unwrap();
    let read = |unit, day| {
        let (store, actor) = (&store, &actor);
        async move {
            serde_json::to_value(
                store
                    .structure_members_at(
                        actor,
                        unit,
                        ReadOptions {
                            as_of: Some(Date::from_calendar_date(2026, Month::March, day).unwrap()),
                            known_at: None,
                        },
                    )
                    .await
                    .unwrap(),
            )
            .unwrap()
        }
    };
    assert!(
        read(a, 1).await["items"][0].get("since").is_none(),
        "setup membership has no dated source"
    );
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,from_status,to_status, \
        from_org_unit_id,to_org_unit_id,from_org_unit,to_org_unit,effective_date,comment,created_by,state) \
        VALUES ($1,$2,'TRANSFER','ACTIVE','ACTIVE',$3,$4,$3::text,$4::text,'2026-03-02','Transfer',$5,'APPLIED')")
        .bind(*actor.org.as_uuid()).bind(p).bind(a).bind(b).bind(*actor.user.as_uuid()).execute(&owner).await.unwrap();
    let before = read(a, 1).await;
    assert_eq!(before["items"][0]["employeeId"], p.to_string());
    assert!(before["items"][0].get("since").is_none());
    assert_eq!(read(b, 1).await["headcount"], 0);
    assert_eq!(read(a, 2).await["headcount"], 0);
    assert_eq!(read(b, 2).await["items"][0]["since"], "2026-03-02");

    // A later native revision wins by the same date/recording order as the unit itself (KST business date).
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(actor.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    employment::write_in_tx(
        &mut tx,
        &employment::EmploymentCommand {
            org_id: actor.org,
            actor_id: actor.user,
            command_id: CommandId::from_uuid(Uuid::new_v4()),
            query: employment::EmploymentQuery::Appoint {
                employee_id: p,
                valid_from: Date::from_calendar_date(2026, Month::March, 3)
                    .unwrap()
                    .midnight()
                    .assume_offset(offset!(+9)),
                attributes: employment::EmploymentAttributes {
                    company: "주식회사 가나".into(),
                    org_unit_id: Some(a),
                    job_position_id: None,
                    employment_status: "ACTIVE".into(),
                },
            },
            action_key: "internal.setup.test_employment".into(),
            object_type_id: Uuid::nil(),
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(read(a, 3).await["items"][0]["since"], "2026-03-03");
    assert_eq!(read(b, 3).await["headcount"], 0);
    assert_eq!(
        read(b, 2).await["items"][0]["since"],
        Value::String("2026-03-02".into())
    );
}
