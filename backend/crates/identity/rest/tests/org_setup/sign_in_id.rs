//! AUTH-ID (decisions #33; sign-in-identifier.md §7): the 아이디 at invite, its
//! governed change (reason, 기준일, audit), the old value kept as an alias that
//! search still finds, and never reissued, to anyone. A child of `org_setup`
//! (its harness and seeds), kept apart so the pinned parent file does not grow.

use super::*;

async fn invite(harness: &Harness, token: &str, body: Value) -> (StatusCode, Value) {
    send(harness, "POST", "/api/v1/users", token, Some(body)).await
}

async fn rename(harness: &Harness, token: &str, user: &str, body: Value) -> (StatusCode, Value) {
    send(
        harness,
        "POST",
        &format!("/api/v1/users/{user}/sign-in-id"),
        token,
        Some(body),
    )
    .await
}

async fn history(harness: &Harness, token: &str, user: &str) -> Vec<Value> {
    let (status, body) = send(
        harness,
        "GET",
        &format!("/api/v1/users/{user}/sign-in-ids"),
        token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["items"].as_array().unwrap().clone()
}

async fn renames_audited(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action = 'user.sign_in_id.change'")
        .fetch_one(pool)
        .await
        .unwrap()
}

fn today() -> String {
    // The server compares against the KST date; UTC+9 is never behind UTC.
    (OffsetDateTime::now_utc() - Duration::days(1))
        .date()
        .to_string()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_invite_sets_the_sign_in_id_or_takes_the_default(pool: PgPool) {
    let harness = Harness::new(pool.clone()).await;
    let ops = seed_user(&pool, "Ops", &["SUPER_ADMIN"], None).await;
    let token = harness.token(ops, &["SUPER_ADMIN"], vec![]).await;
    let slug: String = sqlx::query_scalar("SELECT slug FROM organizations WHERE id = $1")
        .bind(*OrgId::one().as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();

    let (status, named) = invite(
        &harness,
        &token,
        json!({ "display_name": "홍길동", "sign_in_id": " Hong.GilDong " }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{named}");
    assert_eq!(named["sign_in_id"], format!("hong.gildong@{slug}"));
    let (status, plain) = invite(&harness, &token, json!({ "display_name": "김기본" })).await;
    assert_eq!(status, StatusCode::CREATED, "{plain}");
    let default = plain["sign_in_id"].as_str().unwrap();
    assert!(
        default.starts_with('u') && default.ends_with(&format!("@{slug}")),
        "{default}"
    );

    // Refusals write nothing: no account, no audit row.
    let users = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users")
            .fetch_one(&pool)
            .await
            .unwrap()
    };
    let before = users().await;
    for (body, status, code) in [
        (
            json!({ "display_name": "중복", "sign_in_id": "hong.gildong" }),
            StatusCode::CONFLICT,
            "sign_in_id_taken",
        ),
        (
            json!({ "display_name": "한글", "sign_in_id": "홍길동" }),
            StatusCode::UNPROCESSABLE_ENTITY,
            "sign_in_id_invalid",
        ),
        (
            json!({ "display_name": "기호", "sign_in_id": "hong..kim" }),
            StatusCode::UNPROCESSABLE_ENTITY,
            "sign_in_id_invalid",
        ),
    ] {
        let (got, refused) = invite(&harness, &token, body).await;
        assert_eq!(
            (got, refused["error"]["code"].as_str()),
            (status, Some(code)),
            "{refused}"
        );
    }
    assert_eq!(users().await, before, "a refused invite creates no account");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_rename_keeps_the_old_id_as_an_alias_and_never_reissues_it(pool: PgPool) {
    let harness = Harness::new(pool.clone()).await;
    let ops = seed_user(&pool, "Ops", &["SUPER_ADMIN"], None).await;
    let token = harness.token(ops, &["SUPER_ADMIN"], vec![]).await;
    let (_, a) = invite(
        &harness,
        &token,
        json!({ "display_name": "김개명", "sign_in_id": "kim.old" }),
    )
    .await;
    let a = a["id"].as_str().unwrap().to_owned();
    let (_, b) = invite(
        &harness,
        &token,
        json!({ "display_name": "이다른", "sign_in_id": "lee" }),
    )
    .await;
    let b = b["id"].as_str().unwrap().to_owned();

    let (status, changed) = rename(
        &harness,
        &token,
        &a,
        json!({
            "login": "kim.new", "effective_date": today(), "reason_code": "NAME_CHANGE",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!(
        (changed["login"].as_str(), changed["state"].as_str()),
        (Some("kim.new"), Some("CURRENT"))
    );
    let rows = history(&harness, &token, &a).await;
    assert_eq!(rows.len(), 2);
    assert_eq!(
        (rows[0]["login"].as_str(), rows[0]["state"].as_str()),
        (Some("kim.new"), Some("CURRENT"))
    );
    assert_eq!(
        (rows[1]["login"].as_str(), rows[1]["state"].as_str()),
        (Some("kim.old"), Some("ALIAS"))
    );
    assert_eq!(rows[0]["assigned_by_name"], "Ops");
    assert_eq!(renames_audited(&pool).await, 1);

    // Search still finds the person by the old 아이디.
    let (status, found) = send(
        &harness,
        "GET",
        "/api/v1/directory/people?search=kim.old",
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{found}");
    assert_eq!(found["items"][0]["id"], a.as_str());
    assert_eq!(
        found["items"][0]["sign_in_id"]
            .as_str()
            .map(|s| s.starts_with("kim.new@")),
        Some(true)
    );

    // Never reissued: not to someone else, not back to the same account.
    for (who, login) in [(&b, "kim.old"), (&a, "kim.old"), (&b, "kim.new")] {
        let (status, refused) = rename(
            &harness,
            &token,
            who,
            json!({
                "login": login, "effective_date": today(), "reason_code": "INPUT_ERROR",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{login}: {refused}");
        assert_eq!(refused["error"]["code"], "sign_in_id_taken");
    }
    assert_eq!(
        renames_audited(&pool).await,
        1,
        "a refused rename writes no audit row"
    );
    assert_eq!(history(&harness, &token, &b).await.len(), 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn each_rename_refusal_is_typed_and_writes_nothing(pool: PgPool) {
    let harness = Harness::new(pool.clone()).await;
    let ops = seed_user(&pool, "Ops", &["SUPER_ADMIN"], None).await;
    let token = harness.token(ops, &["SUPER_ADMIN"], vec![]).await;
    let (_, a) = invite(
        &harness,
        &token,
        json!({ "display_name": "가", "sign_in_id": "ga" }),
    )
    .await;
    let a = a["id"].as_str().unwrap().to_owned();
    let tomorrow = (OffsetDateTime::now_utc() + Duration::days(2))
        .date()
        .to_string();
    let body = |login: &str, date: &str, reason: &str| json!({ "login": login, "effective_date": date, "reason_code": reason });
    for (request, status, code) in [
        (
            body("ga", &today(), "NAME_CHANGE"),
            StatusCode::UNPROCESSABLE_ENTITY,
            "sign_in_id_unchanged",
        ),
        (
            body("가나", &today(), "NAME_CHANGE"),
            StatusCode::UNPROCESSABLE_ENTITY,
            "sign_in_id_invalid",
        ),
        (
            body("ga.new", &tomorrow, "NAME_CHANGE"),
            StatusCode::UNPROCESSABLE_ENTITY,
            "effective_date_in_future",
        ),
        (
            body("ga.new", &today(), "OTHER"),
            StatusCode::UNPROCESSABLE_ENTITY,
            "reason_note_required",
        ),
        (
            body("ga.new", &today(), "NO_SUCH_REASON"),
            StatusCode::UNPROCESSABLE_ENTITY,
            "reason_code_invalid",
        ),
    ] {
        let (got, refused) = rename(&harness, &token, &a, request).await;
        assert_eq!(
            (got, refused["error"]["code"].as_str()),
            (status, Some(code)),
            "{refused}"
        );
    }
    // Unknown account: 404; a caller without 권한 관리: 403.
    let (status, _) = rename(
        &harness,
        &token,
        &uuid::Uuid::new_v4().to_string(),
        body("ga.new", &today(), "NAME_CHANGE"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let nobody = seed_user(&pool, "권한없음", &[], None).await;
    let weak = harness.token(nobody, &[], vec![]).await;
    let (status, _) = rename(&harness, &weak, &a, body("ga.new", &today(), "NAME_CHANGE")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        history(&harness, &token, &a).await.len(),
        1,
        "nothing written"
    );
    assert_eq!(renames_audited(&pool).await, 0);
}
