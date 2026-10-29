#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! GC-2026-07-KR-MONTHLY-A over HTTP, on a real `console_rt` pool with RLS
//! actually enforced.
//!
//! The point of this file is that the golden case is not a unit-test artifact:
//! a real employee, a real stored contract, a real July 2026 timesheet, one
//! `GET`, and every 4대보험 figure matching the hand calculation to the won.
//!
//! It also pins the two things a payslip must never do quietly: it must not
//! emit a zero for a deduction it did not compute, and its stored citations
//! must not drift from the arithmetic they claim to justify.

#[path = "fixtures/pay_view.rs"]
mod pay_view;
#[path = "support/payslip_privacy.rs"]
mod payslip_privacy;

use axum::body::{Body, to_bytes};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_ontology_canonical_adapter_postgres::company::{
    CompanyCommand, CompanyQuery, PgCompanyPort,
};
use console_ontology_canonical_adapter_postgres::employment::{
    EmploymentAttributes, EmploymentCommand, EmploymentQuery, NewEmployeeRecord, PgEmploymentPort,
    insert_employee_record,
};
use console_ontology_canonical_adapter_postgres::job_position::{
    JobPositionCommand, JobPositionQuery, PgJobPositionPort,
};
use console_ontology_canonical_adapter_postgres::org_unit::{
    OrgUnitCommand, OrgUnitQuery, PgOrgUnitPort,
};
use console_ontology_canonical_adapter_postgres::person::{
    PersonCommand, PersonQuery, PgPersonPort,
};
use console_ontology_canonical_domain::{CanonicalPort, CommandId, CommandReceipt, DispatchTarget};
use console_payroll_adapter_postgres::PgPayrollStore;
use console_payroll_domain::{ContributionCode, statutory_contribution_rates};
use console_payroll_rest::{PayrollRestState, router};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_db::{DbError, with_audit};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use http::{Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::macros::date;
use time::{Date, Duration, OffsetDateTime, Time};
use tower::ServiceExt;
use uuid::Uuid;

const TEST_ISSUER: &str = "console-platform-auth";
const TEST_AUDIENCE: &str = "console-api";

struct Keys {
    private_pem: String,
    public_pem: String,
}

struct JsonResponse {
    status: StatusCode,
    json: Value,
}

fn keys() -> Keys {
    let signing_key = SigningKey::random(&mut OsRng);
    Keys {
        private_pem: signing_key
            .to_pkcs8_pem(LineEnding::LF)
            .unwrap()
            .to_string(),
        public_pem: signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap(),
    }
}

async fn bearer(
    pool: &sqlx::PgPool,
    keys: &Keys,
    user_id: UserId,
    org: OrgId,
    role: &str,
) -> String {
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: TEST_ISSUER.to_owned(),
            audience: TEST_AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.private_pem.as_bytes(),
        keys.public_pem.as_bytes(),
    )
    .unwrap();
    console_platform_test_support::issue_session_token(
        pool,
        &issuer,
        AccessTokenInput {
            subject: user_id,
            org_id: org,
            roles: vec![role.to_owned()],
            branches: Vec::new(),
            platform: false,
            support: None,
            read_only: false,
            display_name: None,
            feature_grants: Vec::new(),
            authz_subject_version: 0,
            authz_policy_version: 0,
            session_generation: 0,
            issued_at: OffsetDateTime::now_utc(),
        },
        None,
        Vec::new(),
    )
    .await
}

fn app(pool: PgPool, keys: &Keys) -> axum::Router {
    let verifier = JwtVerifier::from_es256_public_pem(
        JwtSettings {
            issuer: TEST_ISSUER.to_owned(),
            audience: TEST_AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.public_pem.as_bytes(),
    )
    .unwrap();
    router(PayrollRestState::new(
        PgPayrollStore::new(pool),
        Some(verifier),
    ))
}

async fn send(service: axum::Router, request: Request<Body>) -> JsonResponse {
    let response = service.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
    JsonResponse { status, json }
}

async fn get(service: axum::Router, uri: &str, token: &str) -> JsonResponse {
    send(
        service,
        Request::builder()
            .uri(uri)
            .method("GET")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await
}

async fn post(service: axum::Router, uri: &str, token: &str, body: Value) -> JsonResponse {
    send(
        service,
        Request::builder()
            .uri(uri)
            .method("POST")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
    )
    .await
}

fn seed_event(action: &str, target_type: &str, target_id: impl ToString, org: Uuid) -> AuditEvent {
    AuditEvent::new(
        None,
        AuditAction::new(action).unwrap(),
        target_type,
        target_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(OrgId::from_uuid(org))
}

async fn seed_org(owner_pool: &PgPool, org: Uuid) {
    with_audit(
        owner_pool,
        seed_event("test.seed_org", "organization", org, org),
        |tx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO organizations (id, slug, name) VALUES ($1, 'org-gc', 'Org GC') \
                 ON CONFLICT (id) DO NOTHING",
                )
                .bind(org)
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
                Ok::<(), DbError>(())
            })
        },
    )
    .await
    .unwrap();
}

#[path = "support/payslip_seed_user.rs"]
mod payslip_seed_user;
use payslip_seed_user::seed_user;

async fn seed_employee(owner_pool: &PgPool, org: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    let name = name.to_owned();
    with_audit(
        owner_pool,
        seed_event("test.seed_employee", "employee", id, org),
        |tx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO employees \
                     (id, org_id, company, name, source_filename, source_sheet, source_row, source_key) \
                     VALUES ($1, $2, 'SAE', $3, 'roster.xlsx', 'Sheet1', 1, $4)",
                )
                .bind(id)
                .bind(org)
                .bind(name)
                .bind(format!("emp-{id}"))
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
                Ok::<(), DbError>(())
            })
        },
    )
    .await
    .unwrap();
    id
}

/// The real July 2026 timesheet: 23 소정근로일 (July 2026 starts on a Wednesday;
/// 4 Saturdays, 4 Sundays, and 제헌절 7/17 is not a public holiday), one
/// CLOCK_IN/CLOCK_OUT pair each.
/// Seeds the FIRST `days` weekdays of July 2026, each with a paired
/// CLOCK_IN/CLOCK_OUT. `days = 23` is the whole month; anything less is a
/// partial-but-balanced timesheet.
async fn seed_july_2026_timesheet(
    owner_pool: &PgPool,
    org: Uuid,
    employee: Uuid,
    actor: UserId,
    days: usize,
) -> usize {
    let work_dates: Vec<Date> = (1..=31)
        .map(|day| Date::from_calendar_date(2026, time::Month::July, day).unwrap())
        .filter(|day| (day.weekday().number_days_from_monday()) < 5)
        .take(days)
        .collect();
    assert_eq!(work_dates.len(), days, "July 2026 has 23 weekdays");

    for (index, work_date) in work_dates.iter().enumerate() {
        for (kind, state_after) in [("CLOCK_IN", "CLOCKED_IN"), ("CLOCK_OUT", "OFF_DUTY")] {
            let work_date = *work_date;
            with_audit(
                owner_pool,
                seed_event("test.seed_attendance", "employee", employee, org),
                |tx| {
                    Box::pin(async move {
                        sqlx::query(
                            "INSERT INTO employee_attendance_records \
                             (org_id, employee_id, actor_user_id, kind, occurred_at, work_date, \
                              state_after, idempotency_key) \
                             VALUES ($1, $2, $3, $4, $5::date, $5, $6, $7)",
                        )
                        .bind(org)
                        .bind(employee)
                        .bind(*actor.as_uuid())
                        .bind(kind)
                        .bind(work_date)
                        .bind(state_after)
                        .bind(format!("{kind}-{work_date}-{index}"))
                        .execute(tx.as_mut())
                        .await
                        .map_err(DbError::Sqlx)?;
                        Ok::<(), DbError>(())
                    })
                },
            )
            .await
            .unwrap();
        }
    }
    work_dates.len()
}

fn deduction<'a>(body: &'a Value, code: &str) -> &'a Value {
    body["deductions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|line| line["code"] == code)
        .unwrap_or_else(|| panic!("no {code} deduction line in {body}"))
}

/// A 403/404 must not carry compensation fields or the target's name.
/// A richer error body than a missing id would be an existence oracle.
fn assert_no_compensation_payload(body: &Value, employee_name: &str) {
    let text = body.to_string();
    assert!(
        !text.contains(employee_name),
        "response leaked employee identity: {body}"
    );
    for key in [
        "gross_won",
        "deductions",
        "contract",
        "net_pay_won",
        "earnings",
        "remainder_after_insurance_won",
        "total_employee_insurance_won",
        "employee_name",
        "issuable",
        "blockers",
    ] {
        assert!(
            body.get(key).is_none(),
            "denied/omitted body must not carry compensation field {key}: {body}"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn golden_case_gc_2026_07_kr_monthly_a_over_http_matches_the_hand_calculation(
    owner_pool: PgPool,
) {
    let pool = runtime_role_pool(&owner_pool).await;
    let keys = keys();
    let org = OrgId::one();
    let actor = UserId::new();

    seed_org(&owner_pool, *org.as_uuid()).await;
    seed_user(&owner_pool, actor, *org.as_uuid(), "EXECUTIVE").await;
    pay_view::grant_manage(&owner_pool, org, actor, None).await;
    let employee = seed_employee(&owner_pool, *org.as_uuid(), "김근로").await;
    let worked_days =
        seed_july_2026_timesheet(&owner_pool, *org.as_uuid(), employee, actor, 23).await;
    let token = bearer(&owner_pool, &keys, actor, org, "EXECUTIVE").await;

    // 근로계약: 월 기본급 3,000,000원, 월 소정근로시간 209h, 시행 2025-03-02.
    // Written over HTTP, so the whole vertical is reachable by a user.
    let created = post(
        app(pool.clone(), &keys),
        &format!("/api/v1/payroll/employees/{employee}/contract-wages"),
        &token,
        json!({
            "effective_from": "2025-03-02",
            "wage_kind": "MONTHLY",
            "amount_won": 3_000_000,
            "monthly_standard_hours": 209,
            "source_note": "GC-2026-07-KR-MONTHLY-A 근로계약서"
        }),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);

    let response = get(
        app(pool.clone(), &keys),
        &format!(
            "/api/v1/payroll/employees/{employee}/payslip-draft?period=2026-07&pay_date=2026-08-10"
        ),
        &token,
    )
    .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.json);
    let body = response.json;

    // The real contract and the real timesheet reached the computation.
    assert_eq!(body["contract"]["amount_won"], 3_000_000);
    assert_eq!(body["contract"]["monthly_standard_hours"], 209);
    assert_eq!(body["contract"]["effective_from"], "2025-03-02");
    assert_eq!(body["attendance"]["worked_days"], worked_days as i64);
    assert_eq!(body["attendance"]["worked_days"], 23);
    assert_eq!(body["attendance"]["clock_out_events"], 23);

    // ── 지급 ──
    assert_eq!(body["gross_won"], 3_000_000);
    assert_eq!(body["earnings"][0]["amount_won"], 3_000_000);

    // ── 공제, to the won ──
    // 1-2. 기준소득월액 3,000,000 (clamp 410,000..6,590,000 미구속)
    //      × 475/10,000 = 142,500
    let pension = deduction(&body, "NationalPension");
    assert_eq!(pension["basis_won"], 3_000_000);
    assert_eq!(pension["employee_won"], 142_500);
    assert_eq!(pension["instrument"]["promulgation_ko"], "법률 제20903호");

    // 3-4. 3,000,000 × 719/10,000 = 215,700 → trunc10 → clamp → 215,700; 절반 107,850
    let health = deduction(&body, "HealthInsurance");
    assert_eq!(health["total_won"], 215_700);
    assert_eq!(health["employee_won"], 107_850);
    assert_eq!(health["total_rounding"], "TRUNC_10_WON");
    assert!(
        health["share_instrument"]["article_ko"]
            .as_str()
            .unwrap()
            .contains("100분의 50씩")
    );

    // 5-6. 215,700 × 9,448/71,900 = 28,344 → trunc10 → 28,340; 절반 14,170.
    //      basis is the 건강보험료액, NOT 보수월액 — the fix this slice exists for.
    let ltc = deduction(&body, "LongTermCare");
    assert_eq!(ltc["basis_kind"], "HealthInsurancePremium");
    assert_eq!(ltc["basis_won"], 215_700);
    assert_eq!(ltc["total_won"], 28_340);
    assert_eq!(ltc["employee_won"], 14_170);
    // The pre-existing naive model produced 14,172. Prove it is gone.
    assert_ne!(ltc["employee_won"], 14_172);

    // 7. 3,000,000 × 9/1,000 = 27,000
    assert_eq!(
        deduction(&body, "EmploymentUnemployment")["employee_won"],
        27_000
    );

    // 8. 산재 — 사업주 전액 부담. Present and STATED, not silently missing.
    let industrial = deduction(&body, "IndustrialAccident");
    assert_eq!(industrial["employer_only"], true);
    assert!(industrial["employee_won"].is_null());
    assert!(
        industrial["instrument"]["article_ko"]
            .as_str()
            .unwrap()
            .contains("제13조제5항")
    );
    // Every EMPLOYER figure is null, never 0: the 사업종류별 요율 is in 고시
    // 제2025-91호's unparsed 별지, so a 0 anywhere here would publish "산재 costs
    // nothing" — the silently-zero failure this engine exists to refuse.
    for field in ["total_won", "basis_won", "rate_num", "rate_den"] {
        assert!(
            industrial[field].is_null(),
            "산재 {field}은 미산정(null)이어야 하며 0이어서는 안 된다: {industrial}"
        );
    }
    // The other four components DID compute their basis and rate, so the nulls
    // above are 산재's own refusal and not a serializer that dropped everything.
    for code in [
        "NationalPension",
        "HealthInsurance",
        "LongTermCare",
        "EmploymentUnemployment",
    ] {
        let line = deduction(&body, code);
        assert!(line["basis_won"].is_i64(), "{code}: {line}");
        assert!(line["rate_num"].is_i64(), "{code}: {line}");
        assert!(line["rate_den"].is_i64(), "{code}: {line}");
    }

    // 4대보험 공제계 291,520 / 잔액 2,708,480
    assert_eq!(body["total_employee_insurance_won"], 291_520);
    assert_eq!(body["remainder_after_insurance_won"], 2_708_480);

    // 최저임금 CHECK: 3,000,000 ÷ 209 = 14,354 ≥ 10,320
    assert_eq!(body["minimum_wage_check"]["effective_hourly_won"], 14_354);
    assert_eq!(body["minimum_wage_check"]["passes"], true);
    assert_eq!(body["minimum_wage_check"]["hourly_floor_won"], 10_320);
    assert_eq!(
        body["minimum_wage_check"]["instrument"]["promulgation_ko"],
        "고용노동부고시 제2025-47호 (발령 2025. 8. 5.)"
    );

    // Every citation is served with the draft, so the payslip is self-describing.
    let citations = body["statutory_citations"].as_array().unwrap();
    assert!(citations.len() >= 8, "expected the whole register in force");
    assert!(citations.iter().all(|row| {
        !row["instrument_ko"].as_str().unwrap().trim().is_empty()
            && !row["article_ko"].as_str().unwrap().trim().is_empty()
            && !row["promulgation_ko"].as_str().unwrap().trim().is_empty()
            && row["source_url"]
                .as_str()
                .unwrap()
                .starts_with("https://www.law.go.kr/")
    }));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn withholding_is_explicitly_deferred_and_never_a_silent_zero(owner_pool: PgPool) {
    let pool = runtime_role_pool(&owner_pool).await;
    let keys = keys();
    let org = OrgId::one();
    let actor = UserId::new();

    seed_org(&owner_pool, *org.as_uuid()).await;
    seed_user(&owner_pool, actor, *org.as_uuid(), "EXECUTIVE").await;
    pay_view::grant_manage(&owner_pool, org, actor, None).await;
    let employee = seed_employee(&owner_pool, *org.as_uuid(), "김근로").await;
    let token = bearer(&owner_pool, &keys, actor, org, "EXECUTIVE").await;

    post(
        app(pool.clone(), &keys),
        &format!("/api/v1/payroll/employees/{employee}/contract-wages"),
        &token,
        json!({
            "effective_from": "2025-03-02",
            "wage_kind": "MONTHLY",
            "amount_won": 3_000_000,
            "monthly_standard_hours": 209
        }),
    )
    .await;

    let body = get(
        app(pool.clone(), &keys),
        &format!(
            "/api/v1/payroll/employees/{employee}/payslip-draft?period=2026-07&pay_date=2026-08-10"
        ),
        &token,
    )
    .await
    .json;

    // The refusal is IN the response, naming the instrument that would supply it.
    let not_computed = body["not_computed"].as_array().unwrap();
    let income_tax = not_computed
        .iter()
        .find(|row| row["code"] == "IncomeTax")
        .expect("근로소득세 must appear as explicitly not computed");
    assert!(
        income_tax["instrument"]["name_ko"]
            .as_str()
            .unwrap()
            .contains("소득세법 시행령 별표 2")
    );
    // The version anchor is the semantic 별표HWP파일명, never the unstable flSeq.
    let article = income_tax["instrument"]["article_ko"].as_str().unwrap();
    assert!(article.contains("law0039562026052236343KC_000200E_20260701.hwp"));
    assert!(!article.contains("flSeq"));

    let local = not_computed
        .iter()
        .find(|row| row["code"] == "LocalIncomeTax")
        .expect("지방소득세 must appear as explicitly not computed");
    assert!(
        local["instrument"]["article_ko"]
            .as_str()
            .unwrap()
            .contains("제103조의13제1항")
    );

    // Not a zero, not a guess, and not issuable.
    assert!(body["net_pay_won"].is_null());
    assert_eq!(body["issuable"], false);
    let blockers: Vec<&str> = body["blockers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|blocker| blocker.as_str().unwrap())
        .collect();
    assert!(blockers.contains(&"WITHHOLDING_NOT_COMPUTED"));
    // And no tax line ever appears among the computed deductions.
    assert!(
        !body["deductions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line["label_ko"].as_str().unwrap().contains("소득세"))
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn seeded_statutory_rate_register_agrees_with_the_kernel_it_cites(owner_pool: PgPool) {
    use console_payroll_domain::{
        ContributionBasis as B, ShareRule as S, minimum_wage_rates, national_pension_base_limits,
        simplified_withholding_table_instruments,
    };
    use std::collections::BTreeSet;
    let register_code = |code: ContributionCode| match code {
        ContributionCode::NationalPension => "NATIONAL_PENSION_EMPLOYEE",
        ContributionCode::HealthInsurance => "HEALTH_INSURANCE_TOTAL",
        ContributionCode::LongTermCare => "LONG_TERM_CARE_TOTAL",
        ContributionCode::EmploymentUnemployment => "EMPLOYMENT_INSURANCE_EMPLOYEE",
        ContributionCode::IndustrialAccident => "INDUSTRIAL_ACCIDENT_EMPLOYEE",
    };
    let rates = statutory_contribution_rates();
    let mut periods = Vec::new();
    for rate in &rates {
        if rate.code == ContributionCode::HealthInsurance {
            let band = console_payroll_domain::health_premium_band_on(rate.period.from).ok();
            let stored: Option<(Option<i64>, Option<i64>)> = sqlx::query_as("SELECT floor_won, cap_won FROM payroll_statutory_rates WHERE code = 'HEALTH_PREMIUM_BAND' AND effective_from <= $1 AND effective_to_exclusive > $1").bind(rate.period.from).fetch_optional(&owner_pool).await.unwrap();
            assert_eq!(
                stored,
                band.map(|b| (Some(b.floor_won), Some(b.cap_won))),
                "band presence {}",
                rate.period.from
            );
        }
        let basis = match rate.basis {
            B::MonthlyStandardIncome => "PENSION_STANDARD_INCOME",
            B::MonthlyRemuneration => "MONTHLY_REMUNERATION",
            B::HealthInsurancePremium => "HEALTH_INSURANCE_PREMIUM",
            B::IndustryTariff => "INDUSTRY_TARIFF",
        };
        let bearer = match rate.employee_share {
            S::WholeOfRate => "EMPLOYEE_WHOLE",
            S::Half { .. } => "HALF_EACH",
            S::EmployerOnly => "EMPLOYER_ONLY",
        };
        periods.push((
            register_code(rate.code),
            rate.period,
            (Some(rate.rate_num), Some(rate.rate_den), None, None),
            (basis, bearer),
            rate.instrument,
            Some(rate.provenance),
        ));
    }
    for band in national_pension_base_limits() {
        periods.push((
            "PENSION_STANDARD_INCOME_BAND",
            band.period,
            (None, None, Some(band.minimum_won), Some(band.maximum_won)),
            ("PENSION_STANDARD_INCOME", "NOT_APPLICABLE"),
            band.instrument,
            None,
        ));
    }
    for (period, band) in console_payroll_domain::health_premium_bands() {
        periods.push((
            "HEALTH_PREMIUM_BAND",
            period,
            (None, None, Some(band.floor_won), Some(band.cap_won)),
            ("MONTHLY_REMUNERATION", "NOT_APPLICABLE"),
            band.instrument,
            None,
        ));
    }
    for wage in minimum_wage_rates() {
        periods.push((
            "MINIMUM_WAGE",
            wage.period,
            (
                None,
                None,
                Some(wage.hourly_won),
                Some(wage.monthly_209h_won),
            ),
            ("MONTHLY_REMUNERATION", "NOT_APPLICABLE"),
            wage.instrument,
            None,
        ));
    }
    for (period, instrument) in simplified_withholding_table_instruments() {
        periods.push((
            "SIMPLIFIED_WITHHOLDING_TABLE",
            period,
            (None, None, None, None),
            ("NOT_APPLICABLE", "NOT_APPLICABLE"),
            instrument,
            None,
        ));
    }
    let mut kernel_keys = BTreeSet::new();
    for (code, period, amounts, (basis, bearer), instrument, provenance) in periods {
        let from = period.from;
        assert!(
            kernel_keys.insert((code.to_string(), from)),
            "duplicate kernel period {code} {from}"
        );
        let row = sqlx::query_as::<_, (Option<Date>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, String, String, String, Date, String)>(
            "SELECT effective_to_exclusive, rate_num, rate_den, floor_won, cap_won, basis, bearer, promulgation_ko, enforced_on, provenance_ko FROM payroll_statutory_rates WHERE code = $1 AND effective_from = $2"
        ).bind(code).bind(from).fetch_optional(&owner_pool).await.unwrap().unwrap_or_else(|| panic!("{code} {from}: missing DB period"));
        assert_eq!(
            (row.0, (row.1, row.2, row.3, row.4)),
            (period.to_exclusive, amounts),
            "{code} {from}"
        );
        assert_eq!(
            (row.5.as_str(), row.6.as_str(), row.7.as_str(), row.8),
            (
                basis,
                bearer,
                instrument.promulgation_ko,
                instrument.enforced_on
            ),
            "{code} {from}"
        );
        if let Some(provenance) = provenance {
            assert_eq!(row.9, provenance, "{code} {from}");
        }
    }
    let db_keys: BTreeSet<(String, Date)> =
        sqlx::query_as("SELECT code, effective_from FROM payroll_statutory_rates")
            .fetch_all(&owner_pool)
            .await
            .unwrap()
            .into_iter()
            .collect();
    assert_eq!(
        db_keys, kernel_keys,
        "every DB period must have a kernel period"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn draft_is_gated_org_wide_and_blocks_rather_than_inventing_a_wage(owner_pool: PgPool) {
    let pool = runtime_role_pool(&owner_pool).await;
    let keys = keys();
    let org = OrgId::one();

    seed_org(&owner_pool, *org.as_uuid()).await;
    let employee = seed_employee(&owner_pool, *org.as_uuid(), "김근로").await;

    let member = UserId::new();
    seed_user(&owner_pool, member, *org.as_uuid(), "MEMBER").await;
    let member_token = bearer(&owner_pool, &keys, member, org, "MEMBER").await;
    let denied = get(
        app(pool.clone(), &keys),
        &format!("/api/v1/payroll/employees/{employee}/payslip-draft?period=2026-07"),
        &member_token,
    )
    .await;
    assert_eq!(
        denied.status,
        StatusCode::FORBIDDEN,
        "compensation-adjacent reads of another person's data are org-wide gated"
    );
    assert_eq!(denied.json["error"]["code"], "forbidden");
    assert_no_compensation_payload(&denied.json, "김근로");

    // Same 403 for a UUID that does not exist — MEMBER must not get a 404
    // that would distinguish "coworker" from "never heard of".
    let denied_missing = get(
        app(pool.clone(), &keys),
        &format!(
            "/api/v1/payroll/employees/{}/payslip-draft?period=2026-07",
            Uuid::new_v4()
        ),
        &member_token,
    )
    .await;
    assert_eq!(denied_missing.status, StatusCode::FORBIDDEN);
    assert_eq!(denied_missing.json["error"]["code"], "forbidden");
    assert_eq!(
        denied.json["error"]["code"],
        denied_missing.json["error"]["code"]
    );

    // No contract wage in force: a BLOCKER, not a zero payslip and not a 404.
    let executive = UserId::new();
    seed_user(&owner_pool, executive, *org.as_uuid(), "EXECUTIVE").await;
    pay_view::grant_manage(&owner_pool, org, executive, None).await;
    let token = bearer(&owner_pool, &keys, executive, org, "EXECUTIVE").await;
    let body = get(
        app(pool.clone(), &keys),
        &format!("/api/v1/payroll/employees/{employee}/payslip-draft?period=2026-07"),
        &token,
    )
    .await;
    assert_eq!(body.status, StatusCode::OK);
    assert_eq!(body.json["issuable"], false);
    assert_eq!(body.json["blockers"][0], "CONTRACT_WAGE_NOT_IN_FORCE");
    assert!(body.json["contract"].is_null());
    assert!(
        body.json.get("gross_won").is_none() || body.json["gross_won"].is_null(),
        "blocked draft must not invent a wage: {}",
        body.json
    );
    assert!(
        body.json.get("deductions").is_none() || body.json["deductions"].is_null(),
        "blocked draft must not invent deductions: {}",
        body.json
    );

    // A future-dated contract stays invisible until its own effective date —
    // which is why history is stored rather than overwritten.
    post(
        app(pool.clone(), &keys),
        &format!("/api/v1/payroll/employees/{employee}/contract-wages"),
        &token,
        json!({
            "effective_from": "2027-01-01",
            "wage_kind": "MONTHLY",
            "amount_won": 4_000_000,
            "monthly_standard_hours": 209
        }),
    )
    .await;
    let body = get(
        app(pool.clone(), &keys),
        &format!(
            "/api/v1/payroll/employees/{employee}/payslip-draft?period=2026-07&pay_date=2026-08-10"
        ),
        &token,
    )
    .await;
    assert_eq!(body.json["blockers"][0], "CONTRACT_WAGE_NOT_IN_FORCE");
    assert_eq!(body.json["issuable"], false);

    // An in-force wage is still not issuable: withholding is named, never a
    // silent zero, and never client-side tax math.
    let created = post(
        app(pool.clone(), &keys),
        &format!("/api/v1/payroll/employees/{employee}/contract-wages"),
        &token,
        json!({
            "effective_from": "2025-03-02",
            "wage_kind": "MONTHLY",
            "amount_won": 3_000_000,
            "monthly_standard_hours": 209
        }),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
    let body = get(
        app(pool.clone(), &keys),
        &format!(
            "/api/v1/payroll/employees/{employee}/payslip-draft?period=2026-07&pay_date=2026-08-10"
        ),
        &token,
    )
    .await;
    assert_eq!(body.status, StatusCode::OK, "{}", body.json);
    assert_eq!(body.json["issuable"], false);
    assert!(body.json["net_pay_won"].is_null());
    let blockers: Vec<&str> = body.json["blockers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|blocker| blocker.as_str().unwrap())
        .collect();
    assert!(
        blockers.contains(&"WITHHOLDING_NOT_COMPUTED"),
        "withholding must stay an explicit blocker, never a silent zero: {blockers:?}"
    );
    assert!(
        !body.json["deductions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line["label_ko"].as_str().unwrap().contains("소득세")),
        "no client-side tax line: {}",
        body.json
    );

    // MEMBER still 403 once figures exist — the 403 body must not leak them.
    let denied_after_wage = get(
        app(pool.clone(), &keys),
        &format!(
            "/api/v1/payroll/employees/{employee}/payslip-draft?period=2026-07&pay_date=2026-08-10"
        ),
        &member_token,
    )
    .await;
    assert_eq!(denied_after_wage.status, StatusCode::FORBIDDEN);
    assert_eq!(denied_after_wage.json["error"]["code"], "forbidden");
    assert_no_compensation_payload(&denied_after_wage.json, "김근로");
    let denied_text = denied_after_wage.json.to_string();
    assert!(
        !denied_text.contains("3000000"),
        "403 leaked a wage figure: {denied_text}"
    );
    assert!(
        !denied_text.contains("3,000,000"),
        "403 leaked a formatted wage: {denied_text}"
    );

    // Cross-tenant: an employee that exists only in another org is 404-omit,
    // the same envelope as a missing id — never 403, which would prove the
    // id exists somewhere. Matches payroll run GET 404-omit.
    let other_org = Uuid::new_v4();
    with_audit(
        &owner_pool,
        seed_event("test.seed_org", "organization", other_org, other_org),
        |tx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO organizations (id, slug, name) VALUES ($1, 'org-foreign', 'Org Foreign')",
                )
                .bind(other_org)
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
                Ok::<(), DbError>(())
            })
        },
    )
    .await
    .unwrap();
    let foreign = seed_employee(&owner_pool, other_org, "박타사").await;
    let foreign_draft = get(
        app(pool.clone(), &keys),
        &format!(
            "/api/v1/payroll/employees/{foreign}/payslip-draft?period=2026-07&pay_date=2026-08-10"
        ),
        &token,
    )
    .await;
    let missing_id = Uuid::new_v4();
    let missing_draft = get(
        app(pool.clone(), &keys),
        &format!(
            "/api/v1/payroll/employees/{missing_id}/payslip-draft?period=2026-07&pay_date=2026-08-10"
        ),
        &token,
    )
    .await;
    assert_eq!(
        foreign_draft.status,
        StatusCode::NOT_FOUND,
        "another org's employee must 404-omit, not 403: {}",
        foreign_draft.json
    );
    assert_eq!(
        missing_draft.status,
        StatusCode::NOT_FOUND,
        "{}",
        missing_draft.json
    );
    assert_eq!(foreign_draft.json["error"]["code"], "not_found");
    assert_eq!(
        foreign_draft.json["error"]["code"],
        missing_draft.json["error"]["code"]
    );
    assert_eq!(
        foreign_draft.json["error"]["message"],
        missing_draft.json["error"]["message"]
    );
    assert_no_compensation_payload(&foreign_draft.json, "박타사");
    assert_no_compensation_payload(&missing_draft.json, "박타사");
}

/// F4 — the timesheet is load-bearing or it is not claimed.
///
/// Before this, an employee with ZERO attendance records for the period got a
/// byte-identical full-month draft with nothing naming the absence. The draft
/// is not allowed to look complete on data it never read.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_period_with_no_attendance_records_blocks_instead_of_paying_a_full_month(
    owner_pool: PgPool,
) {
    let pool = runtime_role_pool(&owner_pool).await;
    let keys = keys();
    let org = OrgId::one();
    let actor = UserId::new();

    seed_org(&owner_pool, *org.as_uuid()).await;
    seed_user(&owner_pool, actor, *org.as_uuid(), "EXECUTIVE").await;
    pay_view::grant_manage(&owner_pool, org, actor, None).await;
    let token = bearer(&owner_pool, &keys, actor, org, "EXECUTIVE").await;

    // Two employees, the SAME contract. Only the timesheet differs.
    let worked = seed_employee(&owner_pool, *org.as_uuid(), "김출근").await;
    let absent = seed_employee(&owner_pool, *org.as_uuid(), "이무기록").await;
    seed_july_2026_timesheet(&owner_pool, *org.as_uuid(), worked, actor, 23).await;

    for employee in [worked, absent] {
        let created = post(
            app(pool.clone(), &keys),
            &format!("/api/v1/payroll/employees/{employee}/contract-wages"),
            &token,
            json!({
                "effective_from": "2025-03-02",
                "wage_kind": "MONTHLY",
                "amount_won": 3_000_000,
                "monthly_standard_hours": 209
            }),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
    }

    let draft = |employee: Uuid| {
        let pool = pool.clone();
        let keys = &keys;
        let token = token.clone();
        async move {
            get(
                app(pool, keys),
                &format!(
                    "/api/v1/payroll/employees/{employee}/payslip-draft\
                     ?period=2026-07&pay_date=2026-08-10"
                ),
                &token,
            )
            .await
        }
    };

    let with_timesheet = draft(worked).await.json;
    let without_timesheet = draft(absent).await.json;

    // The absence is NAMED, with the counts.
    assert_eq!(without_timesheet["attendance"]["worked_days"], 0);
    let blockers = without_timesheet["blockers"].as_array().unwrap();
    let attendance_blocker = blockers
        .iter()
        .find_map(|b| {
            b.as_str()
                .filter(|b| b.starts_with("ATTENDANCE_INCOMPLETE"))
        })
        .unwrap_or_else(|| panic!("zero attendance must block: {without_timesheet}"));
    assert!(
        attendance_blocker.contains("worked_days=0"),
        "{attendance_blocker}"
    );
    assert!(
        attendance_blocker.contains("clock_in=0"),
        "{attendance_blocker}"
    );
    assert_eq!(without_timesheet["issuable"], false);

    // The employee WITH a complete timesheet carries no such blocker — so the
    // blocker tracks the data, not merely the fact that nothing is issuable.
    assert!(
        !with_timesheet["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b
                .as_str()
                .is_some_and(|b| b.starts_with("ATTENDANCE_INCOMPLETE"))),
        "a complete 23-day timesheet must not block: {with_timesheet}"
    );

    // The regression this closes: the two drafts used to be identical apart
    // from the employee id. Every 공제 figure still matches — the fix is a
    // blocker, not a silent proration — but the blocker lists now differ.
    assert_eq!(
        deduction(&with_timesheet, "NationalPension")["employee_won"],
        deduction(&without_timesheet, "NationalPension")["employee_won"],
        "attendance drives no figure in this slice; it must not have moved one"
    );
    assert_ne!(
        with_timesheet["blockers"], without_timesheet["blockers"],
        "an empty timesheet used to produce a byte-identical draft"
    );
}

/// F5 — "absent" was gated; "incomplete" was not.
///
/// A partial-but-BALANCED timesheet passed every check the previous round had:
/// `worked_days > 0` and `clock_in == clock_out`. The draft came back as a full
/// month with no attendance blocker at all, while its own earnings line reads
/// 완전출근 기준. Half a month of records is not evidence of a full month.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_partial_but_balanced_timesheet_blocks_although_every_punch_is_paired(
    owner_pool: PgPool,
) {
    let pool = runtime_role_pool(&owner_pool).await;
    let keys = keys();
    let org = OrgId::one();
    let actor = UserId::new();

    seed_org(&owner_pool, *org.as_uuid()).await;
    seed_user(&owner_pool, actor, *org.as_uuid(), "EXECUTIVE").await;
    pay_view::grant_manage(&owner_pool, org, actor, None).await;
    let token = bearer(&owner_pool, &keys, actor, org, "EXECUTIVE").await;

    // Same contract, same month. Only the number of recorded days differs, and
    // BOTH timesheets are balanced — 12 in / 12 out, 23 in / 23 out.
    let full = seed_employee(&owner_pool, *org.as_uuid(), "김만근").await;
    let half = seed_employee(&owner_pool, *org.as_uuid(), "박반근").await;
    assert_eq!(
        seed_july_2026_timesheet(&owner_pool, *org.as_uuid(), full, actor, 23).await,
        23
    );
    assert_eq!(
        seed_july_2026_timesheet(&owner_pool, *org.as_uuid(), half, actor, 12).await,
        12
    );

    for employee in [full, half] {
        let created = post(
            app(pool.clone(), &keys),
            &format!("/api/v1/payroll/employees/{employee}/contract-wages"),
            &token,
            json!({
                "effective_from": "2025-03-02",
                "wage_kind": "MONTHLY",
                "amount_won": 3_000_000,
                "monthly_standard_hours": 209
            }),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
    }

    let draft = |employee: Uuid| {
        let pool = pool.clone();
        let keys = &keys;
        let token = token.clone();
        async move {
            get(
                app(pool, keys),
                &format!(
                    "/api/v1/payroll/employees/{employee}/payslip-draft\
                     ?period=2026-07&pay_date=2026-08-10"
                ),
                &token,
            )
            .await
            .json
        }
    };
    let full_month = draft(full).await;
    let half_month = draft(half).await;

    // The punches ARE paired — the old unbalanced check would have passed this.
    assert_eq!(half_month["attendance"]["worked_days"], 12);
    assert_eq!(half_month["attendance"]["clock_in_events"], 12);
    assert_eq!(half_month["attendance"]["clock_out_events"], 12);

    let attendance_blocker = |body: &Value| -> Option<String> {
        body["blockers"].as_array().unwrap().iter().find_map(|b| {
            b.as_str()
                .filter(|b| b.starts_with("ATTENDANCE_INCOMPLETE"))
                .map(str::to_owned)
        })
    };

    let blocker =
        attendance_blocker(&half_month).expect("a 12-of-23-day month must not read as complete");
    assert!(blocker.contains("worked_days=12"), "{blocker}");
    assert!(blocker.contains("expected_working_days=23"), "{blocker}");
    assert_eq!(half_month["issuable"], false);

    // The complete month carries no such blocker, so the gate tracks the data
    // rather than merely restating that nothing is issuable.
    assert_eq!(attendance_blocker(&full_month), None);

    // And attendance still drives no FIGURE: the fix is a refusal, not a
    // 일할계산 this slice has no statutory basis to perform.
    assert_eq!(full_month["gross_won"], half_month["gross_won"]);
    for code in [
        "NationalPension",
        "HealthInsurance",
        "LongTermCare",
        "EmploymentUnemployment",
    ] {
        assert_eq!(
            deduction(&full_month, code)["employee_won"],
            deduction(&half_month, code)["employee_won"],
            "{code}: 근태는 이 슬라이스에서 금액을 움직이지 않는다"
        );
    }
}

/// F4 — three rows shipped in force before the decree that set them.
///
/// The pre-existing citation test compares each row to the PAY DATE, so a row
/// citing a decree enforced after its own `effective_from` passed it. The class
/// is closed by a CHECK rather than by three corrections, because corrections
/// do not survive the next 개정.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_rate_row_backdated_before_its_own_instrument_is_rejected(owner_pool: PgPool) {
    // That the migration ran at all proves every seeded row satisfies the
    // constraint; this proves the constraint is load-bearing rather than
    // decorative.
    let plant = |effective_from: &'static str, enforced_on: &'static str| {
        let pool = owner_pool.clone();
        async move {
            sqlx::query(
                "INSERT INTO payroll_statutory_rates \
                 (code, effective_from, effective_to_exclusive, rate_num, rate_den, floor_won, \
                  cap_won, basis, bearer, instrument_ko, article_ko, promulgation_ko, \
                  enforced_on, source_url, retrieved_on, provenance_ko) \
                 VALUES ('MINIMUM_WAGE', $1::date, NULL, NULL, NULL, 11000, 2299000, \
                  'MONTHLY_REMUNERATION', 'NOT_APPLICABLE', '2027년 적용 최저임금 고시', \
                  '시간급 11,000원', '고용노동부고시 제2026-99호', $2::date, \
                  'https://www.law.go.kr/행정규칙/2027년 적용 최저임금 고시', DATE '2026-08-01', \
                  '심어 놓은 행')",
            )
            .bind(effective_from)
            .bind(enforced_on)
            .execute(&pool)
            .await
        }
    };

    // In force from 2027-01-02 (away from the seeded annual row), citing a 고시 enforced 2027-06-01 — exactly the
    // shape 건강보험(2026-01-01 → 제36116호/2026-02-19) shipped in.
    let error = plant("2027-01-02", "2027-06-01")
        .await
        .expect_err("a row cannot be in force before the document that sets it");
    assert!(
        error
            .to_string()
            .contains("payroll_statutory_rates_not_backdated_before_instrument"),
        "the CHECK must be what rejects it, not an incidental error: {error}"
    );

    // Positive control: the same row, dated after its own instrument, stores.
    // Without this the assertion above would also pass on a table that rejects
    // every INSERT.
    plant("2027-01-02", "2026-12-30")
        .await
        .expect("a row whose instrument was already in force is storable");
}

/// Empty-tenant Company/OrgUnit/JobPosition/Person/`hr.appoint` then the same
/// HTTP payslip GET. Fixture `INSERT INTO employees` is not this path: the
/// employee id is the appointed person (`person_id = employee_id`). Does not
/// re-assert GC-2026-07 won arithmetic — that lives in the golden above.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn empty_tenant_payslip_draft_sits_on_canonical_org_tree(owner_pool: PgPool) {
    let tree = provision_empty_tenant_appointed_employee(&owner_pool).await;
    let pool = runtime_role_pool(&owner_pool).await;
    let keys = keys();
    pay_view::grant_manage(&owner_pool, tree.org, tree.actor, None).await;
    let token = bearer(&owner_pool, &keys, tree.actor, tree.org, "SUPER_ADMIN").await;
    let employee = tree.employee_id;

    let created = post(
        app(pool.clone(), &keys),
        &format!("/api/v1/payroll/employees/{employee}/contract-wages"),
        &token,
        json!({
            "effective_from": "2025-03-02",
            "wage_kind": "MONTHLY",
            "amount_won": 3_000_000,
            "monthly_standard_hours": 209,
            "source_note": "empty-tenant canonical tree"
        }),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);

    let response = get(
        app(pool, &keys),
        &format!(
            "/api/v1/payroll/employees/{employee}/payslip-draft?period=2026-07&pay_date=2026-08-10"
        ),
        &token,
    )
    .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.json);
    let body = response.json;
    assert_eq!(body["contract"]["amount_won"], 3_000_000);
    assert_eq!(body["contract"]["effective_from"], "2025-03-02");

    let attributes: Value = sqlx::query_scalar(
        "SELECT attributes FROM employment_revisions \
         WHERE org_id = $1 AND employment_id = $2 AND version = 1",
    )
    .bind(*tree.org.as_uuid())
    .bind(tree.employment_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(
        attributes["org_unit_id"].as_str().unwrap(),
        tree.sales.to_string()
    );
    assert_eq!(
        attributes["job_position_id"].as_str().unwrap(),
        tree.engineer.to_string()
    );
    let bound_employee: Uuid = sqlx::query_scalar(
        "SELECT employee_id FROM employment_source_bindings \
         WHERE org_id = $1 AND employment_id = $2",
    )
    .bind(*tree.org.as_uuid())
    .bind(tree.employment_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(bound_employee, tree.employee_id);
    let person_id: Uuid = sqlx::query_scalar(
        "SELECT person_id FROM employee_person_bindings \
         WHERE org_id = $1 AND employee_id = $2",
    )
    .bind(*tree.org.as_uuid())
    .bind(tree.employee_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(
        person_id, tree.employee_id,
        "a uniquely-resolved person is bound with person_id = employee_id"
    );
    assert_eq!(
        tree.appointed.target(),
        DispatchTarget::HrAppoint,
        "the employee the payslip named must have been minted by hr.appoint"
    );
}

struct EmptyTenantAppointedEmployee {
    org: OrgId,
    actor: UserId,
    sales: Uuid,
    engineer: Uuid,
    employee_id: Uuid,
    employment_id: Uuid,
    appointed: CommandReceipt,
}

async fn provision_empty_tenant_appointed_employee(
    owner_pool: &PgPool,
) -> EmptyTenantAppointedEmployee {
    const ORG: Uuid = Uuid::from_u128(0xe3b0_0000_0000_0000_0000_0000_0000_00a1);
    let actor = seed_org_and_super_admin(owner_pool, ORG, "payslip").await;
    let runtime_pool = runtime_role_pool(owner_pool).await;
    let handle = tokio::runtime::Handle::current();
    let company = PgCompanyPort::new(runtime_pool.clone(), handle.clone());
    let units = PgOrgUnitPort::new(runtime_pool.clone(), handle.clone());
    let positions = PgJobPositionPort::new(runtime_pool.clone(), handle.clone());
    let persons = PgPersonPort::new(runtime_pool.clone(), handle.clone());
    let employment = PgEmploymentPort::new(runtime_pool.clone(), handle);
    let org = OrgId::from_uuid(ORG);

    execute_sync(
        &company,
        CompanyCommand {
            org_id: org,
            command_id: CommandId::from_uuid(Uuid::new_v4()),
            actor_id: actor,
            query: CompanyQuery {
                attributes: json!({ "legal_name": "주식회사 아크메" }),
            },
            action_key: "company.revise".to_owned(),
            object_type_id: Uuid::nil(),
        },
    )
    .await
    .expect_err("company legal facts are owned by legal entities");

    let unit_receipt = execute_sync(
        &units,
        OrgUnitCommand {
            org_id: org,
            command_id: CommandId::from_uuid(Uuid::new_v4()),
            actor_id: actor,
            query: OrgUnitQuery::Create {
                source: None,
                attributes: json!({ "name": "영업본부", "kind": "site" }),
            },
            action_key: "create_org_unit".to_owned(),
            object_type_id: Uuid::nil(),
        },
    )
    .await
    .unwrap();
    let sales: Uuid = unit_receipt.result()["org_unit_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();

    let position_receipt = execute_sync(
        &positions,
        JobPositionCommand {
            org_id: org,
            command_id: CommandId::from_uuid(Uuid::new_v4()),
            actor_id: actor,
            query: JobPositionQuery::Create {
                org_unit_id: sales,
                attributes: json!({ "title": "백엔드 엔지니어" }),
            },
            action_key: "create_job_position".to_owned(),
            object_type_id: Uuid::nil(),
        },
    )
    .await
    .unwrap();
    let engineer: Uuid = position_receipt.result()["job_position_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();

    let employee_id = Uuid::new_v4();
    let sales_text = sales.to_string();
    let engineer_text = engineer.to_string();
    let mut tx = runtime_pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    insert_employee_record(
        &mut tx,
        ORG,
        NewEmployeeRecord {
            employee_id,
            company: "ACME",
            name: "김직원",
            employee_number: "E-PAY-1",
            org_unit: &sales_text,
            position: &engineer_text,
            worksite_name: "서울",
            hire_date: None,
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();

    execute_sync(
        &persons,
        PersonCommand {
            org_id: org,
            command_id: CommandId::from_uuid(Uuid::new_v4()),
            actor_id: actor,
            query: PersonQuery::Create {
                employee_id: Some(employee_id),
                attributes: json!({ "legal_name": "김직원" }),
            },
            action_key: "create_person".to_owned(),
            object_type_id: Uuid::nil(),
        },
    )
    .await
    .unwrap();

    let appointed = execute_sync(
        &employment,
        EmploymentCommand {
            org_id: org,
            command_id: CommandId::from_uuid(Uuid::new_v4()),
            actor_id: actor,
            query: EmploymentQuery::Appoint {
                employee_id,
                valid_from: OffsetDateTime::new_utc(date!(2026 - 01 - 01), Time::MIDNIGHT),
                attributes: EmploymentAttributes {
                    company: "ACME".to_owned(),
                    org_unit_id: Some(sales),
                    job_position_id: Some(engineer),
                    employment_status: "ACTIVE".to_owned(),
                },
            },
            action_key: "appoint".to_owned(),
            object_type_id: Uuid::nil(),
        },
    )
    .await
    .unwrap();
    let employment_id = appointed.result()["employment_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    EmptyTenantAppointedEmployee {
        org,
        actor,
        sales,
        engineer,
        employee_id,
        employment_id,
        appointed,
    }
}

async fn execute_sync<P: CanonicalPort + Clone + Send + 'static>(
    port: &P,
    command: P::Command,
) -> Result<CommandReceipt, P::Error>
where
    P::Command: Send + 'static,
    P::Error: Send + 'static,
{
    let port = port.clone();
    tokio::task::spawn_blocking(move || port.execute(&command))
        .await
        .unwrap()
}

/// The migration comment names the test that guards it. That name went stale
/// once — it said `payroll_statutory_rate_register_matches_kernel`, a test that
/// has never existed — so the name is now read back by the code it names.
///
/// Located by content, not by number: the integrator renumbers this migration
/// at merge and a hard-coded `0210_…` path would break on that rename.
#[test]
fn the_migration_names_the_test_that_actually_guards_it() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../platform/db/migrations");
    let sql = std::fs::read_dir(&dir)
        .expect("migrations directory")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "sql"))
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .find(|text| text.contains("CREATE TABLE payroll_statutory_rates"))
        .expect("the migration that creates payroll_statutory_rates");

    assert!(
        sql.contains("seeded_statutory_rate_register_agrees_with_the_kernel_it_cites"),
        "the migration must name the register-agreement test by its real name"
    );
    assert!(
        sql.contains("the_migration_names_the_test_that_actually_guards_it"),
        "the migration must name this test too, or nothing tells a reader the \
         name above is checked"
    );
}
