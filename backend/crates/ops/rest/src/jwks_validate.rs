// SPDX-License-Identifier: LicenseRef-Proprietary
use jsonwebtoken::Algorithm;
use jsonwebtoken::jwk::{AlgorithmParameters, Jwk, KeyAlgorithm};
use serde::Deserialize;

#[derive(Deserialize)]
struct RawJwks {
    keys: Vec<Jwk>,
}

pub fn parse_jwks(raw: &str) -> Result<Vec<Jwk>, String> {
    let parsed: RawJwks =
        serde_json::from_str(raw).map_err(|e| format!("invalid JWKS JSON: {e}"))?;
    if parsed.keys.is_empty() {
        return Err("JWKS keys array must not be empty".to_owned());
    }
    for (idx, jwk) in parsed.keys.iter().enumerate() {
        if jwk.common.key_id.as_deref().is_none_or(str::is_empty) {
            return Err(format!("/keys/{idx}/kid: missing key id"));
        }
        match &jwk.algorithm {
            AlgorithmParameters::RSA(_)
            | AlgorithmParameters::EllipticCurve(_)
            | AlgorithmParameters::OctetKeyPair(_) => {}
            AlgorithmParameters::OctetKey(_) => {
                return Err(format!("/keys/{idx}/kty: symmetric JWK forbidden"));
            }
            _ => {
                return Err(format!("/keys/{idx}/kty: unsupported JWK key type"));
            }
        }
    }
    Ok(parsed.keys)
}

pub(crate) fn is_pinned_asymmetric(alg: Algorithm) -> bool {
    matches!(
        alg,
        Algorithm::RS256
            | Algorithm::RS384
            | Algorithm::RS512
            | Algorithm::ES256
            | Algorithm::ES384
            | Algorithm::EdDSA
    )
}

pub(crate) fn jwk_allows_alg(jwk: &Jwk, alg: Algorithm) -> bool {
    let family_ok = matches!(
        (&jwk.algorithm, alg),
        (
            AlgorithmParameters::RSA(_),
            Algorithm::RS256 | Algorithm::RS384 | Algorithm::RS512
        ) | (
            AlgorithmParameters::EllipticCurve(_),
            Algorithm::ES256 | Algorithm::ES384
        ) | (AlgorithmParameters::OctetKeyPair(_), Algorithm::EdDSA)
    );
    if !family_ok {
        return false;
    }
    match jwk.common.key_algorithm {
        Some(kalg) => key_alg_matches(kalg, alg),
        None => true,
    }
}

fn key_alg_matches(kalg: KeyAlgorithm, alg: Algorithm) -> bool {
    matches!(
        (kalg, alg),
        (KeyAlgorithm::RS256, Algorithm::RS256)
            | (KeyAlgorithm::RS384, Algorithm::RS384)
            | (KeyAlgorithm::RS512, Algorithm::RS512)
            | (KeyAlgorithm::ES256, Algorithm::ES256)
            | (KeyAlgorithm::ES384, Algorithm::ES384)
            | (KeyAlgorithm::EdDSA, Algorithm::EdDSA)
    )
}
