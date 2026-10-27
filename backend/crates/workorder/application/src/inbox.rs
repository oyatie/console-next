// SPDX-License-Identifier: LicenseRef-Proprietary
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionInboxPosition {
    pub created_at: time::OffsetDateTime,
    pub due: Option<console_kernel_core::Timestamp>,
    pub id: String,
}
