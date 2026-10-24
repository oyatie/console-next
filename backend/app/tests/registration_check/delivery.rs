// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn original_attachment_keeps_the_current_revision_and_its_dates(pool: PgPool) {
    let (mut ctx, entity, id, keys) = context(&pool, None).await;
    let store = PgEntityStore::new(support::role_pool(&pool, "console_rt", None).await);
    let actor = console_entity_application::Actor {
        org: console_kernel_core::OrgId::from_uuid(ctx.org),
        user: ctx.user,
        trace: console_kernel_core::TraceContext::generate(),
        command_id: None,
        scope: console_entity_application::EntityScope::Tenant,
    };
    let upload = console_entity_domain::document::validate_upload(
        Some("BIZ_REG_CERT"),
        Some("original.pdf"),
        b"%PDF-1.4 original".to_vec(),
    )
    .unwrap();
    let doc = store.upload_document(&actor, upload).await.unwrap();
    let revision: Value = sqlx::query_scalar(
        "SELECT to_jsonb(r) FROM business_registration_revisions r WHERE registration_id=$1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let path = format!("/api/v1/business-registrations/{id}/original");
    let body = Some(json!({"document_id":doc.id}));
    let admin = ctx.token.clone();
    let reader = support::add_user(&pool, ctx.org, &["MEMBER"]).await;
    ctx.token = support::token(&pool, &keys, ctx.org, reader, &["MEMBER"]).await;
    assert_eq!(
        ctx.call("POST", &path, body.clone()).await.0,
        StatusCode::FORBIDDEN
    );
    ctx.token = admin;
    let (status, saved) = ctx.call("POST", &path, body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["registration_id"], id.to_string());
    assert_eq!(saved["legal_entity_id"], entity);
    let (retry_status, retry) = ctx.retry("POST", &path, body).await;
    assert!(
        retry == saved
            || (retry_status == StatusCode::CONFLICT
                && retry["error"]["code"] == "command_applied"),
        "{retry}"
    );
    let revisions: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(r) FROM business_registration_revisions r WHERE registration_id=$1",
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        revisions,
        vec![revision],
        "attaching an existing original creates no lifecycle event or revision"
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='entity_document.attach'",
    )
    .bind(ctx.org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn mismatch_reaches_only_the_holder_and_disappears_after_agreement(pool: PgPool) {
    let (ctx, entity, id, _) = context(&pool, Some(fake(CheckKind::Status, None))).await;
    let store = PgEntityStore::new(support::role_pool(&pool, "console_rt", None).await);
    let actor = console_entity_application::Actor {
        org: console_kernel_core::OrgId::from_uuid(ctx.org),
        user: ctx.user,
        trace: console_kernel_core::TraceContext::generate(),
        command_id: Some(Uuid::new_v4()),
        scope: console_entity_application::EntityScope::Tenant,
    };
    let mut answer = CheckAnswer::status(BRN, "02");
    answer.reported_status = Some(OperatingStatus::Suspended);
    answer.response_sha256 = "c".repeat(64);
    let check = store
        .check_registration(
            &actor,
            id,
            CheckKind::Status,
            Arc::new(FakeRegistrationCheck::configured(vec![answer])),
        )
        .await
        .unwrap();
    let inbox = "/api/v1/me/action-inbox";
    let holder = support::ctx(&pool, ctx.org, ctx.user, ADMIN, None).await;
    let (status, page) = holder.call("GET", inbox, None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let expected = format!("registration_check:{}", check.inbox_item_id.unwrap());
    let row = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == expected)
        .expect("the holder must receive the NTS mismatch");
    assert_eq!(row["links"][0]["kind"], "registration_check");
    assert_eq!(row["links"][0]["id"], format!("{entity}/{id}"));
    let member = support::add_user(&pool, ctx.org, &["MEMBER"]).await;
    let (other_org, other_user) = support::tenant(&pool, ADMIN).await;
    for (org, user, roles) in [
        (ctx.org, member, &["MEMBER"][..]),
        (other_org, other_user, ADMIN),
    ] {
        let other = support::ctx(&pool, org, user, roles, None).await;
        let (status, page) = other.call("GET", inbox, None).await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert!(
            !page["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["id"] == expected)
        );
    }
    let mut retry = actor.clone();
    retry.command_id = Some(Uuid::new_v4());
    store
        .check_registration(&retry, id, CheckKind::Status, fake(CheckKind::Status, None))
        .await
        .unwrap();
    let (_, page) = holder.call("GET", inbox, None).await;
    assert!(
        !page["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == expected)
    );
}
