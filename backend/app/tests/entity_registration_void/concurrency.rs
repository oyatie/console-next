// SPDX-License-Identifier: LicenseRef-Proprietary

async fn blocked_pid(pool: &PgPool, blocker: i32) -> i32 {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let pid: Option<i32> = sqlx::query_scalar(
                "SELECT pid FROM pg_stat_activity WHERE datname = current_database() \
                 AND $1 = ANY(pg_blocking_pids(pid)) LIMIT 1",
            )
            .bind(blocker)
            .fetch_optional(pool)
            .await
            .unwrap();
            if let Some(pid) = pid {
                return pid;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("request must reach the coordinated database lock")
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_serializes_with_workplace_creation(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let creator = ctx(&pool, org, owner, ADMIN, None).await;
    let voider = ctx(
        &pool,
        org,
        owner,
        ADMIN,
        Some("SET test.registration_void_barrier = 'on'"),
    )
    .await;
    let reg = create_unattached_registration(&creator, "000-81-00010").await;
    let reg_id = Uuid::parse_str(&reg).unwrap();
    let entity: Uuid =
        sqlx::query_scalar("SELECT legal_entity_id FROM business_registrations WHERE id = $1")
            .bind(reg_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    // Pause void after its in-use check, before UPDATE takes a registration row lock.
    sqlx::raw_sql(
        "CREATE FUNCTION test_pause_registration_void() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF current_setting('test.registration_void_barrier', true) = 'on' THEN
                PERFORM pg_advisory_xact_lock(2713);
            END IF;
            RETURN NULL;
        END $$;
        CREATE TRIGGER test_pause_registration_void BEFORE UPDATE ON business_registrations
        FOR EACH STATEMENT EXECUTE FUNCTION test_pause_registration_void();",
    )
    .execute(&pool)
    .await
    .unwrap();
    let mut barrier = pool.begin().await.unwrap();
    let barrier_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *barrier)
        .await
        .unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(2713)")
        .execute(&mut *barrier)
        .await
        .unwrap();
    let workplaces = format!("/api/v1/legal-entities/{entity}/workplaces");
    let void_uri = format!("/api/v1/business-registrations/{reg}/void");
    let workplace_body = json!({
        "name": "본사", "registration_id": reg, "same_address_as_registration": true,
        "opened_on": "2020-03-02", "is_head_office": true, "kind_code": "HEAD_OFFICE",
        "insurance": { "shortcut": "ALL_ESTABLISHED_NUMBERS_LATER" },
    });
    let (voided, created) = tokio::join!(
        voider.call("POST", &void_uri, Some(json!({ "reason_code": "MISTAKE" }))),
        async {
            let voider_pid = blocked_pid(&pool, barrier_pid).await;
            let create = creator.call("POST", &workplaces, Some(workplace_body));
            tokio::pin!(create);
            let completed = tokio::select! {
                response = &mut create => Some(response),
                _ = blocked_pid(&pool, voider_pid) => None,
            };
            barrier.rollback().await.unwrap();
            match completed {
                Some(response) => response,
                None => create.await,
            }
        }
    );
    let orphans: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workplaces w JOIN business_registrations r ON r.id = w.registration_id \
         WHERE r.id = $1 AND r.voided_at IS NOT NULL AND w.voided_at IS NULL",
    ).bind(reg_id).fetch_one(&pool).await.unwrap();
    assert_eq!(
        orphans, 0,
        "concurrent create ({}) and void ({}) left an active workplace under voided registration {reg}",
        created.0, voided.0
    );
    if created.0 == StatusCode::CREATED {
        assert_eq!(voided.0, StatusCode::CONFLICT, "{:?}", voided.1);
        assert_eq!(code(&voided.1), "record_in_use");
    } else {
        assert_eq!(voided.0, StatusCode::NO_CONTENT, "{:?}", voided.1);
        assert_eq!(
            created.0,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{:?}",
            created.1
        );
        assert!(
            refusals::field_codes(&created.1)
                .contains(&("registration_id".into(), "registration_not_found".into())),
            "{:?}",
            created.1
        );
    }
}
