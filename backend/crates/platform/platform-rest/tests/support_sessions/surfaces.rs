// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_reviewed_surface_preserves_metadata_and_masks_personal_fields(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let id = Uuid::new_v4();
    let mut body = h.body(id);
    body["scope"] = json!(["org", "hr_basic"]);
    ok(
        h.signed(false, id, "request", body).await,
        StatusCode::CREATED,
    );
    ok(h.approve(id).await, StatusCode::OK);
    ok(h.decide(id, "APPROVE").await, StatusCode::OK);
    let started = h.start(id).await;
    assert_eq!(started.0, StatusCode::OK);
    let token = started.1["access_token"].as_str().unwrap();
    let paths: Vec<String> =
        sqlx::query_scalar("SELECT path FROM support_read_surfaces ORDER BY path")
            .fetch_all(&h.owner)
            .await
            .unwrap();
    assert_eq!(
        paths.len(),
        5,
        "each reviewed surface needs content assertions here"
    );
    for path in paths {
        let (status, value) = h.send("GET", &path, Value::Null, token).await;
        assert_eq!(status, StatusCode::OK, "{path}: {value}");
        match path.as_str() {
            "/api/v1/org-units" => {
                let row = &value["items"][0];
                for (key, expected) in [
                    ("id", "unit"),
                    ("kind", "DEPARTMENT"),
                    ("name", "인사부"),
                    ("parentId", "root"),
                    ("status", "ACTIVE"),
                    ("effectiveFrom", "2026-10-23"),
                    ("updatedAt", "2026-10-23T00:00:00Z"),
                ] {
                    assert_eq!(row[key], expected, "{key}");
                }
                assert_eq!(row["headcount"], 5);
                assert_eq!(row["head"]["name"], "••••");
            }
            "/api/v1/org-structure" => {
                assert_eq!(value["tenant_name"], "고객사");
                assert_eq!(value["as_of"], "2026-10-23");
                assert_eq!(value["phase"], "OPERATING");
                assert_eq!(value["entities"][0]["children"][0]["name"], "부서");
                assert_eq!(value["entities"][0]["children"][0]["head"]["name"], "••••");
            }
            "/api/v1/legal-entities" => {
                assert_eq!(value["items"][0]["current"]["name"], "고객 법인");
                assert_eq!(value["items"][0]["founding"], false);
                assert!(value["items"][0]["current"]["representatives"].is_null());
            }
            "/api/v1/workplaces" => {
                let row = &value["items"][0];
                assert_eq!(row["kind_code"], "OFFICE");
                assert_eq!(row["headcount"], 5);
                assert_eq!(row["current"]["name"], "서울 사업장");
                assert_eq!(row["current"]["representative_name"], "••••");
                assert_eq!(row["current"]["email"], "••••");
                assert!(row["current"]["mobile"].is_null());
            }
            "/api/v1/employees" => {
                assert_eq!(value["total"], 1);
                for field in ["display_name", "name", "phone", "personal_email", "unknown"] {
                    assert_eq!(value[field], "••••", "{field}");
                }
            }
            _ => panic!("unreviewed test surface: {path}"),
        }
    }
    assert_eq!(h.accesses(id).await, 5);
}
