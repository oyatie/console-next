// SPDX-License-Identifier: LicenseRef-Proprietary
//! The blank workbooks the reporting exports fill, and their descriptors.
//!
//! Each file is the customer's Excel form with every value cleared except its labels: one sheet, no external
//! links, defined names, drawings, comments or document authors. A template is copied into every export, so
//! anything left in it reaches every tenant; `tests/template_blank.rs` holds them to their labels.

use crate::{DailyStatusSection, SectionDescriptor, TemplateDescriptor};

/// The daily-status (일일업무진행현황) workbook that [`DAILY_STATUS_TEMPLATE`] describes.
pub const DAILY_STATUS_TEMPLATE_XLSX: &[u8] = include_bytes!("../templates/daily-status.xlsx");

/// The work-diary (업무일지) workbook: one sheet the export renames to the diary date and fills.
pub const WORK_DIARY_TEMPLATE_XLSX: &[u8] = include_bytes!("../templates/work-diary.xlsx");

const DAILY_STATUS_SECTIONS: [SectionDescriptor; 4] = [
    SectionDescriptor::new(
        DailyStatusSection::Results.key(),
        "1. 일일 진행업무(실적)",
        2,
        3,
        4,
        22,
        1,
        13,
    ),
    SectionDescriptor::new(
        DailyStatusSection::Plans.key(),
        "2. 일일 진행 업무(계획)",
        24,
        25,
        26,
        42,
        1,
        13,
    ),
    SectionDescriptor::new(
        DailyStatusSection::PendingBacklog.key(),
        "3. 미결 업무 현황(누적)",
        44,
        45,
        46,
        75,
        1,
        14,
    ),
    SectionDescriptor::new(
        DailyStatusSection::PeriodicInspection.key(),
        "4. 정기검사",
        77,
        78,
        79,
        91,
        2,
        12,
    ),
];

/// Descriptor of [`DAILY_STATUS_TEMPLATE_XLSX`], the daily-status workbook the reporting export fills.
pub const DAILY_STATUS_TEMPLATE: TemplateDescriptor =
    TemplateDescriptor::new("6월05일", &DAILY_STATUS_SECTIONS);
