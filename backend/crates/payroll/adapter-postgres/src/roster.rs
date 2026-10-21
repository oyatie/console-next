//! Materialise a payroll run's roster from the governed import ledger.
//!
//! `payroll_draft_lines` had no production writer at all. Its only writer was
//! `scripts/stage_hanu_group_payroll_readiness.sql`, a hand-run operational
//! script, so a payroll run created by production code always had an empty
//! roster — and after the close preflight learned to require `roster_total > 0`,
//! could never close.
//!
//! # This is a PORT, not a new mapping
//!
//! Every column below is derived from that script, which is the existing
//! encoding of how a roster is built. Inventing a second mapping alongside it is
//! how the two drift, and it is the exact failure a previous bead was killed for.
//! Four deliberate differences, each with a reason:
//!
//! 1. SCOPE IS THE DECLARED PAY PERIOD, BY EQUALITY. The script scoped with
//!    `source_filename LIKE '2026/5월/%'` — one operator's folder layout, and the
//!    only thing keeping material from the wrong month out of a roster.
//!    `data_import_runs.pay_period_*` (migration 0224) replaces it. Equality, not
//!    overlap: an import declared for May is material for the May run, not for a
//!    run that happens to straddle May.
//! 2. NO `leave_remaining` ADMISSION DISJUNCT. The script admitted an employee
//!    with `leave_remaining > 0` and no imported rows at all. Such a line carries
//!    no attendance and no payroll evidence, so it exists only to be counted —
//!    and since the close preflight now blocks on lines lacking attendance
//!    material, admitting them turns a real gate into a queue of blockers nobody
//!    can clear.
//! 3. NO RECONCILIATION DELETE. Migration 0222 revoked DELETE on
//!    `payroll_draft_lines` from `console_rt` and asserts the revocation, so a
//!    delete would raise 42501 at PLAN time and kill every `payroll.create_run`,
//!    not just the re-stage. Retraction of a stale line is a separate design.
//! 4. THE EMPLOYEE-DRIVEN GROUPING IS KEPT, deliberately.
//!    `data_import_rows.source_key` is `filename:…|sheet:…|row:…` — per ROW.
//!    Grouping on it would produce one roster line per spreadsheet row rather
//!    than per person. The person key is `canonical_row->>'source_key'`, joined
//!    to `employees.source_key`, which is what makes this a roster of people.

use sqlx::{Postgres, Transaction};
use time::Date;
use uuid::Uuid;

/// One `INSERT … SELECT … ON CONFLICT` — the roster is derived in the database,
/// in the caller's transaction, so a run and its roster are created together or
/// not at all.
const MATERIALISE_ROSTER_SQL: &str = r#"
WITH import_rows AS (
    SELECT
        r.id,
        r.org_id,
        r.source_sheet,
        r.source_row,
        run.source_filename,
        COALESCE(NULLIF(r.canonical_row->>'source_key', ''), NULLIF(r.source_key, '')) AS canonical_source_key,
        r.raw_row,
        present.keys && array['기본시급','통상시급','공제총액','소득세','건강보험','건강/장기요양','고용보험','급여산정일','지급일','연차수당','상여금','은행','계좌','주민번호'] AS is_payroll_source,
        present.keys && array['근무일자','출근','퇴근','근무시간','기본시간','기본근무','연장시간','심야시간','특근시간','특근연장시간','특근연장','근무일명칭','지각,조퇴시간'] AS is_attendance_source,
        present.keys && array['기본급','상여금','월계','합계','총합','연차수당'] AS has_gross_pay_source,
        present.keys && array['차인지급액','실지급액','공제총액','소득세','건강보험','고용보험'] AS has_net_pay_source
    FROM data_import_rows r
    JOIN data_import_runs run
      ON run.id = r.run_id
     AND run.org_id = r.org_id
    -- Headers with a non-empty value: kept cells plus the restricted ones the
    -- importer dropped (only their names are stored, hr.rs persistable_import_row).
    CROSS JOIN LATERAL (
        SELECT ARRAY(
            SELECT kv.key FROM jsonb_each_text(
                CASE WHEN jsonb_typeof(r.raw_row) = 'object' THEN r.raw_row ELSE '{}'::jsonb END
            ) kv
             WHERE btrim(kv.value) <> ''
            UNION ALL
            SELECT dropped FROM jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(r.canonical_row #> '{source_metadata,dropped_restricted_columns}') = 'array'
                     THEN r.canonical_row #> '{source_metadata,dropped_restricted_columns}'
                     ELSE '[]'::jsonb END
            ) dropped
        ) AS keys
    ) present
    WHERE run.org_id = $1
      AND run.entity_type = 'employee_hr'
      -- Provenance: only material an operator actually applied, and never a row
      -- the importer itself rejected.
      AND run.status = 'APPLIED'
      AND r.row_status <> 'ERROR'
      -- Scope: the declared period, by equality.
      AND run.pay_period_start = $3
      AND run.pay_period_end = $4
), row_metrics AS (
    SELECT
        ir.*,
        CASE WHEN btrim(COALESCE(ir.raw_row->>'근무일수', ir.raw_row->>'근무일', '')) ~ '^-?[0-9]+([.]?[0-9]+)?$'
             THEN btrim(COALESCE(ir.raw_row->>'근무일수', ir.raw_row->>'근무일'))::numeric END AS work_days_value,
        CASE WHEN btrim(COALESCE(ir.raw_row->>'근무시간', ir.raw_row->>'기본시간', ir.raw_row->>'기본근무', '')) ~ '^-?[0-9]+([.]?[0-9]+)?$'
             THEN btrim(COALESCE(ir.raw_row->>'근무시간', ir.raw_row->>'기본시간', ir.raw_row->>'기본근무'))::numeric END AS regular_hours_value,
        CASE WHEN btrim(COALESCE(ir.raw_row->>'연장시간', ir.raw_row->>'특근연장시간', ir.raw_row->>'특근연장', '')) ~ '^-?[0-9]+([.]?[0-9]+)?$'
             THEN btrim(COALESCE(ir.raw_row->>'연장시간', ir.raw_row->>'특근연장시간', ir.raw_row->>'특근연장'))::numeric END AS overtime_hours_value,
        CASE WHEN btrim(COALESCE(ir.raw_row->>'심야시간', '')) ~ '^-?[0-9]+([.]?[0-9]+)?$'
             THEN btrim(ir.raw_row->>'심야시간')::numeric END AS night_hours_value,
        CASE WHEN btrim(COALESCE(ir.raw_row->>'특근시간', '')) ~ '^-?[0-9]+([.]?[0-9]+)?$'
             THEN btrim(ir.raw_row->>'특근시간')::numeric END AS holiday_hours_value,
        CASE WHEN btrim(COALESCE(ir.raw_row->>'사용연차', '')) ~ '^-?[0-9]+([.]?[0-9]+)?$'
             THEN btrim(ir.raw_row->>'사용연차')::numeric END AS leave_used_value,
        CASE WHEN btrim(COALESCE(ir.raw_row->>'잔여연차', '')) ~ '^-?[0-9]+([.]?[0-9]+)?$'
             THEN btrim(ir.raw_row->>'잔여연차')::numeric END AS leave_remaining_value
    FROM import_rows ir
), employee_basis AS (
    -- The person key. Kept employee-driven ON PURPOSE: `data_import_rows.source_key`
    -- is per ROW, so grouping on it would yield one line per spreadsheet row.
    SELECT
        e.org_id,
        e.id AS employee_id,
        COALESCE(NULLIF(e.source_key, ''), e.id::text) AS employee_source_key,
        e.name AS employee_display_name,
        COALESCE(certificate.name, 'UNKNOWN_COMPANY') AS employee_company,
        e.leave_used,
        e.leave_remaining
    FROM employees e
    LEFT JOIN LATERAL (
        SELECT legal_entity_id FROM employment_assignments a
        WHERE a.org_id = e.org_id AND a.employee_id = e.id AND a.valid_from <= $4 AND a.superseded_at IS NULL
          AND (a.valid_to IS NULL OR a.valid_to > $4)
        ORDER BY a.valid_from DESC LIMIT 1
    ) assignment ON TRUE
    LEFT JOIN legal_entities entity ON entity.org_id = e.org_id AND entity.id = assignment.legal_entity_id
    LEFT JOIN LATERAL (
        -- 법인명 has one stored source (the entity), shown once a non-voided 등록증 open on the date is confirmed; no imported label is evidence.
        SELECT x.name FROM legal_entity_revisions x
        WHERE x.org_id = e.org_id AND x.legal_entity_id = entity.id AND x.effective_from <= $4
          AND EXISTS (
              SELECT 1 FROM business_registrations h
              WHERE h.org_id = e.org_id AND h.legal_entity_id = entity.id AND NOT h.needs_confirmation
                AND h.voided_at IS NULL AND (h.closed_on IS NULL OR h.closed_on > $4)
          )
        ORDER BY x.effective_from DESC, x.version DESC LIMIT 1
    ) certificate ON TRUE
    WHERE e.org_id = $1
), employee_metrics AS (
    SELECT
        eb.org_id,
        eb.employee_id,
        eb.employee_source_key,
        eb.employee_display_name,
        eb.employee_company,
        count(rm.id) FILTER (WHERE rm.is_payroll_source) AS payroll_source_row_count,
        count(rm.id) FILTER (WHERE rm.is_attendance_source) AS attendance_source_row_count,
        COALESCE(sum(rm.work_days_value), 0) AS work_days,
        COALESCE(sum(rm.regular_hours_value), 0) AS regular_hours,
        COALESCE(sum(rm.overtime_hours_value), 0) AS overtime_hours,
        COALESCE(sum(rm.night_hours_value), 0) AS night_hours,
        COALESCE(sum(rm.holiday_hours_value), 0) AS holiday_hours,
        COALESCE(max(rm.leave_used_value), eb.leave_used) AS leave_used,
        COALESCE(max(rm.leave_remaining_value), eb.leave_remaining) AS leave_remaining,
        bool_or(COALESCE(rm.has_gross_pay_source, FALSE)) AS gross_pay_source_present,
        bool_or(COALESCE(rm.has_net_pay_source, FALSE)) AS net_pay_source_present,
        COALESCE(array_agg(rm.id ORDER BY rm.source_filename, rm.source_sheet, rm.source_row)
                 FILTER (WHERE rm.id IS NOT NULL), ARRAY[]::uuid[]) AS source_data_import_row_ids
    FROM employee_basis eb
    LEFT JOIN row_metrics rm
      ON rm.org_id = eb.org_id
     AND rm.canonical_source_key = eb.employee_source_key
    GROUP BY
        eb.org_id, eb.employee_id, eb.employee_source_key,
        eb.employee_display_name, eb.employee_company, eb.leave_used, eb.leave_remaining
)
INSERT INTO payroll_draft_lines (
    org_id, run_id, employee_id, employee_source_key, employee_display_name,
    employee_company, payroll_source_row_count, attendance_source_row_count,
    attendance_event_count, work_days, regular_hours, overtime_hours, night_hours,
    holiday_hours, leave_used, leave_remaining, gross_pay_source_present,
    net_pay_source_present, nts_tax_row_status, calculation_status, blockers,
    source_data_import_row_ids
)
SELECT
    em.org_id, $2, em.employee_id, em.employee_source_key, em.employee_display_name,
    em.employee_company, em.payroll_source_row_count::integer,
    em.attendance_source_row_count::integer,
    -- No production writer sets attendance events yet; the script recorded 0 too.
    0,
    em.work_days, em.regular_hours, em.overtime_hours, em.night_hours,
    em.holiday_hours, em.leave_used, em.leave_remaining,
    em.gross_pay_source_present, em.net_pay_source_present,
    'REQUIRED_NOT_SUPPLIED',
    'BLOCKED_LEGAL_GATE',
    jsonb_build_array(
        'Payroll calculation remains blocked until an official NTS row and professional validation are attached',
        'HR must review source rows, leave balances, employment status, and statutory insurance applicability before approval',
        'Wage-statement issuance requires approved payroll run, passkey step-up, and immutable audit evidence'
    ),
    em.source_data_import_row_ids
FROM employee_metrics em
-- Admission: imported material only. The script also admitted anyone with
-- `leave_remaining > 0`; such a line carries no evidence and can only ever block
-- the close.
WHERE em.payroll_source_row_count > 0
   OR em.attendance_source_row_count > 0
ON CONFLICT (org_id, run_id, employee_source_key) DO UPDATE SET
    employee_id = EXCLUDED.employee_id,
    employee_display_name = EXCLUDED.employee_display_name,
    employee_company = EXCLUDED.employee_company,
    payroll_source_row_count = EXCLUDED.payroll_source_row_count,
    attendance_source_row_count = EXCLUDED.attendance_source_row_count,
    attendance_event_count = EXCLUDED.attendance_event_count,
    work_days = EXCLUDED.work_days,
    regular_hours = EXCLUDED.regular_hours,
    overtime_hours = EXCLUDED.overtime_hours,
    night_hours = EXCLUDED.night_hours,
    holiday_hours = EXCLUDED.holiday_hours,
    leave_used = EXCLUDED.leave_used,
    leave_remaining = EXCLUDED.leave_remaining,
    gross_pay_source_present = EXCLUDED.gross_pay_source_present,
    net_pay_source_present = EXCLUDED.net_pay_source_present,
    nts_tax_row_status = 'REQUIRED_NOT_SUPPLIED',
    calculation_status = 'BLOCKED_LEGAL_GATE',
    blockers = EXCLUDED.blockers,
    source_data_import_row_ids = EXCLUDED.source_data_import_row_ids
"#;

/// Materialise the roster for `run_id` from import runs declared for exactly
/// this pay period.
///
/// Returns the number of lines written. An EMPTY result is not an error: the
/// caller stages runs from a workflow drain that leaves a failed event PENDING
/// without incrementing its attempt count, so returning `Err` here would be an
/// unbounded hot retry. The close preflight already refuses an empty roster
/// legibly, with `명세 대상 없음(로스터 0명)`, which is where an operator should
/// meet this problem.
pub async fn materialise_roster_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    run_id: Uuid,
    period_start: Date,
    period_end: Date,
) -> Result<u64, sqlx::Error> {
    let done = sqlx::query(MATERIALISE_ROSTER_SQL)
        .bind(org_id)
        .bind(run_id)
        .bind(period_start)
        .bind(period_end)
        .execute(tx.as_mut())
        .await?;
    Ok(done.rows_affected())
}
