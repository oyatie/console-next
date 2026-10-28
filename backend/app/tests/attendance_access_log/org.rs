// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

type ReadCase = (String, &'static str, Vec<String>, Vec<Uuid>);

async fn cases(pool: &PgPool) -> (Ctx, Vec<ReadCase>) {
    let (admin, people) = world(pool).await;
    let unit: Uuid = sqlx::query_scalar("SELECT org_unit_id FROM employees WHERE id=$1")
        .bind(Uuid::parse_str(&people[0]).unwrap())
        .fetch_one(pool)
        .await
        .unwrap();
    let workplace: Uuid = sqlx::query_scalar(
        "SELECT workplace_id FROM employment_assignments WHERE employee_id=$1 LIMIT 1",
    )
    .bind(Uuid::parse_str(&people[0]).unwrap())
    .fetch_one(pool)
    .await
    .unwrap();
    let (status, destination) = admin
        .call(
            "POST",
            "/api/v1/org-structure/units",
            Some(json!({
                "kind":"DEPARTMENT", "name":"접속기록 부서", "workplace_id":workplace
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{destination}");
    sqlx::query("INSERT INTO org_unit_revisions(org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) SELECT org_id,org_unit_id,version+1,gen_random_uuid(),actor_id,payload_digest,attributes || jsonb_build_object('head_employee_id',$2::text),receipt FROM org_unit_revisions WHERE org_unit_id=$1 ORDER BY version DESC LIMIT 1")
        .bind(Uuid::parse_str(destination["id"].as_str().unwrap()).unwrap()).bind(&people[1]).execute(pool).await.unwrap();
    let (status, change) = admin.call("POST", "/api/v1/org-changes", Some(json!({
        "kind":"REORG", "target":{"kind":"ORG_UNIT","ref":unit,"label":"접속기록"},
        "effectiveDate":support::today_kst(), "reason":"접속기록 확인",
        "proposal":[{"op":"REASSIGN_ORG_UNIT","fromOrgUnit":unit,"toOrgUnit":destination["id"],
            "scope":{"company":"주식회사 가나"},"employeeIds":[people[0],people[0]]}]
    }))).await;
    assert_eq!(status, StatusCode::CREATED, "{change}");
    let actor = *admin.user.as_uuid();
    let linked = support::add_user(pool, admin.org, &["EXECUTIVE"]).await;
    let unlinked = support::add_user(pool, admin.org, &["ADMIN"]).await;
    sqlx::query("UPDATE users SET employee_id=$1 WHERE org_id=$2 AND id=$3")
        .bind(Uuid::parse_str(&people[1]).unwrap())
        .bind(admin.org)
        .bind(linked.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    let change_id = Uuid::parse_str(change["id"].as_str().unwrap()).unwrap();
    sqlx::query("INSERT INTO org_change_approval_steps(org_id,request_id,step_order,role_key,decision,decided_by,decided_at) VALUES($1,$2,1,'executive','APPROVED',$3,now())")
        .bind(admin.org).bind(change_id).bind(linked.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO org_change_settlement_items(org_id,request_id,item_key,done,done_by,done_at) VALUES($1,$2,'TRANSFER_EMPLOYEES',true,$3,now())")
        .bind(admin.org).bind(change_id).bind(unlinked.as_uuid()).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO org_change_events(org_id,request_id,actor,action) VALUES($1,$2,$3,'reviewed')",
    )
    .bind(admin.org)
    .bind(change_id)
    .bind(unlinked.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    let mut detail_users = vec![actor, *unlinked.as_uuid()];
    detail_users.sort_unstable();
    (
        admin,
        vec![
            (
                "/api/v1/org-changes?limit=1".into(),
                "org_change.list_read",
                vec![],
                vec![actor],
            ),
            (
                format!("/api/v1/org-changes/{}", change["id"].as_str().unwrap()),
                "org_change.read",
                people.clone(),
                detail_users,
            ),
            (
                "/api/v1/org-changes?offset=1".into(),
                "org_change.list_read",
                vec![],
                vec![],
            ),
            (
                "/api/v1/org-structure".into(),
                "org_structure.read",
                vec![people[1].clone()],
                vec![],
            ),
            (
                "/api/v1/org-units".into(),
                "org_unit.list_read",
                vec![],
                vec![],
            ),
        ],
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn org_reads_log_exact_subjects_once_with_actor_time_source_and_task(pool: PgPool) {
    let (admin, cases) = cases(&pool).await;
    let mut missing = Vec::new();
    for (path, action, subjects, users) in cases {
        let before = scopes::count(&pool, admin.org, action).await;
        let started = OffsetDateTime::now_utc();
        let (status, body) = read(&admin, &path, &admin.token).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        if scopes::count(&pool, admin.org, action).await != before + 1 {
            missing.push(path);
            continue;
        }
        scopes::assert_event(
            &pool,
            admin.org,
            action,
            *admin.user.as_uuid(),
            &subjects,
            started,
            "TENANT_USER",
        )
        .await;
        let after: Value = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action=$2 ORDER BY occurred_at DESC,id DESC LIMIT 1")
            .bind(admin.org).bind(action).fetch_one(&pool).await.unwrap();
        assert_eq!(after["user_subject_ids"], json!(users));
        assert_eq!(
            after["self_read"],
            subjects.is_empty() && users == [*admin.user.as_uuid()]
        );
        assert!(body.get("access_subject").is_none());
    }
    assert!(missing.is_empty(), "missing access records: {missing:?}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn org_reads_refuse_anonymous_and_withhold_data_when_logging_fails(pool: PgPool) {
    let (admin, cases) = cases(&pool).await;
    for (path, action, _, _) in &cases {
        let before = scopes::count(&pool, admin.org, action).await;
        let (status, body) = read(&admin, path, "").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}: {body}");
        assert_eq!(scopes::count(&pool, admin.org, action).await, before);
    }
    sqlx::query("REVOKE INSERT ON audit_events FROM console_rt")
        .execute(&pool)
        .await
        .unwrap();
    for (path, _, _, _) in cases {
        let (status, body) = read(&admin, &path, &admin.token).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{path}: {body}");
        assert_eq!(body["error"]["code"], "unavailable");
        assert!(body.get("items").is_none() && body.get("entities").is_none());
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn schedule_tree_counts_do_not_log_the_roster_as_returned_people(pool: PgPool) {
    let (admin, people) = world(&pool).await;
    let started = OffsetDateTime::now_utc();
    let before = scopes::count(&pool, admin.org, "attendance.schedule_tree_read").await;
    let (status, body) = read(&admin, "/api/v1/attendance/schedule/tree", &admin.token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["people_total"], people.len());
    assert_eq!(
        scopes::count(&pool, admin.org, "attendance.schedule_tree_read").await,
        before + 1
    );
    scopes::assert_event(
        &pool,
        admin.org,
        "attendance.schedule_tree_read",
        *admin.user.as_uuid(),
        &[],
        started,
        "TENANT_USER",
    )
    .await;
    let after: Value = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='attendance.schedule_tree_read'")
        .bind(admin.org).fetch_one(&pool).await.unwrap();
    assert_eq!(after["row_count"], people.len());
    assert_eq!(after["self_read"], false);
}
