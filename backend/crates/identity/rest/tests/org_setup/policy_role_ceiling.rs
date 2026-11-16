// SPDX-License-Identifier: LicenseRef-Proprietary
//! Policy Studio role writes stay within the editor's own permissions, whoever
//! already holds the role.

use super::*;

/// An account whose only access is access-management edit, granted by `granter`
/// over one workplace, or over the whole tenant when `workplace` is `None`.
pub(super) async fn access_editor(
    pool: &PgPool,
    name: &str,
    workplace: Option<uuid::Uuid>,
    granter: UserId,
) -> UserId {
    let account = seed_user(pool, name, &[], None).await;
    let org = *OrgId::one().as_uuid();
    let role = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,$3,'ACTIVE',1,$4)")
        .bind(org).bind(role).bind(format!("access {role}")).bind(granter.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,$3,'ACTIVE','SETUP',$4)")
        .bind(org).bind(role).bind(format!("access {role}")).bind(granter.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'access',ARRAY['view','edit'])")
        .bind(org).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,workplace_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,$4,$5,now() - interval '1 hour',true,'SETUP','INITIAL',$6)")
        .bind(org).bind(account.as_uuid()).bind(role)
        .bind(if workplace.is_some() { "WORKPLACE" } else { "TENANT" })
        .bind(workplace).bind(granter.as_uuid()).execute(pool).await.unwrap();
    account
}

async fn holds_directory_manage(pool: &PgPool, account: UserId) -> bool {
    resolve_effective_feature_grants_in_org(pool, OrgId::one(), account, &BranchScope::All)
        .await
        .unwrap()
        .iter()
        .any(|grant| grant.feature == Feature::EmployeeDirectoryManage)
}

async fn policy_version_or_zero(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT version FROM policy_versions WHERE org_id = $1")
        .bind(*OrgId::one().as_uuid())
        .fetch_optional(pool)
        .await
        .unwrap()
        .unwrap_or(0)
}

fn role_body(name: &str, features: &[&str]) -> Value {
    let permissions: Vec<Value> = features
        .iter()
        .map(|feature| json!({ "feature_key": feature, "permission_level": "allow" }))
        .collect();
    json!({ "display_name": name, "permissions": permissions, "conditions": [] })
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn role_writes_stay_within_the_editors_own_permissions(pool: PgPool) {
    let h = Harness::new(pool.clone()).await;
    let founder = seed_user(&pool, "Founder", &["SUPER_ADMIN"], None).await;
    let editor = access_editor(&pool, "Access editor", None, founder).await;
    let holder = seed_user(&pool, "Role holder", &[], None).await;
    let token = h.token(editor, &[], vec![]).await;

    let assigned = seed_policy_role(
        &pool,
        editor,
        "account_helper",
        "Account helper",
        "ACTIVE",
        false,
        &[("user_manage", "allow")],
    )
    .await;
    seed_policy_assignment(&pool, holder, assigned, editor).await;
    let drafted = seed_policy_role(
        &pool,
        founder,
        "directory_helper",
        "Directory helper",
        "DRAFT",
        false,
        &[("employee_directory_manage", "allow")],
    )
    .await;
    seed_policy_assignment(&pool, holder, drafted, founder).await;
    let version = policy_version_or_zero(&pool).await;

    let mut widen = role_body(
        "Account helper",
        &["user_manage", "employee_directory_manage"],
    );
    widen["step_up"] = fresh_step_up_assertion(&pool, editor, "Access editor").await;
    let (status, body) = send_patch(
        &h,
        &format!("/api/v1/policy/roles/{assigned}"),
        &token,
        widen,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "forbidden");

    let mut create = role_body("Directory editor", &["employee_directory_manage"]);
    create["role_key"] = json!("directory_editor");
    let (status, body) = send(&h, "POST", "/api/v1/policy/roles", &token, Some(create)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "forbidden");

    let activate = json!({ "status": "ACTIVE", "step_up": fresh_step_up_assertion(&pool, editor, "Access editor").await });
    let (status, body) = send_patch(
        &h,
        &format!("/api/v1/policy/roles/{drafted}/status"),
        &token,
        activate,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "forbidden");

    assert_eq!(
        policy_role_definition(&pool, assigned).await["permissions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(policy_role_status(&pool, drafted).await, "DRAFT");
    let created: i64 =
        sqlx::query_scalar("SELECT count(*) FROM policy_roles WHERE role_key = 'directory_editor'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(created, 0, "nothing created");
    assert_eq!(
        policy_version_or_zero(&pool).await,
        version,
        "nothing changed"
    );
    assert!(
        policy_audit_actions_for_target(&pool, assigned)
            .await
            .is_empty()
    );
    assert!(!holds_directory_manage(&pool, holder).await);

    // Within the editor's own permissions the same role stays editable.
    let mut rename = role_body("Account desk", &["user_manage"]);
    rename["step_up"] = fresh_step_up_assertion(&pool, editor, "Access editor").await;
    let (status, body) = send_patch(
        &h,
        &format!("/api/v1/policy/roles/{assigned}"),
        &token,
        rename,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["display_name"], "Account desk");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_role_the_editor_holds_is_not_theirs_to_edit(pool: PgPool) {
    let h = Harness::new(pool.clone()).await;
    let founder = seed_user(&pool, "Founder", &["SUPER_ADMIN"], None).await;
    let editor = access_editor(&pool, "Access editor", None, founder).await;
    let token = h.token(editor, &[], vec![]).await;
    let held = seed_policy_role(
        &pool,
        founder,
        "account_helper",
        "Account helper",
        "ACTIVE",
        false,
        &[("user_manage", "allow")],
    )
    .await;
    seed_policy_assignment(&pool, editor, held, founder).await;

    let mut widen = role_body(
        "Account helper",
        &["user_manage", "employee_directory_manage"],
    );
    widen["step_up"] = fresh_step_up_assertion(&pool, editor, "Access editor").await;
    let (status, body) =
        send_patch(&h, &format!("/api/v1/policy/roles/{held}"), &token, widen).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "forbidden");
    assert!(!holds_directory_manage(&pool, editor).await);

    let mut rename = role_body("Account desk", &["user_manage"]);
    rename["step_up"] = fresh_step_up_assertion(&pool, editor, "Access editor").await;
    let (status, body) =
        send_patch(&h, &format!("/api/v1/policy/roles/{held}"), &token, rename).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "forbidden");

    let retire = json!({ "status": "RETIRED", "step_up": fresh_step_up_assertion(&pool, editor, "Access editor").await });
    let (status, body) = send_patch(
        &h,
        &format!("/api/v1/policy/roles/{held}/status"),
        &token,
        retire,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "forbidden");

    assert_eq!(
        policy_role_definition(&pool, held).await["display_name"],
        "Account helper"
    );
    assert_eq!(policy_role_status(&pool, held).await, "ACTIVE");
    assert_eq!(
        policy_role_definition(&pool, held).await["permissions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
