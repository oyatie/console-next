// SPDX-License-Identifier: LicenseRef-Proprietary
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn live_chart_keeps_committed_units_when_the_database_clock_moves_back(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "chart-clock").await;
    // Cross a KST midnight deliberately. The site and department commands supply effective_from;
    // the placement supplies valid_from. Only the recording timestamps are advanced.
    sqlx::raw_sql(
        "ALTER TABLE org_units ALTER COLUMN created_at SET DEFAULT (now() + interval '1 day');
         ALTER TABLE org_unit_revisions ALTER COLUMN created_at SET DEFAULT (now() + interval '1 day');
         ALTER TABLE org_unit_placements ALTER COLUMN created_at SET DEFAULT (now() + interval '1 day');
         ALTER TABLE employees ALTER COLUMN created_at SET DEFAULT (now() + interval '1 day');",
    )
    .execute(&owner)
    .await
    .unwrap();
    let (entity, [(workplace, site), _]) = two_workplaces(&store, &actor).await;
    let batch = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![under_workplace("new", "New department", workplace)],
            port(),
        )
        .await
        .unwrap();
    let unit = batch.units[0].org_unit_id;
    person(&owner, &store, &actor, (entity, workplace, unit), "clock").await;
    let d = today(&owner).await;
    let later = d + Duration::days(7);
    revise_unit(&owner, &actor, unit, json!({"kind":"department","status":"active","name":"Next name","parent_id":site,"effective_from":later.to_string()})).await;
    let cutoff = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&owner)
        .await
        .unwrap();

    for (known_at, expected) in [(Some(cutoff), false), (None, true)] {
        let options = ReadOptions {
            as_of: None,
            known_at,
        };
        let tree = store.org_structure_at(&actor, options).await.unwrap();
        let workplace_node = tree.entities[0]
            .children
            .iter()
            .find(|n| n.id == workplace)
            .unwrap();
        assert_eq!(workplace_node.org_unit_id, expected.then_some(site));
        let department = workplace_node.children.iter().find(|n| n.id == unit);
        assert_eq!(
            department.map(|n| (n.name.as_str(), n.headcount)),
            expected.then_some(("New department", 1))
        );
        let dates = store
            .structure_change_dates(&actor, d, later, options)
            .await
            .unwrap();
        assert_eq!(dates.contains(&later.to_string()), expected);
    }
    let future = read(&store, &actor, later).await;
    assert!(
        future.entities[0]
            .children
            .iter()
            .flat_map(|w| &w.children)
            .any(|n| n.id == unit && n.name == "Next name")
    );
}
