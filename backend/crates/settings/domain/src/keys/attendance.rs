//! Attendance §6 bounds; MAIN03:55 preserves S2's zero defaults.
macro_rules! attendance { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    AttendanceExcessNoticeMinutes => "attendance.excess.notice_minutes" = D::int(Minutes, Some(0), Some(30), 0, Higher);
    AttendanceLongSpanConfirmMinutes => "attendance.entry.long_span_confirm_minutes" = D::int(Minutes, Some(1), Some(1440), 16 * 60, Higher).cited(crate::citations::LABOR_STANDARDS_ACT_50_53);
    AttendanceLateGraceMinutes => "attendance.late.grace_minutes" = D::int(Minutes, Some(0), Some(60), 0, Higher);
] $($rest)* } }; }
