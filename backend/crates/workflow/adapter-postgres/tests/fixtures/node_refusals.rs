use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_or_foreign_emission_links_leave_no_effects(pool: PgPool) {
    let (store, org, commit) = fixture(&pool, false).await;
    let before = counts(&pool).await;
    for link in [None, Some(Uuid::new_v4())] {
        let mut changed = commit.clone();
        changed.emissions[0].node_run_id = link;
        let error = scope_org(org, store.commit_node_step(org, changed))
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Conflict);
        assert_eq!(counts(&pool).await, before);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn malformed_node_links_and_stale_run_transition_leave_no_effects(pool: PgPool) {
    let (store, org, commit) = fixture(&pool, true).await;
    let before = counts(&pool).await;
    for shape in [
        "missing_node",
        "foreign_node",
        "foreign_task_run",
        "foreign_transition",
        "stale",
    ] {
        let mut changed = commit.clone();
        match shape {
            "missing_node" => changed.waiting_task.as_mut().unwrap().node_run_id = None,
            "foreign_node" => {
                changed.waiting_task.as_mut().unwrap().node_run_id = Some(Uuid::new_v4())
            }
            "foreign_task_run" => changed.waiting_task.as_mut().unwrap().run_id = Uuid::new_v4(),
            _ => {
                changed.run_transition = Some(RunTransition {
                    run_id: if shape == "foreign_transition" {
                        Uuid::new_v4()
                    } else {
                        commit.new_node.run_id
                    },
                    from: RunStatus::Waiting,
                    to: RunStatus::Running,
                    output_payload: None,
                    error_payload: None,
                })
            }
        }
        let error = scope_org(org, store.commit_node_step(org, changed))
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Conflict, "{shape}");
        assert_eq!(counts(&pool).await, before, "{shape}");
    }
}
