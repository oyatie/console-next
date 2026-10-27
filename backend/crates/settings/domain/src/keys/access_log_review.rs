// SPDX-License-Identifier: LicenseRef-Proprietary
//! 접속기록 점검 policy (internal management plan §8.3–8.6).
macro_rules! access_log_review { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    AccessLogReviewCadenceMonths => "access_log_review.cadence_months" = D::int(Months, Some(1), Some(3), 1, Higher);
    AccessLogReviewDueBusinessDays => "access_log_review.due_business_days" = D::int(BusinessDays, Some(1), Some(10), 1, Higher);
    AccessLogReviewReasonDueBusinessDays => "access_log_review.reason_due_business_days" = D::int(BusinessDays, Some(1), Some(10), 5, Higher);
    AccessLogReviewTimeZone => "access_log_review.time_zone" = D::code(&["Asia/Seoul"], "Asia/Seoul", Neutral);
    AccessLogReviewOffHoursStartHour => "access_log_review.off_hours.start_hour" = D::int(Hours, Some(0), Some(23), 20, Higher);
    AccessLogReviewOffHoursEndHour => "access_log_review.off_hours.end_hour" = D::int(Hours, Some(0), Some(23), 8, Lower);
    AccessLogReviewOffHoursMin => "access_log_review.flag.off_hours_min" = D::int(Count, Some(1), None, 1, Higher);
    // The plan leaves these to the owner: require a declaration until defaults are approved.
    AccessLogReviewBulkSubjectsMin => "access_log_review.flag.bulk_subjects_min" = D { default: None, ..D::int(Count, Some(1), None, 1, Higher) };
    AccessLogReviewDeniedMin => "access_log_review.flag.denied_min" = D { default: None, ..D::int(Count, Some(1), None, 1, Higher) };
    AccessLogReviewDownloadsPerDayMin => "access_log_review.flag.downloads_per_day_min" = D::int(Count, Some(1), None, 3, Higher);
    AccessLogReviewEveryDownload => "access_log_review.flag.every_download" = D::bool(true, Lower);
] $($rest)* } }; }
