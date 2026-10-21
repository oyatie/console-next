#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! SEC-02: tokens carry `kid` = RFC 7638 thumbprint; verifiers pick the key by
//! `kid` from a set, so a signing-key rotation never cuts live sessions.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, AuthError, JwtIssuer, JwtSettings, JwtVerifier};
use jsonwebtoken::{Algorithm, EncodingKey, Header, decode_header, encode};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};

struct Key {
    signing: SigningKey,
    private_pem: String,
    public_pem: String,
}

fn key() -> Key {
    let signing = SigningKey::random(&mut OsRng);
    Key {
        private_pem: signing.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
        public_pem: signing
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap(),
        signing,
    }
}

fn settings() -> JwtSettings {
    JwtSettings {
        issuer: "console-platform-auth".to_owned(),
        audience: "console-api".to_owned(),
        access_token_ttl: Duration::minutes(15),
    }
}

/// `keys` is the verification set, current first (what the app config builds).
fn bundle(keys: &[&Key]) -> String {
    keys.iter().map(|k| k.public_pem.as_str()).collect()
}

fn issuer(signing: &Key, keys: &[&Key]) -> JwtIssuer {
    JwtIssuer::from_es256_pem(
        settings(),
        signing.private_pem.as_bytes(),
        bundle(keys).as_bytes(),
    )
    .unwrap()
}

fn verifier(keys: &[&Key]) -> JwtVerifier {
    JwtVerifier::from_es256_public_pem(settings(), bundle(keys).as_bytes()).unwrap()
}

fn token(issuer: &JwtIssuer) -> String {
    issuer
        .issue_access_token(AccessTokenInput {
            subject: UserId::new(),
            org_id: OrgId::one(),
            roles: vec!["ADMIN".to_owned()],
            branches: Vec::new(),
            platform: false,
            view_as: false,
            read_only: false,
            display_name: None,
            feature_grants: Vec::new(),
            authz_subject_version: 0,
            authz_policy_version: 0,
            session_generation: 0,
            issued_at: OffsetDateTime::now_utc(),
        })
        .unwrap()
}

/// RFC 7638 §3 for an EC key, written out by hand: a second implementation.
fn rfc7638(key: &Key) -> String {
    let point = key.signing.verifying_key().to_encoded_point(false);
    let json = format!(
        r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#,
        URL_SAFE_NO_PAD.encode(point.x().unwrap()),
        URL_SAFE_NO_PAD.encode(point.y().unwrap()),
    );
    URL_SAFE_NO_PAD.encode(Sha256::digest(json.as_bytes()))
}

/// Re-sign `token`'s claims under `header` with `signer` (a forged or legacy token).
fn resign(token: &str, verifier: &JwtVerifier, header: &Header, signer: &Key) -> String {
    let claims = verifier.verify_access_token(token).unwrap();
    encode(
        header,
        &claims,
        &EncodingKey::from_ec_pem(signer.private_pem.as_bytes()).unwrap(),
    )
    .unwrap()
}

#[test]
fn kid_is_the_rfc7638_thumbprint_of_the_signing_key() {
    let k1 = key();
    let issuer = issuer(&k1, &[&k1]);
    let header = decode_header(token(&issuer)).unwrap();
    assert_eq!(header.kid.as_deref(), Some(rfc7638(&k1).as_str()));
    assert_eq!(issuer.kid(), rfc7638(&k1));
    assert_eq!(header.alg, Algorithm::ES256);
}

#[test]
fn verifier_selects_the_key_named_by_kid() {
    let (k1, k2) = (key(), key());
    let both = verifier(&[&k1, &k2]);
    for signer in [&k1, &k2] {
        let t = token(&issuer(signer, &[signer]));
        assert!(both.verify_access_token(&t).is_ok());
    }
}

#[test]
fn unknown_kid_is_refused_with_its_own_error() {
    let (k1, k2) = (key(), key());
    let t = token(&issuer(&k2, &[&k2]));
    let err = verifier(&[&k1]).verify_access_token(&t).unwrap_err();
    assert!(matches!(err, AuthError::UnknownSigningKey), "{err:?}");
    assert_eq!(err.to_string(), "token signing key is not trusted");
}

#[test]
fn a_kid_naming_a_trusted_key_does_not_rescue_a_foreign_signature() {
    let (k1, k2) = (key(), key());
    let set = verifier(&[&k1]);
    let genuine = token(&issuer(&k1, &[&k1]));
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(rfc7638(&k1));
    let forged = resign(&genuine, &set, &header, &k2);
    let err = set.verify_access_token(&forged).unwrap_err();
    assert!(matches!(err, AuthError::Jwt(_)), "{err:?}");
}

#[test]
fn rotation_window_keeps_old_tokens_until_the_key_is_retired() {
    let (k1, k2) = (key(), key());
    // Before: sign with k1, trust k1.
    let old_token = token(&issuer(&k1, &[&k1]));
    // Stage: k2 published (trusted) while k1 still signs.
    let staged = verifier(&[&k1, &k2]);
    let staged_issuer = issuer(&k1, &[&k1, &k2]);
    assert!(staged.verify_access_token(&old_token).is_ok());
    assert!(staged.verify_access_token(&token(&staged_issuer)).is_ok());
    // Switch: sign with k2; k1 stays trusted for tokens already out.
    let switched = verifier(&[&k2, &k1]);
    let new_token = token(&issuer(&k2, &[&k2, &k1]));
    assert_eq!(decode_header(&new_token).unwrap().kid, Some(rfc7638(&k2)));
    assert!(switched.verify_access_token(&old_token).is_ok());
    assert!(switched.verify_access_token(&new_token).is_ok());
    // A colour still on the staged config accepts the new key's tokens too.
    assert!(staged.verify_access_token(&new_token).is_ok());
    // Retire: k1 is gone; its tokens are refused as an unknown key.
    let retired = verifier(&[&k2]);
    assert!(retired.verify_access_token(&new_token).is_ok());
    let err = retired.verify_access_token(&old_token).unwrap_err();
    assert!(matches!(err, AuthError::UnknownSigningKey), "{err:?}");
}

#[test]
fn a_token_without_kid_verifies_against_the_current_key_only() {
    let (k1, k2) = (key(), key());
    let legacy = Header::new(Algorithm::ES256);
    let set = verifier(&[&k1, &k2]);
    let by_current = resign(&token(&issuer(&k1, &[&k1])), &set, &legacy, &k1);
    assert!(set.verify_access_token(&by_current).is_ok());
    let by_other = resign(&token(&issuer(&k2, &[&k2])), &set, &legacy, &k2);
    let err = set.verify_access_token(&by_other).unwrap_err();
    assert!(matches!(err, AuthError::Jwt(_)), "{err:?}");
}

#[test]
fn issuer_refuses_a_key_set_without_its_own_public_key() {
    let (k1, k2) = (key(), key());
    let err = JwtIssuer::from_es256_pem(
        settings(),
        k1.private_pem.as_bytes(),
        k2.public_pem.as_bytes(),
    )
    .err()
    .unwrap();
    assert!(
        err.to_string().contains("not among the verification keys"),
        "{err}"
    );
}

#[test]
fn key_set_rejects_empty_or_trailing_garbage() {
    let k1 = key();
    for bad in [
        String::new(),
        "  \n".to_owned(),
        format!("{}not a key", k1.public_pem),
        k1.private_pem.clone(),
    ] {
        assert!(
            JwtVerifier::from_es256_public_pem(settings(), bad.as_bytes()).is_err(),
            "accepted {bad:?}"
        );
    }
    let dup = format!("{}{}", k1.public_pem, k1.public_pem);
    assert!(JwtVerifier::from_es256_public_pem(settings(), dup.as_bytes()).is_ok());
}
