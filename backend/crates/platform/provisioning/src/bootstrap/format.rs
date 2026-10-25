// SPDX-License-Identifier: LicenseRef-Proprietary

/// Admin-issued OTP length and alphabet.
///
/// Ten Crockford base32 symbols provide 32^10 = 2^50 possibilities (50 bits).
/// First-sign-in codes remain usable until passkey registration or expiry;
/// recovery codes are single-use. Rate limits and the configured TTL also apply.
pub const OTP_LEN: usize = 10;
pub const OTP_GROUP_LEN: usize = OTP_LEN / 2;
pub const OTP_ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Canonical issuance format for OpenAPI and generated clients, not a redeem
/// validator: existing credentials retain their original hash and format.
#[must_use]
pub fn bootstrap_otp_pattern() -> String {
    let alphabet = String::from_utf8_lossy(OTP_ALPHABET);
    format!("^[{alphabet}]{{{OTP_GROUP_LEN}}}-[{alphabet}]{{{OTP_GROUP_LEN}}}$")
}
