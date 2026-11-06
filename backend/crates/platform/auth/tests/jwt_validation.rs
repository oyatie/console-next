// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use console_kernel_core::OrgId;
use console_platform_auth::{JwtIssuer, JwtSettings, JwtVerifier};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::{Duration, OffsetDateTime};

#[derive(Serialize, Deserialize)]
struct Case {
    name: String,
    token: String,
    accepted: bool,
}

#[derive(Serialize, Deserialize)]
struct Corpus {
    public_pem: String,
    cases: Vec<Case>,
}

fn corpus(settings: &JwtSettings) -> Corpus {
    let signing = SigningKey::generate();
    let private_pem = signing.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_pem = signing
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let key = EncodingKey::from_ec_pem(private_pem.as_bytes()).unwrap();
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let claims = json!({
        "iss": settings.issuer,
        "aud": settings.audience,
        "sub": uuid::Uuid::nil().to_string(),
        "org": OrgId::one().to_string(),
        "iat": now - 3600,
        "nbf": now - 3600,
        "exp": now + 3600,
        "jti": uuid::Uuid::nil().to_string(),
        "roles": [],
        "branches": [],
        "alg": "ES256",
    });
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(
        JwtIssuer::from_es256_pem(
            settings.clone(),
            private_pem.as_bytes(),
            public_pem.as_bytes(),
        )
        .unwrap()
        .kid()
        .to_owned(),
    );
    let mut cases = Vec::new();
    for (name, field, value, accepted) in [
        ("valid", "exp", json!(now + 3600), true),
        ("expired", "exp", json!(now - 3600), false),
        ("not yet valid", "nbf", json!(now + 3600), false),
        ("wrong audience", "aud", json!("other-api"), false),
        ("wrong issuer", "iss", json!("other-issuer"), false),
        ("expiry at zero leeway boundary", "exp", json!(now), false),
        ("nbf at zero leeway boundary", "nbf", json!(now), true),
        ("expiry within default leeway", "exp", json!(now - 1), false),
        ("nbf within default leeway", "nbf", json!(now + 59), false),
    ] {
        let mut claims = claims.clone();
        claims[field] = value;
        cases.push(Case {
            name: name.into(),
            token: encode(&header, &claims, &key).unwrap(),
            accepted,
        });
    }
    cases.push(Case {
        name: "wrong algorithm".into(),
        token: encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(b"test-only-hmac-secret"),
        )
        .unwrap(),
        accepted: false,
    });
    cases.push(Case {
        name: "none algorithm".into(),
        token: format!(
            "{}.{}.",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap()),
        ),
        accepted: false,
    });
    let genuine = encode(&header, &claims, &key).unwrap();
    let (signed, signature) = genuine.rsplit_once('.').unwrap();
    let mut signature = URL_SAFE_NO_PAD.decode(signature).unwrap();
    signature[0] ^= 1;
    cases.push(Case {
        name: "tampered signature".into(),
        token: format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature)),
        accepted: false,
    });
    Corpus { public_pem, cases }
}

#[test]
fn access_token_validation_verdicts() {
    let settings = JwtSettings {
        issuer: "console-platform-auth".into(),
        audience: "console-api".into(),
        access_token_ttl: Duration::minutes(15),
    };
    // Reuse the exact signed tokens when comparing dependency versions; no private key is persisted.
    let fixture = std::env::var_os("JWT_VALIDATION_CORPUS").map(std::path::PathBuf::from);
    let corpus = if let Some(path) = fixture.as_ref().filter(|path| path.exists()) {
        serde_json::from_slice::<Corpus>(&std::fs::read(path).unwrap()).unwrap()
    } else {
        let corpus = corpus(&settings);
        if let Some(path) = fixture {
            std::fs::write(path, serde_json::to_vec(&corpus).unwrap()).unwrap();
        }
        corpus
    };
    let verifier =
        JwtVerifier::from_es256_public_pem(settings, corpus.public_pem.as_bytes()).unwrap();
    for case in corpus.cases {
        let result = verifier.verify_access_token(&case.token);
        assert_eq!(result.is_ok(), case.accepted, "{}: {result:?}", case.name);
        println!(
            "{}: {}",
            case.name,
            if result.is_ok() { "accept" } else { "reject" }
        );
    }
}
