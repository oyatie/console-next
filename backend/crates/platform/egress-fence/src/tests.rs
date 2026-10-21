use std::collections::HashMap;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;
use crate::cloudflare::{CloudflareCnameReader, parse_records};

const OURS: &str = "1111-office.cfargotunnel.com";
const MINUTE: Duration = Duration::from_secs(60);

fn err() -> FenceReadError {
    FenceReadError("timeout".to_owned())
}

#[test]
fn pending_fence_is_closed_and_opens_on_a_matching_read() {
    let fence = EgressFence::new(OURS, 5 * MINUTE);
    assert_eq!(fence.state(), FenceState::Pending);
    assert!(!fence.is_open());
    fence.observe(Ok(Some("1111-OFFICE.cfargotunnel.com.")), Instant::now());
    assert!(fence.is_open());
}

#[test]
fn mismatch_trips_and_a_later_match_does_not_clear_it() {
    let fence = EgressFence::new(OURS, 5 * MINUTE);
    let t0 = Instant::now();
    fence.observe(Ok(Some(OURS)), t0);
    fence.observe(Ok(Some("2222-oci.cfargotunnel.com")), t0 + MINUTE);
    assert_eq!(
        fence.state(),
        FenceState::Tripped(TripReason::Mismatch {
            observed: Some("2222-oci.cfargotunnel.com".to_owned())
        })
    );
    fence.observe(Ok(Some(OURS)), t0 + 2 * MINUTE);
    assert!(
        !fence.is_open(),
        "recovery needs the manual clear (a restart)"
    );

    let restarted = EgressFence::new(OURS, 5 * MINUTE);
    restarted.observe(Ok(Some(OURS)), t0 + 3 * MINUTE);
    assert!(restarted.is_open());
}

#[test]
fn a_missing_cname_trips_immediately() {
    let fence = EgressFence::new(OURS, 5 * MINUTE);
    fence.observe(Ok(None), Instant::now());
    assert_eq!(
        fence.state(),
        FenceState::Tripped(TripReason::Mismatch { observed: None })
    );
}

#[test]
fn read_failures_hold_the_state_until_fail_after_then_trip() {
    let fence = EgressFence::new(OURS, 5 * MINUTE);
    let t0 = Instant::now();
    fence.observe(Ok(Some(OURS)), t0);
    fence.observe(Err(&err()), t0 + MINUTE);
    fence.observe(Err(&err()), t0 + 5 * MINUTE);
    assert!(fence.is_open(), "4 minutes of failures < fail_after");
    fence.observe(Err(&err()), t0 + 6 * MINUTE);
    assert_eq!(fence.state(), FenceState::Tripped(TripReason::Unreachable));
    fence.observe(Ok(Some(OURS)), t0 + 7 * MINUTE);
    assert!(!fence.is_open());
}

#[test]
fn a_good_read_resets_the_failure_window() {
    let fence = EgressFence::new(OURS, 5 * MINUTE);
    let t0 = Instant::now();
    fence.observe(Err(&err()), t0);
    fence.observe(Ok(Some(OURS)), t0 + 4 * MINUTE);
    fence.observe(Err(&err()), t0 + 8 * MINUTE);
    assert!(fence.is_open(), "the window restarted at minute 8");
}

#[test]
fn pending_fence_stays_closed_through_failures_and_trips_after_fail_after() {
    let fence = EgressFence::new(OURS, 5 * MINUTE);
    let t0 = Instant::now();
    fence.observe(Err(&err()), t0);
    assert_eq!(fence.state(), FenceState::Pending);
    fence.observe(Err(&err()), t0 + 5 * MINUTE);
    assert_eq!(fence.state(), FenceState::Tripped(TripReason::Unreachable));
}

#[test]
fn unconfigured_never_opens_and_stub_is_open() {
    let fence = EgressFence::unconfigured();
    fence.observe(Ok(Some(OURS)), Instant::now());
    assert!(!fence.is_open());
    assert!(EgressFence::open_for_stub(FenceStubMode::E2e).is_open());
}

fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| (format!("CONSOLE_EGRESS_FENCE_{k}"), (*v).to_owned()))
        .collect();
    move |key| map.get(key).cloned()
}

const LIVE: &[(&str, &str)] = &[
    ("CF_ZONE_ID", "0123abcdef"),
    ("CF_RECORD", "console.example.com"),
    ("CF_TOKEN", "s3cret-token"),
    ("EXPECTED_CONTENT", OURS),
    ("FAIL_AFTER_SECS", "300"),
];

#[test]
fn settings_resolve_unconfigured_stub_and_live() {
    assert_eq!(read_mode(vars(&[])).unwrap(), FenceMode::Unconfigured);
    assert_eq!(
        read_mode(vars(&[("STUB_MODE", "dev")])).unwrap(),
        FenceMode::Stub(FenceStubMode::Development)
    );
    let FenceMode::Live(config) = read_mode(vars(LIVE)).unwrap() else {
        panic!("live group expected");
    };
    assert_eq!(config.api_base, "https://api.cloudflare.com/client/v4");
    assert_eq!(config.fail_after, Duration::from_secs(300));
    assert!(
        !format!("{config:?}").contains("s3cret"),
        "token is redacted"
    );
}

#[test]
fn settings_refuse_partial_mixed_and_unsafe_values() {
    let partial = read_mode(vars(&LIVE[..4])).unwrap_err();
    assert!(partial.0.contains("CONSOLE_EGRESS_FENCE_FAIL_AFTER_SECS"));
    let mut mixed = LIVE.to_vec();
    mixed.push(("STUB_MODE", "test"));
    assert!(read_mode(vars(&mixed)).is_err());
    assert!(read_mode(vars(&[("STUB_MODE", "production")])).is_err());
    let mut bad = LIVE.to_vec();
    bad[1] = ("CF_RECORD", "console.example.com&name=x");
    assert!(read_mode(vars(&bad)).is_err());
    let mut zero = LIVE.to_vec();
    zero[4] = ("FAIL_AFTER_SECS", "0");
    assert!(read_mode(vars(&zero)).is_err());
}

#[test]
fn parse_records_reads_one_record_none_or_fails() {
    let one = r#"{"success":true,"result":[{"content":"a.cfargotunnel.com"}]}"#;
    assert_eq!(
        parse_records(one).unwrap().as_deref(),
        Some("a.cfargotunnel.com")
    );
    assert_eq!(
        parse_records(r#"{"success":true,"result":[]}"#).unwrap(),
        None
    );
    for bad in [
        r#"{"success":false,"result":[]}"#,
        r#"{"success":true}"#,
        r#"{"success":true,"result":[{"content":"a"},{"content":"b"}]}"#,
        r#"{"success":true,"result":[{}]}"#,
        "not json",
    ] {
        assert!(parse_records(bad).is_err(), "{bad}");
    }
}

#[tokio::test]
async fn reader_sends_the_bearer_token_to_the_dns_records_path() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = vec![0_u8; 4096];
        let n = socket.read(&mut buf).await.unwrap();
        let body = r#"{"success":true,"result":[{"content":"1111-office.cfargotunnel.com"}]}"#;
        let reply = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(reply.as_bytes()).await.unwrap();
        String::from_utf8_lossy(&buf[..n]).to_string()
    });
    let FenceMode::Live(mut config) = read_mode(vars(LIVE)).unwrap() else {
        panic!("live group expected");
    };
    config.api_base = format!("http://{addr}");
    let content = CloudflareCnameReader::new(&config)
        .unwrap()
        .read()
        .await
        .unwrap();
    assert_eq!(content.as_deref(), Some(OURS));
    let request = server.await.unwrap().to_ascii_lowercase();
    assert!(request.starts_with(
        "get /zones/0123abcdef/dns_records?type=cname&name=console.example.com http/1.1"
    ));
    assert!(request.contains("authorization: bearer s3cret-token"));
}
