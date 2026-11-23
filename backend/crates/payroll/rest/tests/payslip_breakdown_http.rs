// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]

#[path = "support/payslip_breakdown_fixtures.rs"]
mod fx;
#[path = "fixtures/pay_view.rs"]
mod pay_view;
#[path = "fixtures/person_accounts.rs"]
mod person_accounts;

use console_kernel_core::{OrgId, UserId};
use console_ontology_canonical_domain::{CanonicalPort, CommandId, CommandReceipt};
use console_payroll_adapter_postgres::pay_run::{PayRunCommand, PayRunQuery, PgPayRunPort};
use fx::{SHA256_FIXTURE, runtime_role_pool, send, token_for};
use http::StatusCode;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use person_accounts::seed_user;
use serde_json::json;
use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn run_detail_bank_filters_breakdown_rbac_and_readiness_me(pool: PgPool) {
    let sk = SigningKey::generate();
    let priv_pem = sk.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
    let pub_pem = sk
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let rt = runtime_role_pool(&pool).await;
    let org = OrgId::one();
    let org_b = OrgId::from_uuid(Uuid::new_v4());
    for (id, slug, name) in [(org, "sae", "SAE"), (org_b, "other", "Other")] {
        sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING")
            .bind(*id.as_uuid()).bind(slug).bind(name).execute(&pool).await.unwrap();
    }

    let hr = seed_user(&pool, org, "EXECUTIVE", None).await;
    pay_view::grant_manage(&pool, org, hr, None).await;
    let hr_tok = token_for(&pool, &priv_pem, &pub_pem, hr, org, "EXECUTIVE").await;
    let outsider = seed_user(&pool, org_b, "EXECUTIVE", None).await;
    pay_view::grant_manage(&pool, org_b, outsider, None).await;
    let outsider_tok = token_for(&pool, &priv_pem, &pub_pem, outsider, org_b, "EXECUTIVE").await;

    let mut emp_ids = Vec::new();
    for name in ["Alice", "Bob"] {
        let emp = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, source_row, source_key) \
             VALUES ($1, $2, 'SAE', $3, 'roster.xlsx', 'Sheet1', 1, $4)",
        )
        .bind(emp).bind(*org.as_uuid()).bind(name).bind(format!("emp-{emp}")).execute(&pool).await.unwrap();
        emp_ids.push(emp);
    }
    let (emp_with_bank, emp_missing_bank) = (emp_ids[0], emp_ids[1]);
    let member = seed_user(&pool, org, "MEMBER", Some(emp_with_bank)).await;
    let member_tok = token_for(&pool, &priv_pem, &pub_pem, member, org, "MEMBER").await;

    let port = PgPayRunPort::new(rt.clone(), tokio::runtime::Handle::current());
    let created: CommandReceipt = tokio::task::spawn_blocking(move || {
        port.execute(&PayRunCommand {
            org_id: org,
            command_id: CommandId::from_uuid(Uuid::new_v4()),
            actor_id: hr,
            query: PayRunQuery::CreateRun {
                run_id: Uuid::new_v4(),
                period_start: date!(2026 - 06 - 01),
                period_end: date!(2026 - 06 - 30),
                connector: Some("m2".to_owned()),
                job: Some("payroll_draft".to_owned()),
            },
            action_key: "create_run".to_owned(),
            object_type_id: Uuid::nil(),
        })
    })
    .await
    .unwrap()
    .unwrap();
    let run: Uuid = created.result()["draft_run_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();

    let imp_run: Uuid = sqlx::query_scalar(
        "INSERT INTO data_import_runs (org_id, entity_type, status, source_filename, source_format, source_sha256, pay_period_start, pay_period_end) \
         VALUES ($1, 'employee_hr', 'DRY_RUN', 'src.xlsx', 'xlsx', $2, DATE '2026-06-01', DATE '2026-06-30') RETURNING id",
    ).bind(*org.as_uuid()).bind(SHA256_FIXTURE).fetch_one(&pool).await.unwrap();

    for (i, (emp, name, bank)) in [
        (emp_with_bank, "Alice", true),
        (emp_missing_bank, "Bob", false),
    ]
    .into_iter()
    .enumerate()
    {
        let row_id: Uuid = sqlx::query_scalar(
            "INSERT INTO data_import_rows (org_id, run_id, source_sheet, source_row, source_key, row_status, canonical_row) \
             VALUES ($1, $2, 'Pay', $3, $4, 'CANDIDATE', $5) RETURNING id",
        ).bind(*org.as_uuid()).bind(imp_run).bind(i as i32 + 1).bind(format!("k-{i}")).bind(json!({
            "payroll": {
                "monthly_gross_pay_won": 3_000_000,
                "base_pay_won": 2_500_000,
                "overtime_pay_won": 300_000,
                "meal_allowance_won": 200_000,
                "taxable_won": 2_800_000,
                "nts_tax_row": { "table_version": "NTS-2026-v1", "monthly_income_tax_won": 74_350, "local_income_tax_won": 7_430 }
            }
        })).fetch_one(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO payroll_draft_lines (org_id, run_id, employee_id, employee_source_key, employee_display_name, employee_company, attendance_source_row_count, overtime_hours, gross_pay_source_present, nts_tax_row_status, bank_account_registered, source_data_import_row_ids) \
             VALUES ($1, $2, $3, $4, $5, 'SAE', 20, 2.0, true, 'VERIFIED_SOURCE_ROW', $6, $7)",
        ).bind(*org.as_uuid()).bind(run).bind(emp).bind(format!("s-{emp}")).bind(name).bind(bank).bind(vec![row_id]).execute(&pool).await.unwrap();
    }

    sqlx::query("INSERT INTO period_locks (org_id, domain, period_start, period_end, reason) VALUES ($1, 'payroll', $2, $3, 'lock')")
        .bind(*org.as_uuid()).bind(date!(2026 - 06 - 01)).bind(date!(2026 - 06 - 30)).execute(&pool).await.unwrap();
    assert_eq!(
        send(
            &rt,
            &pub_pem,
            "POST",
            &format!("/api/v1/payroll/runs/{run}/close-attendance"),
            &hr_tok,
            Some(json!({"attest": true}))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        send(
            &rt,
            &pub_pem,
            "POST",
            &format!("/api/v1/payroll/runs/{run}/calculate"),
            &hr_tok,
            None
        )
        .await
        .0,
        StatusCode::OK
    );

    let (st, full) = send(
        &rt,
        &pub_pem,
        "GET",
        &format!("/api/v1/payroll/runs/{run}"),
        &hr_tok,
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{full}");
    assert_eq!(full["missing_bank_account_count"], 1);
    assert_eq!(full["lines"].as_array().unwrap().len(), 2);
    assert_eq!(full["lines"][0]["base_pay_won"], 2_500_000);
    assert_eq!(full["lines"][0]["overtime_pay_won"], 300_000);
    assert_eq!(full["lines"][0]["meal_allowance_won"], 200_000);
    assert_eq!(full["lines"][0]["taxable_won"], 2_800_000);

    let (st, miss) = send(
        &rt,
        &pub_pem,
        "GET",
        &format!("/api/v1/payroll/runs/{run}?missing_bank_only=true"),
        &hr_tok,
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{miss}");
    assert_eq!(miss["missing_bank_account_count"], 1);
    assert_eq!(miss["lines"].as_array().unwrap().len(), 1);
    assert_eq!(miss["lines"][0]["employee_display_name"], "Bob");

    let (st, q_res) = send(
        &rt,
        &pub_pem,
        "GET",
        &format!("/api/v1/payroll/runs/{run}?q=Alice"),
        &hr_tok,
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{q_res}");
    assert_eq!(q_res["missing_bank_account_count"], 1);
    assert_eq!(q_res["lines"].as_array().unwrap().len(), 1);
    assert_eq!(q_res["lines"][0]["employee_display_name"], "Alice");

    assert_eq!(
        send(
            &rt,
            &pub_pem,
            "GET",
            &format!("/api/v1/payroll/runs/{run}"),
            &member_tok,
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        send(
            &rt,
            &pub_pem,
            "GET",
            &format!("/api/v1/payroll/runs/{run}"),
            &outsider_tok,
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    let (st, me) = send(
        &rt,
        &pub_pem,
        "GET",
        "/api/v1/payroll/payslips/me",
        &member_tok,
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{me}");
    let item = &me["items"][0];
    for forbidden in [
        "gross_won",
        "net_won",
        "base_pay_won",
        "overtime_pay_won",
        "meal_allowance_won",
        "taxable_won",
        "deductions",
        "kind",
        "legal_basis",
    ] {
        assert!(
            item.get(forbidden).is_none(),
            "readiness-only /payslips/me must omit {forbidden}: {item}"
        );
    }
}
