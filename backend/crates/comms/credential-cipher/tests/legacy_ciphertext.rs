#![allow(clippy::unwrap_used)]

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use console_comms_credential_cipher::{
    Aad, CipherError, CredentialCipher, EnvelopeCredentialCipher, SealedCredential,
};
use secrecy::ExposeSecret;

fn aad() -> Aad<'static> {
    Aad {
        org_id: "11111111-1111-1111-1111-111111111111",
        account_id: "22222222-2222-2222-2222-222222222222",
        field: "smtp_password",
    }
}

// Captured with the old, unedited encrypt implementation and test KEK [7; 32].
fn legacy_ciphertext() -> SealedCredential {
    SealedCredential {
        ciphertext: vec![
            67, 172, 9, 221, 188, 71, 62, 93, 101, 248, 51, 26, 105, 169, 157, 108, 213, 116, 94,
            67, 174, 105, 96, 9, 20, 249, 58, 103, 139, 24, 249, 185, 89, 227, 10, 61,
        ],
        nonce: vec![
            133, 109, 105, 6, 236, 176, 54, 81, 187, 11, 188, 192, 86, 180, 138, 6, 64, 9, 96, 107,
            45, 91, 189, 116,
        ],
        dek_wrapped: vec![
            197, 84, 109, 250, 154, 48, 102, 145, 6, 112, 219, 208, 100, 155, 41, 167, 26, 19, 35,
            84, 104, 2, 73, 133, 57, 182, 104, 48, 251, 67, 114, 121, 7, 176, 16, 72, 227, 148, 36,
            113, 141, 200, 122, 204, 62, 159, 162, 89,
        ],
        dek_nonce: vec![
            18, 30, 45, 166, 198, 125, 53, 153, 43, 185, 216, 151, 121, 5, 85, 152, 137, 187, 105,
            15, 108, 238, 89, 10,
        ],
        key_version: 1,
    }
}

#[test]
fn ciphertext_written_by_the_old_cipher_still_decrypts() {
    let cipher = EnvelopeCredentialCipher::from_base64_key(&BASE64.encode([7; 32])).unwrap();
    let plaintext = cipher.decrypt(&legacy_ciphertext(), aad()).unwrap();
    assert_eq!(
        plaintext.expose_secret().as_slice(),
        b"legacy-smtp-password"
    );
}

#[test]
fn legacy_ciphertext_rejects_the_wrong_aad() {
    let cipher = EnvelopeCredentialCipher::from_base64_key(&BASE64.encode([7; 32])).unwrap();
    let mut wrong = aad();
    wrong.field = "imap_password";
    assert!(matches!(
        cipher.decrypt(&legacy_ciphertext(), wrong),
        Err(CipherError::Decrypt)
    ));
}
