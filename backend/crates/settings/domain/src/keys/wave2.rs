// SPDX-License-Identifier: LicenseRef-Proprietary
//! Wave 2 policy keys: overtime recognition basis, console clock-out, and fixed-term limit.
macro_rules! wave2 { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    AttendanceOvertimeRecognition => "attendance.overtime_recognition" = D::code(OVERTIME_RECOGNITION_MODES, "approval", Higher).cited(crate::citations::LABOR_STANDARDS_ACT_50_53).scope_ceiling(crate::definition::ScopeCeiling::Person).worker_favorable(crate::definition::WorkerFavorable::Higher);
    AttendanceConsoleClockOut => "attendance.console_clock_out" = D::bool(false, Higher).scope_ceiling(crate::definition::ScopeCeiling::Person);
    HrFixedTermLimitMonths => "hr.fixed_term_limit_months" = D::int(Months, Some(1), Some(24), 24, Higher).cited(crate::citations::FIXED_TERM_ACT_4).scope_ceiling(crate::definition::ScopeCeiling::Person).worker_favorable(crate::definition::WorkerFavorable::Lower);
] $($rest)* } }; }
