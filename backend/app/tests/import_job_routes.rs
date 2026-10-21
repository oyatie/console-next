#![allow(clippy::unwrap_used)] // the shared emp_ui_routes harness unwraps, as every app test crate allows
//! BE-MIG over HTTP (W11, W03 / E8): the apply job and the 미배치 queue are
//! mounted behind the request context; `Prefer: respond-async` answers 202
//! with the job and GET reads it to `done`; a shed apply is 503 with
//! `Retry-After`; refusals reach the wire with status and code. The service
//! suites (console-hr-adapter-postgres `import2::mig_*`) prove the rest.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

use axum::body::{Body, to_bytes};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::import::apply_job::DriverSlot;
use console_hr_adapter_postgres::import::sheet::SheetContext;
use console_hr_adapter_postgres::import::types::{ImportDryRunRequest, XlsxUpload};
use console_hr_adapter_postgres::import::workbook::parse_workbook;
use console_hr_domain::import::detect::WorkbookMappingRequest;
use console_hr_domain::import::grid::{Cell, GridRow, GridSheet};
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use http::{Request, StatusCode, header};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

#[path = "emp_ui_routes/harness.rs"]
mod harness;

use harness::{Caller, keys, router, token, user};

#[path = "import_job_routes/inline_outlives.rs"]
mod inline_outlives;

type Out<T> = Result<T, String>;

fn e<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

async fn completed_job(ops: &Caller, apply: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let (status, job) = ops.call("GET", apply, None).await;
        assert_eq!(status, StatusCode::OK, "{job}");
        if job["state"] == "done" {
            return job;
        }
        assert!(
            matches!(
                job["state"].as_str(),
                Some("queued" | "applying" | "settling")
            ),
            "{job}"
        );
        assert!(Instant::now() < deadline, "job did not finish: {job}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// A run previewed and dry-run through the service (the multipart upload is
/// the IMPORT-2 suites' subject): `(run, digest)`.
async fn planned(pool: &PgPool, org: Uuid, ops: UserId) -> Out<(Uuid, String)> {
    let rt = HrService::new(pool.clone());
    let principal = Principal::new(
        ops,
        OrgId::from_uuid(org),
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    let text = |t: &str| Cell::Text(t.into());
    let sheet = GridSheet {
        name: "명부".into(),
        rows: vec![
            GridRow {
                index: 0,
                cells: vec![
                    (0, text("성명")),
                    (1, text("입사일")),
                    (2, text("고용형태")),
                ],
            },
            GridRow {
                index: 1,
                cells: vec![
                    (0, text("김일")),
                    (1, text("2024-03-04")),
                    (2, text("정규직")),
                ],
            },
        ],
    };
    let ctx = SheetContext {
        filename: "a.xlsx",
        org,
        vault: None,
    };
    let parsed = parse_workbook(
        &ctx,
        &[sheet],
        &BTreeMap::new(),
        &WorkbookMappingRequest::default(),
    )
    .map_err(|x| x.message)?;
    let upload = XlsxUpload {
        filename: "a.xlsx".into(),
        bytes: Vec::new(),
        mapping: None,
        pay_period_start: None,
        pay_period_end: None,
    };
    let run = rt
        .preview_import(principal.clone(), upload, "c".repeat(64), parsed)
        .await
        .map_err(|x| x.message)?
        .run_id;
    let plan = rt
        .dry_run_import(principal, run, ImportDryRunRequest::default())
        .await
        .map_err(|x| x.message)?;
    Ok((run, plan.dry_run_digest))
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_import_job_and_the_unplaced_queue_answer_on_the_wire(pool: PgPool) -> Out<()> {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'BE-MIG HTTP')")
        .bind(org)
        .bind(format!("mig-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .map_err(e)?;
    let keys = keys();
    let service = router(&pool, &keys).await;
    let ops_id = user(&pool, org, "SUPER_ADMIN").await;
    let member_id = user(&pool, org, "MEMBER").await;
    let ops = Caller {
        service: service.clone(),
        token: Some(token(&pool, &keys, org, ops_id, "SUPER_ADMIN").await),
    };
    let member = Caller {
        service: service.clone(),
        token: Some(token(&pool, &keys, org, member_id, "MEMBER").await),
    };
    let anonymous = Caller {
        service: service.clone(),
        token: None,
    };
    let unplaced = "/api/v1/employees/import/unplaced";

    // The 미배치 queue: 401 / 403 / 422 refusals, then an empty queue.
    assert_eq!(
        anonymous.call("GET", unplaced, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, body) = member.call("GET", unplaced, None).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::FORBIDDEN, "forbidden"),
        "{body}"
    );
    let (status, body) = ops
        .call("GET", &format!("{unplaced}?after=nope"), None)
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::UNPROCESSABLE_ENTITY, "validation"),
        "{body}"
    );
    let (status, body) = ops.call("GET", unplaced, None).await;
    assert_eq!(
        (status, body["count"].clone()),
        (StatusCode::OK, json!(0)),
        "{body}"
    );

    // An unknown run: 404 on GET and on the async POST (refusals are synchronous).
    let ghost = Uuid::new_v4();
    let (status, _) = ops
        .call(
            "GET",
            &format!("/api/v1/employees/import/{ghost}/apply"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (run, digest) = planned(&pool, org, ops_id).await?;
    let bearer = format!("Bearer {}", ops.token.clone().unwrap_or_default());
    let member_bearer = format!("Bearer {}", member.token.clone().unwrap_or_default());
    let apply = format!("/api/v1/employees/import/{run}/apply");
    let post_as = |bearer: &str, prefer: bool| {
        let mut builder = Request::builder()
            .method("POST")
            .uri(&apply)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, bearer);
        if prefer {
            builder = builder.header("prefer", "respond-async");
        }
        builder.body(Body::from(json!({ "dry_run_digest": digest }).to_string()))
    };
    let post = |prefer: bool| post_as(&bearer, prefer);

    // Without employee_directory_manage: 403 on the async POST and on GET, nothing started.
    let refused = service
        .clone()
        .oneshot(post_as(&member_bearer, true).map_err(e)?)
        .await
        .map_err(e)?;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let (status, body) = member.call("GET", &apply, None).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::FORBIDDEN, "forbidden"),
        "{body}"
    );
    let (status, body) = ops.call("GET", &apply, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "no job was started: {body}");

    // #28 load shedding: every driver slot taken → 503 with Retry-After, nothing started.
    let held = (
        DriverSlot::take().map_err(|x| x.message)?,
        DriverSlot::take().map_err(|x| x.message)?,
    );
    let shed = service
        .clone()
        .oneshot(post(true).map_err(e)?)
        .await
        .map_err(e)?;
    assert_eq!(shed.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        shed.headers()
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok()),
        Some("15")
    );
    let shed: Value =
        serde_json::from_slice(&to_bytes(shed.into_body(), usize::MAX).await.map_err(e)?)
            .map_err(e)?;
    assert_eq!(code(&shed), "import_apply_busy", "{shed}");
    let (status, body) = ops.call("GET", &apply, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "no job was started: {body}");
    drop(held);

    // RFC 7240: within the grace the report is 200, otherwise 202 names the
    // same job. Both paths must finish with the same report and settled roster.
    let answered = service
        .clone()
        .oneshot(post(true).map_err(e)?)
        .await
        .map_err(e)?;
    let status = answered.status();
    let bytes = to_bytes(answered.into_body(), usize::MAX)
        .await
        .map_err(e)?;
    let body: Value = serde_json::from_slice(&bytes).map_err(e)?;
    assert!(
        matches!(status, StatusCode::OK | StatusCode::ACCEPTED),
        "{status}: {body}"
    );
    let job = completed_job(&ops, &apply).await;
    let report = if status == StatusCode::OK {
        body
    } else {
        assert_eq!(body["run_id"], json!(run), "{body}");
        assert!(
            matches!(
                body["state"].as_str(),
                Some("queued" | "applying" | "settling" | "done")
            ),
            "{body}"
        );
        job["report"].clone()
    };
    assert_eq!(report, job["report"], "{job}");
    assert_eq!(report["inserted"], 1, "{report}");
    assert_eq!(
        (job["run_id"].clone(), job["state"].clone()),
        (json!(run), json!("done"))
    );
    let (status, body) = ops.call("GET", unplaced, None).await;
    assert_eq!(
        (status, body["count"].clone()),
        (StatusCode::OK, json!(1)),
        "the person came in 미배치: {body}"
    );

    // The same apply without Prefer: the stored report (200), nothing doubled.
    let replay = service.oneshot(post(false).map_err(e)?).await.map_err(e)?;
    assert_eq!(replay.status(), StatusCode::OK);
    Ok(())
}
