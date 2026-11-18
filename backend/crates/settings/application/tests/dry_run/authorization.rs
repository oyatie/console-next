// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[tokio::test]
async fn ungranted_preview_refuses_before_value_and_version_conflicts() {
    for value in [20, 30, 40] {
        for version in [
            None,
            Some(console_kernel_core::SettingVersionId::Override(
                Uuid::new_v4(),
            )),
        ] {
            let mut change = cmd(json!(value));
            change.expected_version = version;
            let error = plan_setting(
                &mut Fake::default(),
                |_| Err(KernelError::forbidden("denied")),
                actor(),
                change,
                true,
            )
            .await
            .unwrap_err();
            assert_eq!(
                refused(error).kind,
                console_kernel_core::ErrorKind::Forbidden
            );
        }
    }
}
