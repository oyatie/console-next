//! The ES256 access-token verifier: keys selected by the JWS `kid` header
//! (RFC 7515 §4.1.4). A key's id is its RFC 7638 JWK SHA-256 thumbprint, so the
//! id is derived from the key itself and never configured.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::jwk::{
    AlgorithmParameters, CommonParameters, EllipticCurve, EllipticCurveKeyParameters,
    EllipticCurveKeyType, Jwk, ThumbprintHash,
};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, decode_header};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::DecodePublicKey;

use crate::AuthError;
use crate::jwt::{AccessClaims, JwtSettings, verify_access_token};

const PEM_END: &str = "-----END PUBLIC KEY-----";
/// A thumbprint is 43 base64url characters; anything longer is not one of ours.
const MAX_LOGGED_KID: usize = 64;

#[derive(Clone, Debug)]
pub struct JwtVerifier {
    settings: JwtSettings,
    keys: KeySet,
}

impl JwtVerifier {
    /// `public_key_pem` holds one or more PEM `PUBLIC KEY` blocks: the current
    /// key first, then any key a rotation still trusts. A token's `kid` picks
    /// its key; a token without one verifies against the current key only.
    pub fn from_es256_public_pem(
        settings: JwtSettings,
        public_key_pem: &[u8],
    ) -> Result<Self, AuthError> {
        Ok(Self {
            settings,
            keys: KeySet::from_pem_bundle(public_key_pem)?,
        })
    }

    pub fn verify_access_token(&self, token: &str) -> Result<AccessClaims, AuthError> {
        let header = decode_header(token)?;
        let key = self.keys.select(header.kid.as_deref())?;
        verify_access_token(token, key, &self.settings)
    }

    pub(crate) fn trusts(&self, kid: &str) -> bool {
        self.keys.contains(kid)
    }
}

/// The trusted public keys. The first is the current one: a token without a
/// `kid` (minted before key ids existed) verifies against it alone.
#[derive(Clone, Debug)]
struct KeySet {
    current: String,
    keys: Vec<(String, DecodingKey)>,
}

impl KeySet {
    /// One or more PEM `PUBLIC KEY` blocks (P-256 SPKI), current key first.
    fn from_pem_bundle(pem: &[u8]) -> Result<Self, AuthError> {
        let text = std::str::from_utf8(pem).map_err(|_| invalid_key("not UTF-8"))?;
        let mut keys: Vec<(String, DecodingKey)> = Vec::new();
        for block in text.split_inclusive(PEM_END).map(str::trim) {
            if block.is_empty() {
                continue;
            }
            let key = p256::PublicKey::from_public_key_pem(block)
                .map_err(|err| invalid_key(&err.to_string()))?;
            let point = key.to_encoded_point(false);
            let (Some(x), Some(y)) = (point.x(), point.y()) else {
                return Err(invalid_key("not an uncompressed point"));
            };
            let (x, y) = (URL_SAFE_NO_PAD.encode(x), URL_SAFE_NO_PAD.encode(y));
            let kid = thumbprint(x.clone(), y.clone());
            if !keys.iter().any(|(known, _)| *known == kid) {
                keys.push((kid, DecodingKey::from_ec_components(&x, &y)?));
            }
        }
        let current = keys
            .first()
            .map(|(kid, _)| kid.clone())
            .ok_or_else(|| invalid_key("no PUBLIC KEY block"))?;
        Ok(Self { current, keys })
    }

    fn contains(&self, kid: &str) -> bool {
        self.keys.iter().any(|(known, _)| known == kid)
    }

    /// The key for a token's `kid`; no `kid` means the current key. An unknown
    /// `kid` (a retired or foreign key) is refused, logged and counted here, so
    /// every verifier caller reports it the same way.
    fn select(&self, kid: Option<&str>) -> Result<&DecodingKey, AuthError> {
        let wanted = kid.unwrap_or(&self.current);
        if let Some((_, key)) = self.keys.iter().find(|(known, _)| known == wanted) {
            return Ok(key);
        }
        // The header is attacker-controlled: log a bounded, charset-checked copy.
        let logged: String = wanted
            .chars()
            .take(MAX_LOGGED_KID)
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
            .collect();
        tracing::warn!(
            security_event = "auth.jwt.unknown_kid",
            kid = %logged,
            "access token refused: signed by a key that is not trusted"
        );
        metrics::counter!("auth_jwt_unknown_kid_total").increment(1);
        Err(AuthError::UnknownSigningKey)
    }
}

/// The `kid` of the key that signs with `private_key`.
pub(crate) fn signing_kid(private_key: &EncodingKey) -> Result<String, AuthError> {
    Ok(Jwk::from_encoding_key(private_key, Algorithm::ES256)?.thumbprint(ThumbprintHash::SHA256))
}

fn thumbprint(x: String, y: String) -> String {
    Jwk {
        common: CommonParameters::default(),
        algorithm: AlgorithmParameters::EllipticCurve(EllipticCurveKeyParameters {
            key_type: EllipticCurveKeyType::EC,
            curve: EllipticCurve::P256,
            x,
            y,
        }),
    }
    .thumbprint(ThumbprintHash::SHA256)
}

fn invalid_key(reason: &str) -> AuthError {
    AuthError::InvalidStoredData(format!("invalid ES256 public key: {reason}"))
}
