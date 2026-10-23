// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) struct Keys {
    pub(super) private_pem: String,
    pub(super) public_pem: String,
}

pub(super) fn gen_keys() -> Keys {
    let signing_key = SigningKey::random(&mut OsRng);
    Keys {
        private_pem: signing_key
            .to_pkcs8_pem(LineEnding::LF)
            .unwrap()
            .to_string(),
        public_pem: signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap(),
    }
}
