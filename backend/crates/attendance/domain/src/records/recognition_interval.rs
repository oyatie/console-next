// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{IntervalCategory as Category, IntervalReason as Reason};
use super::{RECOGNITION_RULE_VERSION, RecognitionInterval};

impl RecognitionInterval {
    #[must_use]
    pub(super) fn new(start: u16, end: u16, category: Category, reason_code: Reason) -> Self {
        Self {
            start,
            end,
            minutes: u32::from(end - start),
            category,
            recognised: !matches!(category, Category::Break | Category::NotWork),
            reason_code,
            rule_version: RECOGNITION_RULE_VERSION,
        }
    }
}
