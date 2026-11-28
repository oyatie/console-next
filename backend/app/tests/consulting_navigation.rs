// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
#[path = "support/http.rs"]
mod http;
use ::http::StatusCode;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

fn advertised(data: &Value, feature: &str) -> bool {
    data["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|cap| cap["feature"] == feature)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn projection_and_routes_agree_for_independent_consulting_grants(pool: PgPool) {
    let (org, admin) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let one_branch: Uuid = sqlx::query_scalar(
        "WITH r AS (INSERT INTO regions(org_id,name) VALUES($1,'Local') RETURNING id)
        INSERT INTO branches(org_id,region_id,name) SELECT $1,id,'Port' FROM r RETURNING id",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO tenant_module_enrollments(org_id,module_key,enabled,change_ref) VALUES($1,'consulting',true,'navigation-test')")
        .bind(org).execute(&pool).await.unwrap();
    for (name, role, read, manage) in [
        ("reader", "SUPER_ADMIN", true, false),
        ("editor", "SUPER_ADMIN", false, true),
        ("local", "ADMIN", true, true),
    ] {
        let user = http::add_user(&pool, org, &[role]).await;
        let policy: Uuid = sqlx::query_scalar("INSERT INTO policy_roles(org_id,role_key,display_name,status,is_system,created_by,updated_by)
            VALUES($1,$2,$2,'ACTIVE',false,$3,$3) RETURNING id").bind(org).bind(name).bind(admin.as_uuid()).fetch_one(&pool).await.unwrap();
        for (feature, level) in [
            ("consulting_read", if read { "allow" } else { "deny" }),
            ("consulting_manage", if manage { "allow" } else { "deny" }),
        ] {
            sqlx::query("INSERT INTO policy_role_permissions(org_id,role_id,feature_key,permission_level) VALUES($1,$2,$3,$4)")
                .bind(org).bind(policy).bind(feature).bind(level).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO user_role_assignments(org_id,user_id,role_id) VALUES($1,$2,$3)")
            .bind(org)
            .bind(user.as_uuid())
            .bind(policy)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO user_branches(org_id,user_id,branch_id) VALUES($1,$2,$3)")
            .bind(org)
            .bind(user.as_uuid())
            .bind(one_branch)
            .execute(&pool)
            .await
            .unwrap();
        let ctx = http::ctx(&pool, org, user, &[role], None).await;
        let mounted = cfg!(feature = "consulting");
        let org_wide = role == "SUPER_ADMIN";
        let (status, caps) = ctx.call("GET", "/api/v1/me/authz", None).await;
        assert_eq!(status, StatusCode::OK, "{caps}");
        assert_eq!(
            advertised(&caps, "served_consulting_entry"),
            mounted && org_wide && (read || manage)
        );
        assert_eq!(
            advertised(&caps, "served_consulting"),
            mounted && read && org_wide
        );
        assert_eq!(
            advertised(&caps, "served_consulting_manage"),
            mounted && manage && org_wide
        );
        for (route, allowed) in [
            ("/api/v1/consulting/engagements", read && org_wide),
            (
                "/api/v1/consulting/options?kind=DOCUMENT",
                manage && org_wide,
            ),
            (
                "/api/v1/consulting/options?kind=CUSTOMER",
                manage && org_wide,
            ),
        ] {
            let (status, body) = ctx.call("GET", route, None).await;
            let expected = if !mounted {
                StatusCode::NOT_FOUND
            } else if allowed {
                StatusCode::OK
            } else {
                StatusCode::FORBIDDEN
            };
            assert_eq!(status, expected, "{name} {route}: {body}");
        }
    }
}
