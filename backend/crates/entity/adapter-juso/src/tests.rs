//! The client against a local server replaying recorded juso responses (the
//! real service is never called from tests).

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use time::macros::date;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;
use uuid::Uuid;

use super::*;

const ROAD_OK: &str = include_str!("../tests/fixtures/road_ok.json");
const ROAD_E0001: &str = include_str!("../tests/fixtures/road_e0001.json");
const ROAD_E0008: &str = include_str!("../tests/fixtures/road_e0008.json");
const FLOORHO: &str = include_str!("../tests/fixtures/detail_floorho.json");

/// Serves `body` to every request (or never answers when `None`); counts
/// requests and records the last request line.
async fn serve(
    body: Option<&'static str>,
) -> (Url, Arc<AtomicUsize>, Arc<std::sync::Mutex<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let last = Arc::new(std::sync::Mutex::new(String::new()));
    let (h, l) = (hits.clone(), last.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            h.fetch_add(1, Ordering::SeqCst);
            let mut buf = vec![0_u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            *l.lock().unwrap() = String::from_utf8_lossy(&buf[..n])
                .lines()
                .next()
                .unwrap_or("")
                .to_owned();
            match body {
                Some(b) => {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json;charset=UTF-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{b}",
                        b.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                }
                None => tokio::time::sleep(Duration::from_secs(30)).await,
            }
        }
    });
    (url, hits, last)
}

fn config(base_url: Url, key: Option<&str>, expires_on: Option<time::Date>) -> JusoConfig {
    JusoConfig {
        street: KeyConfig::new(key.map(str::to_owned), expires_on),
        detail: KeyConfig::new(key.map(str::to_owned), expires_on),
        base_url,
        timeout: Duration::from_millis(300),
        per_user_per_minute: 3,
    }
}

const BUILDING: fn() -> Building = || Building {
    adm_cd: "1171010700".into(),
    rn_mgt_sn: "117102005011".into(),
    udrt_yn: false,
    buld_mnnm: 345,
    buld_slno: 0,
};

#[tokio::test]
async fn search_maps_a_recorded_hit_and_sends_the_documented_parameters() {
    let (url, _, last) = serve(Some(ROAD_OK)).await;
    let client = JusoClient::new(config(url, Some("test-key"), None));
    let out = client
        .search(Uuid::new_v4(), " 판교역로 166 ", 2)
        .await
        .unwrap();
    assert_eq!(out.status, SearchStatus::Ok);
    assert_eq!(out.items[0].zip_no.as_deref(), Some("13529"));
    let line = last.lock().unwrap().clone();
    assert!(
        line.starts_with("GET /addrlink/addrLinkApi.do?confmKey=test-key&resultType=json&keyword="),
        "{line}"
    );
    assert!(line.contains("currentPage=2&countPerPage=20"), "{line}");
}

#[tokio::test]
async fn no_key_or_an_expired_key_is_unavailable_without_a_call() {
    let (url, hits, _) = serve(Some(ROAD_OK)).await;
    let none = JusoClient::new(config(url.clone(), None, None));
    assert_eq!(
        none.search(Uuid::new_v4(), "판교역로", 1)
            .await
            .unwrap()
            .status,
        SearchStatus::Unavailable
    );
    let expired = JusoClient::new(config(url, Some("k"), Some(date!(2020 - 01 - 01))));
    assert_eq!(
        expired
            .search(Uuid::new_v4(), "판교역로", 1)
            .await
            .unwrap()
            .status,
        SearchStatus::Unavailable
    );
    assert_eq!(
        expired
            .detail(Uuid::new_v4(), &BUILDING(), None)
            .await
            .unwrap()
            .status,
        SearchStatus::Unavailable
    );
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    assert_eq!(expired.key_notices()[0].state, KeyState::Expired);
}

#[tokio::test]
async fn a_rejected_key_turns_unavailable_once_and_stops_calling() {
    let (url, hits, _) = serve(Some(ROAD_E0001)).await;
    let client = JusoClient::new(config(url, Some("k"), None));
    let user = Uuid::new_v4();
    assert_eq!(
        client.search(user, "판교역로", 1).await.unwrap().status,
        SearchStatus::Unavailable
    );
    assert_eq!(
        client.search(user, "판교역로", 1).await.unwrap().status,
        SearchStatus::Unavailable
    );
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert_eq!(client.key_notices()[0].state, KeyState::Rejected);
}

#[tokio::test]
async fn a_timeout_is_unavailable() {
    let (url, _, _) = serve(None).await;
    let client = JusoClient::new(config(url, Some("k"), None));
    let started = std::time::Instant::now();
    assert_eq!(
        client
            .search(Uuid::new_v4(), "판교역로", 1)
            .await
            .unwrap()
            .status,
        SearchStatus::Unavailable
    );
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn a_refused_keyword_and_the_budget_are_refusals() {
    let (url, _, _) = serve(Some(ROAD_E0008)).await;
    let client = JusoClient::new(config(url, Some("k"), None));
    let user = Uuid::new_v4();
    for _ in 0..3 {
        assert_eq!(
            client.search(user, "길", 1).await,
            Err(JusoRefusal::InvalidQuery("too_short"))
        );
    }
    assert_eq!(
        client.search(user, "길", 1).await,
        Err(JusoRefusal::RateLimited)
    );
}

#[tokio::test]
async fn detail_asks_floor_and_ho_of_one_dong() {
    let (url, _, last) = serve(Some(FLOORHO)).await;
    let client = JusoClient::new(config(url, Some("k"), None));
    let out = client
        .detail(Uuid::new_v4(), &BUILDING(), Some("101동"))
        .await
        .unwrap();
    assert_eq!(out.status, SearchStatus::Ok);
    assert_eq!(out.items[0].ho.as_deref(), Some("101호"));
    let line = last.lock().unwrap().clone();
    assert!(line.contains("admCd=1171010700&rnMgtSn=117102005011&udrtYn=0&buldMnnm=345&buldSlno=0&searchType=floorho&dongNm="), "{line}");
}

#[test]
fn config_reads_the_environment_names() {
    let env = |name: &str| match name {
        "STREET_JUSO_API_KEY" => Some("s".to_owned()),
        "DETAILED_JUSO_API_KEY" => Some("  ".to_owned()),
        "STREET_JUSO_API_KEY_EXPIRES_ON" => Some("2026-12-31".to_owned()),
        "JUSO_TIMEOUT_MS" => Some("1500".to_owned()),
        _ => None,
    };
    let cfg = JusoConfig::from_lookup(env);
    assert_eq!(cfg.street.key.as_deref(), Some("s"));
    assert_eq!(cfg.street.expires_on, Some(date!(2026 - 12 - 31)));
    assert_eq!(cfg.detail.key, None, "a blank key is no key");
    assert_eq!(cfg.timeout, Duration::from_millis(1500));
    assert_eq!(cfg.per_user_per_minute, 30);
    assert_eq!(cfg.base_url.as_str(), "https://business.juso.go.kr/");
    let printed = format!("{cfg:?} {:?}", JusoClient::new(cfg.clone()));
    assert!(
        !printed.contains("\"s\"") && printed.contains("configured: true"),
        "{printed}"
    );
}
