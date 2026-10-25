// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! MR-34 사진 over HTTP with a stand-in object store: no store is 503, the
//! issue answers a presigned PUT without the key, the confirm HEADs the
//! object (missing and wrong size are 409), and the read serves a presigned
//! GET once the photo is set through the correction path. The adapter gate:
//! a 사진 only from a confirmed upload of the same employee.

#[path = "photo_http/former.rs"]
mod former;
#[path = "../../adapter-postgres/tests/support/mod.rs"]
mod support;

use std::sync::{Arc, Mutex};

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use axum::{Extension, Router};
use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::corrections::{CorrectEmployeeRequest, CorrectionOutcome};
use console_hr_adapter_postgres::personal_facts::photo::PhotoUploadRequest;
use console_hr_rest::personal_facts::{PhotoStore, router};
use console_platform_storage::{
    CopyObjectRequest, ObjectHead, PresignGetRequest, PresignPutRequest, PresignedUpload,
    RetentionInfo, S3ObjectStore, StorageError, StorageFuture,
};
use console_platform_test_support::soft_passkey::passkey_service;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tower::ServiceExt;
use uuid::Uuid;

use support::{SECOND, World, world};

/// Answers presigns with fixed URLs and HEADs with the size it holds.
#[derive(Default)]
struct FakeStore {
    size: Mutex<Option<i64>>,
}

impl S3ObjectStore for FakeStore {
    fn presign_put(&self, request: PresignPutRequest) -> StorageFuture<'_, PresignedUpload> {
        Box::pin(async move {
            Ok(PresignedUpload {
                method: "PUT".into(),
                url: format!("https://s3.test/{}/{}", request.bucket, request.key),
                headers: vec![("content-type".into(), request.content_type)],
                expires_in_secs: request.expires_in.as_secs(),
            })
        })
    }
    fn presign_get(&self, request: PresignGetRequest) -> StorageFuture<'_, String> {
        Box::pin(async move { Ok(format!("https://s3.test/get/{}", request.key)) })
    }
    fn head_object(&self, _bucket: String, _key: String) -> StorageFuture<'_, ObjectHead> {
        let size = *self.size.lock().unwrap();
        Box::pin(async move {
            let size_bytes = size.ok_or_else(|| StorageError::S3("404".into()))?;
            Ok(ObjectHead {
                size_bytes,
                e_tag: None,
                checksum_sha256: None,
                object_lock_mode: None,
                retain_until: None,
            })
        })
    }
    fn copy_object(&self, _: CopyObjectRequest) -> StorageFuture<'_, ()> {
        unimplemented!("not used by the photo routes")
    }
    fn get_object_retention(&self, _: String, _: String) -> StorageFuture<'_, RetentionInfo> {
        unimplemented!("not used by the photo routes")
    }
    fn get_object(&self, _: String, _: String) -> StorageFuture<'_, Vec<u8>> {
        unimplemented!("not used by the photo routes")
    }
    fn put_object(&self, _: String, _: String, _: String, _: Vec<u8>) -> StorageFuture<'_, ()> {
        unimplemented!("not used by the photo routes")
    }
    fn delete_object(&self, _: String, _: String) -> StorageFuture<'_, ()> {
        unimplemented!("not used by the photo routes")
    }
}

async fn call(app: &Router, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_photo_is_uploaded_presigned_confirmed_by_head_and_served_presigned(pool: PgPool) {
    let w = world(&pool).await;
    let principal = w.hr(w.hr_one);
    let uploads = format!("/api/v1/employees/{}/photo-uploads", w.in_a);
    let declared = json!({ "content_type": "image/jpeg", "byte_size": 2048 });

    let bare = router(w.hr.clone(), None).layer(Extension(principal.clone()));
    let (status, body) = call(&bare, Method::POST, &uploads, Some(declared.clone())).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "photo_storage_unavailable");

    let store = Arc::new(FakeStore::default());
    let photos = PhotoStore {
        store: store.clone(),
        bucket: "primary".into(),
    };
    let app = router(w.hr.clone(), Some(photos)).layer(Extension(principal.clone()));
    let (status, issued) = call(&app, Method::POST, &uploads, Some(declared)).await;
    assert_eq!(status, StatusCode::OK, "{issued}");
    assert!(
        issued.get("object_key").is_none(),
        "the key is never answered"
    );
    let put_url = issued["put"]["url"].as_str().unwrap();
    assert!(put_url.starts_with(&format!(
        "https://s3.test/primary/{}/hr/employee-photos/",
        w.org
    )));
    let upload_id = issued["upload_id"].as_str().unwrap().to_owned();
    let confirm = format!("{uploads}/{upload_id}/confirm");

    let (status, body) = call(&app, Method::POST, &confirm, None).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("photo_upload_missing"))
    );
    *store.size.lock().unwrap() = Some(1000);
    let (status, body) = call(&app, Method::POST, &confirm, None).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("photo_upload_size_mismatch"))
    );
    *store.size.lock().unwrap() = Some(2048);
    let (status, body) = call(&app, Method::POST, &confirm, None).await;
    assert_eq!(
        (status, body["confirmed"].clone()),
        (StatusCode::OK, json!(true))
    );

    correct(&pool, &w, w.in_a, json!({ "photo": upload_id }))
        .await
        .unwrap();
    let read = format!("/api/v1/employees/{}/personal-facts", w.in_a);
    let (status, facts) = call(&app, Method::GET, &read, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(facts["photo"]["upload_id"], json!(upload_id));
    assert!(
        facts["photo"]["url"]
            .as_str()
            .unwrap()
            .starts_with("https://s3.test/get/")
    );
    assert!(facts["photo"].get("object_key").is_none());
}

async fn correct(
    pool: &PgPool,
    w: &World,
    employee: Uuid,
    changes: Value,
) -> Result<CorrectionOutcome, HrError> {
    let at: OffsetDateTime = sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
        .bind(employee)
        .fetch_one(pool)
        .await
        .unwrap();
    let body: CorrectEmployeeRequest = serde_json::from_value(json!({
        "expected_updated_at": at.format(&Rfc3339).unwrap(),
        "changes": changes,
        "reason_code": "DATA_ENTRY_ERROR",
    }))
    .unwrap();
    w.hr.correct_employee(w.hr(w.hr_one), &passkey_service(), employee, body, SECOND)
        .await
}

async fn ledger(pool: &PgPool, employee: Uuid) -> Vec<(String, Option<Value>, Value)> {
    sqlx::query_as(
        "SELECT field, old_value, new_value FROM employee_corrections \
         WHERE employee_id = $1 ORDER BY created_at, field",
    )
    .bind(employee)
    .fetch_all(pool)
    .await
    .unwrap()
}

fn upload(content_type: &str) -> PhotoUploadRequest {
    // Built directly: the wire validator rejects unknown types before the domain, and these
    // cases exercise the domain's own refusal (`check_photo`).
    PhotoUploadRequest {
        content_type: content_type.to_owned(),
        byte_size: 2048,
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_photo_is_set_only_from_a_confirmed_upload_of_the_same_employee(pool: PgPool) {
    let w = world(&pool).await;
    let hr = || w.hr(w.hr_one);
    let svg =
        w.hr.issue_photo_upload(hr(), w.in_a, upload("image/svg+xml"))
            .await;
    assert_eq!(svg.unwrap_err().status, StatusCode::UNPROCESSABLE_ENTITY);
    let mine =
        w.hr.issue_photo_upload(hr(), w.in_a, upload("image/png"))
            .await
            .unwrap();
    assert!(
        mine.object_key
            .starts_with(&format!("{}/hr/employee-photos/{}/", w.org, w.in_a))
    );
    let err = correct(&pool, &w, w.in_a, json!({ "photo": mine.upload_id }))
        .await
        .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::CONFLICT, "photo_upload_unconfirmed")
    );

    let theirs =
        w.hr.issue_photo_upload(hr(), w.in_b, upload("image/jpeg"))
            .await
            .unwrap();
    let theirs = w.hr.confirm_photo_upload(hr(), theirs).await.unwrap();
    let err = correct(&pool, &w, w.in_a, json!({ "photo": theirs.upload_id }))
        .await
        .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::NOT_FOUND, "photo_upload_not_found")
    );

    let found =
        w.hr.photo_upload(hr(), w.in_a, mine.upload_id)
            .await
            .unwrap();
    let confirmed = w.hr.confirm_photo_upload(hr(), found).await.unwrap();
    assert!(confirmed.confirmed);
    correct(&pool, &w, w.in_a, json!({ "photo": mine.upload_id }))
        .await
        .unwrap();
    let facts = w.hr.personal_facts(hr(), w.in_a).await.unwrap();
    let photo = facts.photo.expect("the photo is set");
    assert_eq!(
        (photo.upload_id, photo.content_type.as_str()),
        (mine.upload_id, "image/png")
    );
    let json = serde_json::to_value(w.hr.personal_facts(hr(), w.in_a).await.unwrap()).unwrap();
    assert!(
        json["photo"].get("object_key").is_none(),
        "the key is never served"
    );

    correct(&pool, &w, w.in_a, json!({ "photo": null }))
        .await
        .unwrap();
    assert!(
        w.hr.personal_facts(hr(), w.in_a)
            .await
            .unwrap()
            .photo
            .is_none()
    );
    let rows = ledger(&pool, w.in_a).await;
    assert_eq!(
        rows.last().unwrap().1,
        Some(json!(mine.upload_id.to_string()))
    );
    let issued: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 \
         AND action = 'employee.photo.upload_issue' AND after_snap->>'upload_id' = $2",
    )
    .bind(w.org)
    .bind(mine.upload_id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(issued, 1, "the upload is audited by id");
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND after_snap::text LIKE '%employee-photos%'",
    )
    .bind(w.org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(leaked, 0, "audit rows never carry an object key");
}
