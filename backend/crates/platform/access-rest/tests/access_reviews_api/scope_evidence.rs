// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scoped_review_keeps_its_targets_and_accepts_an_already_revoked_grant(pool: PgPool) {
    let mut w = world(pool).await;
    let role = w
        .role(
            "Site reader",
            json!([{"domain":"hr_basic","levels":["view"]}]),
        )
        .await;
    let base = "/api/v1/access/reviews/2026-Q3";
    let name_revision = "INSERT INTO workplace_revisions
        (org_id,workplace_id,version,command_id,effective_from,name,status,change_mode,reason_code,payload_digest,settings_snapshot)
        VALUES ($1,$2,$3,gen_random_uuid(),$4::date,$5,'CONTINUING','MIGRATION','SEED',decode(repeat('00',32),'hex'),'{}')";
    for (id, label) in [(w.wp_a, "East site"), (w.wp_b, "West site")] {
        sqlx::query(name_revision)
            .bind(w.org)
            .bind(id)
            .bind(1_i32)
            .bind("2020-01-01")
            .bind(label)
            .execute(&w.owner)
            .await
            .unwrap();
        sqlx::query(name_revision)
            .bind(w.org)
            .bind(id)
            .bind(2_i32)
            .bind("2099-01-01")
            .bind("Future label")
            .execute(&w.owner)
            .await
            .unwrap();
    }
    w.grant(json!([grant_op(
        w.hr,
        role,
        "WORKPLACE",
        Some(w.wp_b),
        true
    )]))
    .await;
    // The grant screen issues subtree scopes. The storage model also permits historical exact-node grants.
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,workplace_id,include_descendants,valid_from,effective_in_setup,change_mode,reason_code,granted_by)
        VALUES ($1,$2,$3,'WORKPLACE',$4,false,now(),true,'SETUP','ROLE_REVIEW',$5)")
        .bind(w.org).bind(w.hr.as_uuid()).bind(role).bind(w.wp_a).bind(w.ops.as_uuid())
        .execute(&w.owner).await.unwrap();
    let (status, started) = call_json(
        &w,
        Method::POST,
        &format!("{base}/start"),
        w.ops,
        Some("review-scope-open-001"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let items = started["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let east = items
        .iter()
        .find(|i| i["scope_node_id"] == json!(w.wp_a))
        .unwrap();
    let west = items
        .iter()
        .find(|i| i["scope_node_id"] == json!(w.wp_b))
        .unwrap();
    assert_eq!(
        (&east["scope_label"], &east["scope_include_descendants"]),
        (&json!("East site"), &json!(false))
    );
    assert_eq!(
        (&west["scope_label"], &west["scope_include_descendants"]),
        (&json!("West site"), &json!(true))
    );

    // Older review rows captured only the kind. Reconstruct reach from the immutable grant and
    // the site name from the revision visible when the review opened, even after a rename.
    sqlx::query("UPDATE access_review_items SET scope_label=scope_kind, scope_node_id=NULL, scope_include_descendants=NULL WHERE org_id=$1 AND id=$2")
        .bind(w.org).bind(uuid::Uuid::parse_str(west["id"].as_str().unwrap()).unwrap())
        .execute(&w.owner).await.unwrap();
    sqlx::query(name_revision)
        .bind(w.org)
        .bind(w.wp_b)
        .bind(3_i32)
        .bind("2021-01-01")
        .bind("Renamed after freeze")
        .execute(&w.owner)
        .await
        .unwrap();
    for item in items {
        let (status, decision) = call_json(
            &w,
            Method::POST,
            &format!("{base}/decisions"),
            w.ops,
            Some(&format!(
                "review-scope-decide-{}",
                item["id"].as_str().unwrap()
            )),
            Some(json!({"item_id":item["id"],"decision":"REVOKE","reason_code":"ROLE_REVIEW"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{decision}");
    }
    w.grant(json!([{"op":"revoke","grant_id":east["grant_id"]}]))
        .await;
    let prior: time::OffsetDateTime =
        sqlx::query_scalar("SELECT revoked_at FROM access_grants WHERE org_id=$1 AND id=$2")
            .bind(w.org)
            .bind(uuid::Uuid::parse_str(east["grant_id"].as_str().unwrap()).unwrap())
            .fetch_one(&w.owner)
            .await
            .unwrap();
    for key in ["review-scope-complete-001", "review-scope-complete-002"] {
        let step = w.ops_key.step_up(&w.owner).await;
        let (status, done) = call_json(
            &w,
            Method::POST,
            &format!("{base}/complete"),
            w.ops,
            Some(key),
            Some(json!({"step_up":step})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{done}");
        assert_eq!(done["summary"]["state"], "COMPLETE");
        assert!(
            done["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|i| i["applied_at"].is_string())
        );
    }
    let after: time::OffsetDateTime =
        sqlx::query_scalar("SELECT revoked_at FROM access_grants WHERE org_id=$1 AND id=$2")
            .bind(w.org)
            .bind(uuid::Uuid::parse_str(east["grant_id"].as_str().unwrap()).unwrap())
            .fetch_one(&w.owner)
            .await
            .unwrap();
    assert_eq!(after, prior);
    let completed: Vec<Value> = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='access_review.complete'",
    )
    .bind(w.org)
    .fetch_all(&w.owner)
    .await
    .unwrap();
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0]["revoked_count"], 1);
    let (status, csv) = call_raw(
        &w,
        Method::GET,
        &format!("{base}/export.csv?export_purpose=QUARTERLY_AUDIT"),
        w.ops,
        None,
        None,
    )
    .await;
    let csv = String::from_utf8(csv).unwrap();
    assert_eq!(status, StatusCode::OK, "{csv}");
    assert!(
        csv.lines().any(
            |s| s.contains("East site") && s.ends_with(&format!(",WORKPLACE,{},false", w.wp_a))
        )
    );
    assert!(csv.lines().any(|s|s.contains("West site") && s.ends_with(&format!(",WORKPLACE,{},true",w.wp_b))));
    assert!(!csv.contains("Renamed after freeze") && !csv.contains("Future label"));
}
