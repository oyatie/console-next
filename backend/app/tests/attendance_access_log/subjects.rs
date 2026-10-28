// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scope_reads_of_the_reader_and_other_user_only_accounts_are_not_self_reads(pool: PgPool) {
    let (admin, cases) = scopes::cases(&pool).await;
    let people: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM employees WHERE org_id=$1 ORDER BY employee_number")
            .bind(admin.org)
            .fetch_all(&pool)
            .await
            .unwrap();
    let canceller: Uuid = sqlx::query_scalar("SELECT cancelled_by FROM attendance_schedule_layers WHERE org_id=$1 AND cancelled_by IS NOT NULL LIMIT 1")
        .bind(admin.org).fetch_one(&pool).await.unwrap();
    sqlx::query("UPDATE users SET employee_id=$1 WHERE org_id=$2 AND id=$3")
        .bind(people[0])
        .bind(admin.org)
        .bind(admin.user.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    for (path, action, mut expected) in cases {
        if matches!(action, "attendance.layers_read" | "attendance.closes_read")
            && !path.contains("2026-09")
        {
            expected.push(people[0].to_string());
        }
        expected.sort();
        expected.dedup();
        let before = scopes::count(&pool, admin.org, action).await;
        let start = OffsetDateTime::now_utc();
        let (status, body) = read(&admin, &path, &admin.token).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        assert_eq!(scopes::count(&pool, admin.org, action).await, before + 1);
        scopes::assert_event(
            &pool,
            admin.org,
            action,
            *admin.user.as_uuid(),
            &expected,
            start,
            "TENANT_USER",
        )
        .await;
        let after: Value = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action=$2 ORDER BY occurred_at DESC,id DESC LIMIT 1")
            .bind(admin.org).bind(action).fetch_one(&pool).await.unwrap();
        assert_eq!(after["self_read"], false, "{path}: {after}");
        for user in [*admin.user.as_uuid(), canceller] {
            assert!(
                !after["subject_ids"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(user))
            );
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reads_covering_the_reader_and_other_people_are_not_self_reads(pool: PgPool) {
    let (admin, cases) = scopes::cases(&pool).await;
    let reader: Uuid = sqlx::query_scalar(
        "SELECT id FROM employees WHERE org_id=$1 ORDER BY employee_number LIMIT 1",
    )
    .bind(admin.org)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE users SET employee_id=$1 WHERE org_id=$2 AND id=$3")
        .bind(reader)
        .bind(admin.org)
        .bind(admin.user.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    for action in [
        "attendance.schedule_tree_read",
        "org_unit.read",
        "org_unit.members_read",
    ] {
        let (path, _, expected) = cases.iter().find(|(_, task, _)| *task == action).unwrap();
        assert!(expected.contains(&reader.to_string()) && expected.len() > 1);
        let before = scopes::count(&pool, admin.org, action).await;
        let started = OffsetDateTime::now_utc();
        let (status, body) = read(&admin, path, &admin.token).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        assert_eq!(scopes::count(&pool, admin.org, action).await, before + 1);
        scopes::assert_event(
            &pool,
            admin.org,
            action,
            *admin.user.as_uuid(),
            expected,
            started,
            "TENANT_USER",
        )
        .await;
        let after: Value = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action=$2 ORDER BY occurred_at DESC,id DESC LIMIT 1")
            .bind(admin.org).bind(action).fetch_one(&pool).await.unwrap();
        assert_eq!(after["self_read"], false, "{path}: {after}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn close_subjects_resolve_linked_accounts_and_keep_user_only_principals_typed(pool: PgPool) {
    let (admin, cases) = scopes::cases(&pool).await;
    let person: Uuid = sqlx::query_scalar(
        "SELECT id FROM employees WHERE org_id=$1 ORDER BY employee_number LIMIT 1",
    )
    .bind(admin.org)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2 AND org_id=$3")
        .bind(person)
        .bind(admin.user.as_uuid())
        .bind(admin.org)
        .execute(&pool)
        .await
        .unwrap();
    let (path, action, _) = cases
        .iter()
        .find(|(_, action, _)| *action == "attendance.closes_read")
        .unwrap();
    let before = scopes::count(&pool, admin.org, action).await;
    let start = OffsetDateTime::now_utc();
    let (status, body) = read(&admin, path, &admin.token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(scopes::count(&pool, admin.org, action).await, before + 1);
    scopes::assert_event(
        &pool,
        admin.org,
        action,
        *admin.user.as_uuid(),
        &[person.to_string()],
        start,
        "TENANT_USER",
    )
    .await;
    let after: Value = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action=$2 ORDER BY occurred_at DESC,id DESC LIMIT 1")
        .bind(admin.org).bind(action).fetch_one(&pool).await.unwrap();
    let mut users: Vec<Uuid> = serde_json::from_value(after["user_subject_ids"].clone()).unwrap();
    users.sort();
    let expected: Vec<Uuid> = sqlx::query_scalar("SELECT DISTINCT a.actor_user_id FROM attendance_close_amendments a JOIN users u ON u.id=a.actor_user_id AND u.org_id=a.org_id WHERE a.org_id=$1 AND u.employee_id IS NULL ORDER BY a.actor_user_id")
        .bind(admin.org).fetch_all(&pool).await.unwrap();
    assert_eq!(users, expected);
    assert_eq!(users.len(), 1, "only the unlinked amendment actor");
    assert_eq!(after["self_read"], false);
    assert!(after.get("employee_subject_ids").is_none());

    sqlx::query("INSERT INTO attendance_month_closes(org_id,month,checks,attested_by,branch_id) SELECT org_id,'2026-09-01',checks,attested_by,branch_id FROM attendance_month_closes WHERE org_id=$1 LIMIT 1")
        .bind(admin.org).execute(&pool).await.unwrap();
    for linked in [true, false] {
        sqlx::query("UPDATE users SET employee_id=$1 WHERE org_id=$2 AND id=$3")
            .bind(linked.then_some(person))
            .bind(admin.org)
            .bind(admin.user.as_uuid())
            .execute(&pool)
            .await
            .unwrap();
        let before = scopes::count(&pool, admin.org, action).await;
        let (status, body) = read(&admin, &path.replace("2026-10", "2026-09"), &admin.token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(scopes::count(&pool, admin.org, action).await, before + 1);
        let after: Value = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action=$2 ORDER BY occurred_at DESC,id DESC LIMIT 1")
            .bind(admin.org).bind(action).fetch_one(&pool).await.unwrap();
        assert_eq!(
            after["subject_ids"],
            if linked { json!([person]) } else { json!([]) }
        );
        assert_eq!(after["subject_count"], usize::from(linked));
        assert_eq!(
            after["user_subject_ids"],
            if linked {
                json!([])
            } else {
                json!([admin.user])
            }
        );
        assert_eq!(after["self_read"], true, "only the reader, linked={linked}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn org_unit_read_names_historical_heads_outside_the_member_set_once(pool: PgPool) {
    let (admin, people) = world(&pool).await;
    let workplace: Uuid = sqlx::query_scalar(
        "SELECT workplace_id FROM employment_assignments WHERE employee_id=$1 LIMIT 1",
    )
    .bind(Uuid::parse_str(&people[0]).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    let (status, created) = admin
        .call(
            "POST",
            "/api/v1/org-structure/units",
            Some(json!({
                "kind":"DEPARTMENT", "name":"부서장 접속기록", "workplace_id":workplace
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let unit = Uuid::parse_str(created["id"].as_str().unwrap()).unwrap();
    // Heads can belong to another unit and appear in several revisions.
    for person in [&people[0], &people[1], &people[0]] {
        sqlx::query("INSERT INTO org_unit_revisions(org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) SELECT org_id,org_unit_id,version+1,gen_random_uuid(),actor_id,payload_digest,attributes || jsonb_build_object('head_employee_id',$2::text),receipt FROM org_unit_revisions WHERE org_unit_id=$1 ORDER BY version DESC LIMIT 1")
            .bind(unit).bind(person).execute(&pool).await.unwrap();
    }
    let start = OffsetDateTime::now_utc();
    let before = scopes::count(&pool, admin.org, "org_unit.read").await;
    let (status, body) = read(&admin, &format!("/api/v1/org-units/{unit}"), &admin.token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["members"]["items"].as_array().unwrap().is_empty());
    assert_eq!(
        body["revisions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["headEmployeeId"].is_string())
            .count(),
        3
    );
    assert_eq!(
        scopes::count(&pool, admin.org, "org_unit.read").await,
        before + 1
    );
    scopes::assert_event(
        &pool,
        admin.org,
        "org_unit.read",
        *admin.user.as_uuid(),
        &people,
        start,
        "TENANT_USER",
    )
    .await;
}
