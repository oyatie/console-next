//! Transient branches retain their in-scope changes even when both endpoints match.
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn comparison_keeps_in_scope_create_and_dissolve_between_identical_endpoints(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "asof-transient-compare").await;
    let today: Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(&owner)
        .await
        .unwrap();
    // Parent records already exist at A; only the department lives between A and B.
    let mut input = corporation("Existing Corp", "000211-0006241");
    input.incorporated_on = Some("2000-01-01".into());
    let entity = store
        .create_entity(&cmd(&actor), input)
        .await
        .unwrap()
        .record
        .id;
    let registration = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    let mut workplaces = Vec::new();
    for name in ["HQ", "Plant"] {
        workplaces.push(
            store
                .create_workplace(
                    &cmd(&actor),
                    entity,
                    workplace_from(registration, name),
                    port(),
                )
                .await
                .unwrap()
                .record,
        );
    }
    let (hq, hq_site, plant) = (
        workplaces[0].id,
        workplaces[0].org_unit_id.unwrap(),
        workplaces[1].id,
    );
    let setup = store
        .apply_org_setup_batch(&cmd(&actor), vec![under_workplace("a", "A", hq)], port())
        .await
        .unwrap();
    let unit = setup.units[0].org_unit_id;
    let dissolve = today + Duration::days(5);
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(actor.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    port()
        .write(
            &mut tx,
            actor.org,
            actor.user,
            Uuid::new_v4(),
            Some(unit),
            json!({"name":"A","kind":"department","parent_id":hq_site,
                "status":"dissolved","effective_from":dissolve.to_string()}),
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();
    request(
        &owner,
        &actor,
        unit,
        today,
        "OC-2026-0001",
        json!([{"op":"CREATE_ORG_UNIT","kind":"DEPARTMENT","parentId":hq_site,"name":"A"}]),
        "APPLIED",
    )
    .await;
    request(
        &owner,
        &actor,
        unit,
        dissolve,
        "OC-2026-0002",
        json!([{"op":"DISSOLVE_ORG_UNIT","orgUnitId":unit}]),
        "APPLIED",
    )
    .await;
    let scoped = Actor {
        scope: EntityScope::Only(vec![hq]),
        ..actor.clone()
    };
    let a = today - Duration::days(1);
    let b = today + Duration::days(10);
    for date in [a, b] {
        let endpoint = store
            .org_structure_at(
                &scoped,
                ReadOptions {
                    as_of: Some(date),
                    known_at: None,
                },
            )
            .await
            .unwrap();
        assert!(!nodes(&endpoint).contains_key(&unit));
    }
    let intermediate = store
        .org_structure_at(
            &scoped,
            ReadOptions {
                as_of: Some(today),
                known_at: None,
            },
        )
        .await
        .unwrap();
    assert!(nodes(&intermediate).contains_key(&unit));
    let diff = store
        .structure_diff(&scoped, a, b, ReadOptions::default())
        .await
        .unwrap();
    assert!(diff.marks.is_empty(), "the endpoint trees are unchanged");
    assert_eq!(
        diff.changes
            .iter()
            .map(|c| c.code.as_str())
            .collect::<Vec<_>>(),
        ["OC-2026-0001", "OC-2026-0002"],
        "both changes belonged to HQ at their event dates"
    );
    let hidden = Actor {
        scope: EntityScope::Only(vec![plant]),
        ..actor
    };
    let hidden_diff = store
        .structure_diff(&hidden, a, b, ReadOptions::default())
        .await
        .unwrap();
    assert!(hidden_diff.marks.is_empty());
    assert!(
        hidden_diff.changes.is_empty(),
        "Plant cannot read HQ changes"
    );
}
