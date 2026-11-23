// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(dead_code)]
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use aws_lc_rs::digest::{SHA256, digest};
use console_ops_application::vmalert::VmalertSnapshot;
use console_ops_application::{
    Alert, AlertState, AlertStatus, Alertmanager, AlertmanagerSnapshot, AlertmanagerStatus,
    CockpitEvaluator, InstantSample, ScrapeTarget, SourceFuture, SourcePorts, VersionInfo,
    VictoriaMetrics, Vmalert,
};
use console_ops_domain::bundle::{
    AccessSettings, ComponentsMap, OpsSettings, validate_components_json,
    validate_ops_settings_json,
};
use console_ops_rest::access_jwt::AccessJwtVerifier;
use console_ops_rest::operators::OperatorRegistry;
use console_ops_rest::state::OpsRestState;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use p256::pkcs8::{EncodePrivateKey, LineEnding};
use serde::Serialize;
use serde_json::json;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::watch;

pub const ORIGIN: &str = "https://ops.example.invalid";
pub const ISSUER: &str = "https://example.cloudflareaccess.com";
pub const AUD: &str = "ops-aud-prod";
pub const OTHER_AUD: &str = "preview-aud";
pub const OPERATOR_EMAIL: &str = "operator@example.invalid";
pub const READ_HOME_ONLY_EMAIL: &str = "home-only@example.invalid";
pub const EXPIRED_EMAIL: &str = "expired@example.invalid";
pub const UNKNOWN_EMAIL: &str = "stranger@example.invalid";

pub struct MockSources {
    pub alerts: Mutex<Vec<Alert>>,
}

impl Alertmanager for MockSources {
    fn read(&self) -> SourceFuture<'_, AlertmanagerSnapshot> {
        let alerts = self
            .alerts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|a| Alert {
                fingerprint: a.fingerprint.clone(),
                labels: a.labels.clone(),
                annotations: a.annotations.clone(),
                starts_at: a.starts_at,
                ends_at: a.ends_at,
                status: AlertStatus {
                    state: AlertState::Active,
                    silenced_by: a.status.silenced_by.clone(),
                    inhibited_by: a.status.inhibited_by.clone(),
                },
            })
            .collect();
        Box::pin(async move {
            Ok(AlertmanagerSnapshot {
                alerts,
                silences: Vec::new(),
                status: AlertmanagerStatus {
                    version_info: VersionInfo {
                        version: "0.27".into(),
                    },
                    uptime: OffsetDateTime::now_utc(),
                },
            })
        })
    }
}

impl Vmalert for MockSources {
    fn read(&self) -> SourceFuture<'_, VmalertSnapshot> {
        Box::pin(async move {
            Ok(VmalertSnapshot {
                groups: Vec::new(),
                alerts: Vec::new(),
            })
        })
    }
}

impl VictoriaMetrics for MockSources {
    fn query_instant(&self, _query: &str) -> SourceFuture<'_, Vec<InstantSample>> {
        Box::pin(async move { Ok(Vec::new()) })
    }
    fn targets(&self) -> SourceFuture<'_, Vec<ScrapeTarget>> {
        Box::pin(async move { Ok(Vec::new()) })
    }
}

pub struct JwtSigner {
    enc: EncodingKey,
    pub jwks_json: String,
}

impl JwtSigner {
    pub fn generate() -> Result<Self, Box<dyn std::error::Error>> {
        let key = SigningKey::generate();
        let pem = key.to_pkcs8_pem(LineEnding::LF)?;
        let enc = EncodingKey::from_ec_pem(pem.as_bytes())?;
        let mut jwk = jsonwebtoken::jwk::Jwk::from_encoding_key(&enc, Algorithm::ES256)?;
        jwk.common.key_id = Some("kid-1".to_owned());
        let jwks_json = json!({ "keys": [jwk] }).to_string();
        Ok(Self { enc, jwks_json })
    }

    pub fn sign(
        &self,
        email: &str,
        aud: &str,
        iss: &str,
        exp_offset_s: i64,
        nbf_offset_s: Option<i64>,
    ) -> Result<String, Box<dyn std::error::Error>> {
        #[derive(Serialize)]
        struct Claims<'a> {
            email: &'a str,
            aud: &'a str,
            iss: &'a str,
            exp: i64,
            #[serde(skip_serializing_if = "Option::is_none")]
            nbf: Option<i64>,
        }
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let header = Header {
            alg: Algorithm::ES256,
            kid: Some("kid-1".to_owned()),
            ..Default::default()
        };
        Ok(encode(
            &header,
            &Claims {
                email,
                aud,
                iss,
                exp: now + exp_offset_s,
                nbf: nbf_offset_s.map(|o| now + o),
            },
            &self.enc,
        )?)
    }
}

pub fn test_bundle() -> Result<(ComponentsMap, OpsSettings, String), Box<dyn std::error::Error>> {
    let comp = validate_components_json(
        &json!({
            "api": {
                "group": "app", "host": "onprem-1", "owner": "platform",
                "dashboard": "/running", "runbook": "https://example.invalid/runbook",
                "source": "victoriametrics", "interval_s": 60
            }
        })
        .to_string(),
    )?;
    let src = json!({
        "url": "http://example.invalid", "producer": "fixture", "interval_s": 60,
        "read_limits": {"request_timeout_ms": 500, "max_response_bytes": 4096}
    });
    let settings = validate_ops_settings_json(&json!({
        "sources": {"alertmanager": src, "vmalert": src, "victoriametrics": src},
        "access": {"team": "cosskorea", "aud": AUD, "issuer": ISSUER, "jwks": "/tmp/j.json", "interval_s": 60},
        "origin": ORIGIN,
        "thresholds": {},
        "budgets": {"evaluate_interval_s": 15}
    }).to_string())?;
    let now = OffsetDateTime::now_utc();
    let from = (now - Duration::hours(1)).format(&Rfc3339)?;
    let until = (now + Duration::hours(1)).format(&Rfc3339)?;
    let past_from = (now - Duration::hours(4)).format(&Rfc3339)?;
    let past_until = (now - Duration::hours(2)).format(&Rfc3339)?;
    let operators_json = json!([
        {
            "person": "00000000-0000-4000-8000-000000000001",
            "email_sha256": hex::encode(digest(&SHA256, OPERATOR_EMAIL.as_bytes())),
            "grants": [
                {"action": "read.me", "from": from, "until": until},
                {"action": "read.home", "from": from, "until": until},
                {"action": "read.alerts", "from": from, "until": until},
                {"action": "read.running", "from": from, "until": until},
                {"action": "read.sources", "from": from, "until": until}
            ]
        },
        {
            "person": "00000000-0000-4000-8000-000000000002",
            "email_sha256": hex::encode(digest(&SHA256, READ_HOME_ONLY_EMAIL.as_bytes())),
            "grants": [
                {"action": "read.me", "from": from, "until": until},
                {"action": "read.home", "from": from, "until": until}
            ]
        },
        {
            "person": "00000000-0000-4000-8000-000000000003",
            "email_sha256": hex::encode(digest(&SHA256, EXPIRED_EMAIL.as_bytes())),
            "grants": [
                {"action": "read.home", "from": past_from, "until": past_until}
            ]
        }
    ])
    .to_string();
    Ok((comp, settings, operators_json))
}

pub async fn make_state(
    signer: &JwtSigner,
) -> Result<
    (
        OpsRestState,
        Arc<tokio::sync::Mutex<CockpitEvaluator>>,
        Arc<MockSources>,
        watch::Sender<bool>,
    ),
    Box<dyn std::error::Error>,
> {
    let (comp, settings, operators_json) = test_bundle()?;
    let now = OffsetDateTime::now_utc();
    let sources = Arc::new(MockSources {
        alerts: Mutex::new(vec![Alert {
            fingerprint: "fp1".into(),
            labels: [
                ("alertname".into(), "HighLatency".into()),
                ("severity".into(), "page".into()),
            ]
            .into(),
            annotations: [("summary".into(), "Latency high".into())].into(),
            starts_at: now,
            ends_at: now + Duration::hours(1),
            status: AlertStatus {
                state: AlertState::Active,
                silenced_by: vec![],
                inhibited_by: vec![],
            },
        }]),
    });
    let boot = now - Duration::seconds(61);
    let mut eval = CockpitEvaluator::new(
        SourcePorts {
            alertmanager: sources.clone(),
            vmalert: sources.clone(),
            victoriametrics: sources.clone(),
        },
        comp,
        settings.clone(),
        boot,
    );
    eval.set_access_jwks_status(Some(boot), None);
    eval.tick(boot).await;
    let initial = eval.evaluate(boot);
    let registry = Arc::new(OperatorRegistry::from_json(&operators_json)?);
    let access: AccessSettings = settings.access;
    let jwt = Arc::new(AccessJwtVerifier::from_jwks_json(
        &access,
        &signer.jwks_json,
        now,
    )?);
    let (tx, rx) = watch::channel(false);
    let state = OpsRestState::new(registry, jwt, initial, ORIGIN, rx);
    let eval = Arc::new(tokio::sync::Mutex::new(eval));
    Ok((state, eval, sources, tx))
}

pub fn b64url(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(T[((n >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(T[(n & 63) as usize] as char);
        }
    }
    out
}

pub fn _keep_btree(_: BTreeMap<String, String>) {}
