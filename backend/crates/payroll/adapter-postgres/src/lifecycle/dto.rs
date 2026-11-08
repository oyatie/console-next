// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::Serialize;
use time::OffsetDateTime;

#[derive(Debug, Clone, Serialize)]
pub struct RunCalcSummary {
    pub version: i32,
    #[serde(with = "console_kernel_core::timestamp")]
    pub calculated_at: OffsetDateTime,
    pub calculated_lines: i64,
    pub blocked_lines: i64,
    /// Always `false` until the 노무사/세무사 release gate flips stored rows.
    pub payable: bool,
    pub kernel_rate_table: String,
    /// `None` unless EVERY line of the run calculated — never a partial sum
    /// presented as a total.
    pub total_net_won: Option<i64>,
}
