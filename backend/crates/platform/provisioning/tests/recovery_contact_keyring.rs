// SPDX-License-Identifier: LicenseRef-Proprietary
use base64::{Engine, engine::general_purpose::STANDARD};
use console_platform_provisioning::ops_self_recovery::RecoveryContactCipher;

#[test]
fn configured_recovery_accepts_independent_keys_and_fails_closed_on_configuration_errors() {
    let material = STANDARD.encode([0x37_u8; 32]);
    let ring = serde_json::json!({"active":"recovery-test", "keys":{"recovery-test": material}});
    assert!(RecoveryContactCipher::from_env_values(Some(ring.to_string()), None).is_ok());
    assert!(RecoveryContactCipher::from_env_values(None, Some(material)).is_ok());
    assert!(RecoveryContactCipher::from_env_values(Some("invalid".to_owned()), None).is_err());
    assert_eq!(
        RecoveryContactCipher::from_env_values(None, None).is_ok(),
        cfg!(debug_assertions)
    );
}
