// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn payroll_clearance_catalog_matches_role_lines_and_never_grants_by_default(pool: PgPool) {
    let w = world(pool).await;
    let (status, catalog) = w
        .call(Method::GET, "/api/v1/access/catalog", w.ops, None)
        .await;
    assert_eq!(status, StatusCode::OK);
    for domain in ["pay", "sensitive"] {
        let row = catalog["domains"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["domain"] == domain)
            .unwrap();
        let levels: Vec<_> = row["operations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|operation| operation["level"].as_str().unwrap())
            .collect();
        assert_eq!(
            levels,
            if domain == "pay" {
                vec!["view", "edit"]
            } else {
                vec!["view", "edit", "export"]
            }
        );
        for level in levels {
            let (status, role) = w.call(Method::POST, "/api/v1/access/roles", w.ops,
                Some(json!({"name_ko":format!("{domain} {level}"),"lines":[{"domain":domain,"levels":[level]}]}))).await;
            assert_eq!(status, StatusCode::CREATED, "{role}");
            let levels = if level == "view" {
                json!(["view"])
            } else {
                json!(["view", level])
            };
            assert_eq!(role["lines"], json!([{"domain":domain,"levels":levels}]));
            assert_eq!(role["holder_count"], 0);
        }
    }
}
