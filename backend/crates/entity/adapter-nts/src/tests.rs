// SPDX-License-Identifier: LicenseRef-Proprietary
//! Contract replay only: the real gateway and process secrets are never read.
use super::test_support::serve;
use super::*;
use console_platform_key_notice::KeyState;
use sha2::Digest;
use std::time::Duration;
use url::Url;

const STATUS: &str = include_str!("../tests/fixtures/status.json");
pub(super) const SECRET: &str = "fixture-key-never-log-8e2a";

pub(super) fn config(base: Url) -> NtsConfig {
    let mut c = NtsConfig::from_lookup(|_| None);
    c.base_url = base;
    c.key = Some(SECRET.into());
    c.timeout = Duration::from_millis(500);
    c.rate_per_minute = 50;
    c
}
pub(super) fn validation() -> UserValidation {
    UserValidation {
        brn: "0008100009".into(),
        opened_on: "2020-03-02".into(),
        representative: "홍길동".into(),
    }
}
pub(super) fn down() -> CheckFailure {
    CheckFailure::Unavailable(UnavailableReason::ProviderDown)
}
fn fixture() -> Value {
    serde_json::from_str(STATUS).unwrap()
}

#[test]
fn swagger_status_models_preserve_codes_dates_and_evidence_digest() {
    let out = parse::response(200, STATUS, CheckKind::Status).unwrap();
    assert_eq!(out.len(), 4);
    for (answer, code) in out
        .iter()
        .zip(["CONTINUING", "SUSPENDED", "CLOSED", "null"])
    {
        assert_eq!(answer.reported_status.map_or("null", |s| s.as_str()), code);
    }
    assert_eq!(out[0].tax_type_change_dt.as_deref(), Some("20200101"));
    assert_eq!(out[0].invoice_apply_dt.as_deref(), Some("20200102"));
    assert_eq!(out[2].end_dt.as_deref(), Some("20260930"));
    assert_eq!(out[2].utcc_yn.as_deref(), Some("Y"));
    assert_eq!(out[2].rbf_tax_type_cd.as_deref(), Some("07"));
    assert!(out[3].not_registered);
    assert_eq!(out[3].tax_type_cd, None);
    for a in out {
        assert_eq!(a.fields_sent, ["b_no"]);
        assert_eq!(a.provider_version, parse::PROVIDER_VERSION);
        assert_eq!(
            a.response_sha256,
            hex::encode(sha2::Sha256::digest(STATUS.as_bytes()))
        );
    }
}

#[test]
fn validation_models_distinguish_valid_and_invalid_without_echoing_personal_values() {
    let body = json!({"status_code":"OK","data":fixture()["validation"]}).to_string();
    let out = parse::response(200, &body, CheckKind::Validate).unwrap();
    assert_eq!(out[0].valid.as_deref(), Some("01"));
    assert_eq!(out[1].valid.as_deref(), Some("02"));
    assert_eq!(out[1].status_code, None);
    assert!(!out[1].not_registered);
    assert_eq!(out[0].fields_sent, ["b_no", "start_dt", "p_nm"]);
    assert!(!serde_json::to_string(&out).unwrap().contains("홍길동"));
}

#[test]
fn documented_http_and_gateway_errors_are_typed_and_redacted() {
    for case in fixture()["errors"].as_array().unwrap() {
        let body = json!({"code":case[1],"msg":SECRET}).to_string();
        assert_eq!(
            parse::response(
                u16::try_from(case[0].as_u64().unwrap()).unwrap(),
                &body,
                CheckKind::Status
            ),
            Err(down())
        );
    }
    for (code, reason) in [
        ("-4", UnavailableReason::KeyRejected),
        ("20", UnavailableReason::KeyRejected),
        ("30", UnavailableReason::KeyRejected),
        ("31", UnavailableReason::KeyExpired),
    ] {
        let body = json!({"code":code.parse::<i32>().unwrap(),"msg":SECRET}).to_string();
        let error = parse::response(401, &body, CheckKind::Status).unwrap_err();
        assert_eq!(error, CheckFailure::Unavailable(reason));
        assert!(!format!("{error:?}").contains(SECRET));
    }
    for code in ["22", "23"] {
        let body = json!({"status_code":code}).to_string();
        assert_eq!(
            parse::response(200, &body, CheckKind::Status),
            Err(CheckFailure::RateLimited {
                retry_after_seconds: 60,
                gateway_code: Some(code.into())
            })
        );
    }
    assert!(matches!(
        parse::response(429, "{}", CheckKind::Status),
        Err(CheckFailure::RateLimited {
            gateway_code: None,
            ..
        })
    ));
    assert_eq!(
        parse::response(200, "not json", CheckKind::Status),
        Err(down())
    );
}

#[test]
fn malformed_success_answers_refuse_unknown_contracts() {
    for case in fixture()["malformed"].as_array().unwrap() {
        let kind = serde_json::from_value(case[0].clone()).unwrap();
        let error = parse::response(200, &case[2].to_string(), kind).unwrap_err();
        assert_eq!(
            format!("{error:?}"),
            format!("Contract {{ code: {:?} }}", case[1].as_str().unwrap())
        );
    }
}

#[test]
fn lookup_configuration_is_honest_and_debug_hides_the_key() {
    let blank =
        NtsConfig::from_lookup(|key| (key == "NTS_BUSINESSMAN_API_KEY").then(|| "  ".into()));
    assert_eq!(
        NtsClient::new(blank).availability().reason,
        Some(UnavailableReason::NotConfigured)
    );
    let configured = NtsConfig::from_lookup(|key| match key {
        "NTS_BUSINESSMAN_API_KEY" => Some(SECRET.into()),
        "NTS_BUSINESSMAN_API_KEY_EXPIRES_ON" => Some("2020-01-01".into()),
        "NTS_TIMEOUT_MS" => Some("123".into()),
        "NTS_RATE_PER_MINUTE" => Some("7".into()),
        "NTS_BASE_URL" => Some("http://127.0.0.1:9876/".into()),
        _ => None,
    });
    assert_eq!(configured.timeout, Duration::from_millis(123));
    assert_eq!(configured.rate_per_minute, 7);
    assert!(!format!("{configured:?}").contains(SECRET));
    let expired = NtsClient::new(configured);
    assert_eq!(
        expired.availability().reason,
        Some(UnavailableReason::KeyExpired)
    );
    assert_eq!(expired.key_notices()[0].state, KeyState::Expired);
    let mut c = config(Url::parse("http://127.0.0.1:9/").unwrap());
    c.expires_on = Some(OffsetDateTime::now_utc().date() + time::Duration::days(14));
    assert_eq!(
        NtsClient::new(c.clone()).key_notices()[0].state,
        KeyState::Expiring
    );
    c.expires_on = c.expires_on.map(|d| d + time::Duration::days(1));
    assert!(NtsClient::new(c).key_notices().is_empty());
    assert!(!format!("{:?}", validation()).contains("홍길동"));
}

#[tokio::test]
async fn explicit_status_and_validation_send_only_the_documented_values() {
    let (url, seen) = serve(None).await;
    let client = NtsClient::new(config(url));
    assert_eq!(client.pack(), "KR");
    assert_eq!(
        client.status(&["0008100009".into()]).await.unwrap()[0]
            .status_code
            .as_deref(),
        Some("01")
    );
    assert_eq!(
        client
            .validate(&validation())
            .await
            .unwrap()
            .valid
            .as_deref(),
        Some("01")
    );
    let requests = seen.lock().unwrap();
    assert!(requests[0].0.starts_with("POST /status?serviceKey="));
    assert!(requests[0].0.contains("returnType=JSON"));
    assert_eq!(requests[0].1, json!({"b_no":["0008100009"]}));
    assert_eq!(
        requests[1].1,
        json!({"businesses":[{"b_no":"0008100009","start_dt":"20200302","p_nm":"홍길동"}]})
    );
}

#[tokio::test]
async fn batches_split_at_the_provider_maximum_and_validate_response_numbers() {
    let (url, seen) = serve(None).await;
    let client = NtsClient::new(config(url));
    let numbers: Vec<_> = (0..101).map(|n| format!("{n:010}")).collect();
    assert_eq!(client.status(&numbers).await.unwrap().len(), 101);
    let lengths: Vec<_> = seen
        .lock()
        .unwrap()
        .iter()
        .map(|(_, b)| b["b_no"].as_array().unwrap().len())
        .collect();
    assert_eq!(lengths, [100, 1]);
    let (url, _) = serve(Some((200, r#"{"status_code":"OK","data":[]}"#))).await;
    let client = NtsClient::new(config(url.clone()));
    assert_eq!(
        client.status(&numbers[..1]).await,
        Err(CheckFailure::Contract {
            code: "response_number_mismatch"
        })
    );
    assert_eq!(
        client.availability().reason,
        Some(UnavailableReason::ProviderDown)
    );
    let client = NtsClient::new(config(url));
    assert_eq!(
        client.validate(&validation()).await,
        Err(CheckFailure::Contract {
            code: "response_number_mismatch"
        })
    );
}

#[tokio::test]
async fn invalid_user_values_and_unconfigured_keys_make_no_network_call() {
    let (url, seen) = serve(None).await;
    let mut c = config(url);
    c.key = None;
    let client = NtsClient::new(c);
    assert_eq!(
        client.status(&["0008100009".into()]).await,
        Err(CheckFailure::Unavailable(UnavailableReason::NotConfigured))
    );
    assert_eq!(
        client.status(&["000-81-00009".into()]).await,
        Err(CheckFailure::Contract {
            code: "invalid_number"
        })
    );
    let mut request = validation();
    request.opened_on = "2020-02-30".into();
    assert_eq!(
        client.validate(&request).await,
        Err(CheckFailure::Contract {
            code: "invalid_validation_fields"
        })
    );
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn retained_swagger_is_the_contract_reference_for_provider_fields() {
    let spec: Value = serde_json::from_str(include_str!("../tests/fixtures/swagger.json")).unwrap();
    assert_eq!(spec["swagger"], "2.0");
    assert!(parse::PROVIDER_VERSION.ends_with(spec["info"]["version"].as_str().unwrap()));
    for (model, fields) in [
        ("BusinessStatus", &["b_no", "b_stt_cd", "end_dt"][..]),
        ("BusinessDescription", &["b_no", "start_dt", "p_nm"][..]),
    ] {
        for field in fields {
            assert!(
                spec["definitions"][model]["properties"]
                    .get(*field)
                    .is_some(),
                "{model}.{field}"
            );
        }
    }
}

#[test]
fn a_malformed_expiry_fails_closed_instead_of_making_a_key_live_forever() {
    let config = NtsConfig::from_lookup(|key| match key {
        "NTS_BUSINESSMAN_API_KEY" => Some("fixture".into()),
        "NTS_BUSINESSMAN_API_KEY_EXPIRES_ON" => Some("not-a-date".into()),
        _ => None,
    });
    assert_eq!(
        NtsClient::new(config).availability().reason,
        Some(UnavailableReason::NotConfigured)
    );
}
