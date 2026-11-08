//! Attendance §6 bounds; MAIN03:55 preserves S2's zero defaults.
macro_rules! attendance { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    AttendanceExcessNoticeMinutes => "attendance.excess.notice_minutes" = D::int(Minutes, Some(0), Some(30), 0, Higher);
    AttendanceExcessDispositionDueDays => "attendance.excess.disposition_due_days" = D::int(Days, Some(1), None, 3, Higher);
    AttendanceExcessRepeatWindowDays => "attendance.excess.repeat_window_days" = D::int(Days, Some(1), None, 28, Higher);
    AttendanceExcessRepeatCount => "attendance.excess.repeat_count" = D::int(Count, Some(1), None, 3, Higher);
    AttendanceLongSpanConfirmMinutes => "attendance.entry.long_span_confirm_minutes" = D::int(Minutes, Some(1), Some(1440), 16 * 60, Higher).cited(crate::citations::LABOR_STANDARDS_ACT_50_53);
    AttendanceLateGraceMinutes => "attendance.late.grace_minutes" = D::int(Minutes, Some(0), Some(60), 0, Higher);
    AttendanceWeek52WarnHours => "attendance.week52.warn_hours" = D::int(Hours, Some(40), Some(51), 48, Higher).cited(crate::citations::LABOR_STANDARDS_ACT_50_53);
] $($rest)* } }; }
