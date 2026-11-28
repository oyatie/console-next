// SPDX-License-Identifier: LicenseRef-Proprietary
//! Single-statement `INSERT … SELECT … ON CONFLICT` for roster materialisation.

pub(super) const MATERIALISE_ROSTER_SQL: &str = r#"
WITH scope AS (
    -- Single-group entities cover the whole legal entity; multi-group entities require
    -- every active entity employee overlapping the period to carry a pay-group assignment.
    SELECT r.pay_group_id, g.legal_entity_id, r.attribution_month,
           EXISTS (
               SELECT 1 FROM pay_groups o
               WHERE o.org_id = r.org_id AND o.legal_entity_id = g.legal_entity_id AND o.id <> g.id
           ) AS has_multi_groups,
           r.pay_group_id IS NOT NULL AND r.kind = 'REGULAR' AND (
               NOT EXISTS (
                   SELECT 1 FROM pay_groups o
                   WHERE o.org_id = r.org_id AND o.legal_entity_id = g.legal_entity_id AND o.id <> g.id
               )
               OR (
                   EXISTS (
                       SELECT 1 FROM employee_pay_group_assignments pga
                       JOIN pay_groups pg2 ON pg2.org_id = pga.org_id AND pg2.id = pga.pay_group_id
                       WHERE pga.org_id = r.org_id AND pg2.legal_entity_id = g.legal_entity_id AND pga.superseded_at IS NULL
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM employees em
                       WHERE em.org_id = r.org_id
                         AND em.merged_into_employee_id IS NULL AND em.employment_status <> 'VOIDED'
                         AND (em.hire_on IS NULL OR em.hire_on <= LEAST($4, entity_today()))
                         AND (em.exit_on IS NULL OR em.exit_on >= $3)
                         AND NOT (em.employment_status = 'EXITED' AND em.exit_on IS NULL)
                         AND EXISTS (
                             SELECT 1 FROM employment_assignments ea
                             WHERE ea.org_id = em.org_id AND ea.employee_id = em.id AND ea.superseded_at IS NULL
                               AND ea.legal_entity_id = g.legal_entity_id
                               AND ea.valid_from <= $4 AND (ea.valid_to IS NULL OR ea.valid_to > $3)
                         )
                         AND NOT EXISTS (
                             SELECT 1 FROM employee_pay_group_assignments pga
                             JOIN pay_groups pg2 ON pg2.org_id = pga.org_id AND pg2.id = pga.pay_group_id
                             WHERE pga.org_id = em.org_id AND pga.employee_id = em.id
                               AND pg2.legal_entity_id = g.legal_entity_id AND pga.superseded_at IS NULL
                               AND pga.effective_from <= LEAST($4, em.exit_on)
                               AND (pga.effective_to_exclusive IS NULL OR pga.effective_to_exclusive > GREATEST($3, em.hire_on))
                         )
                   )
               )
           ) AS roster_defined
    FROM payroll_draft_runs r
    LEFT JOIN pay_groups g ON g.org_id = r.org_id AND g.id = r.pay_group_id
    WHERE r.org_id = $1 AND r.id = $2
), members AS (
    SELECT m.id AS employee_id
    FROM scope s
    JOIN employees m ON m.org_id = $1
    WHERE s.roster_defined
      AND m.merged_into_employee_id IS NULL AND m.employment_status <> 'VOIDED'
      AND (m.hire_on IS NULL OR m.hire_on <= LEAST($4, entity_today()))
      AND (m.exit_on IS NULL OR m.exit_on >= $3)
      AND NOT (m.employment_status = 'EXITED' AND m.exit_on IS NULL)
      AND EXISTS (
          SELECT 1 FROM employment_assignments a
          WHERE a.org_id = m.org_id AND a.employee_id = m.id AND a.superseded_at IS NULL
            AND a.legal_entity_id = s.legal_entity_id
            AND a.valid_from <= $4 AND (a.valid_to IS NULL OR a.valid_to > $3)
      )
      -- A close freezes its roster. A subsequent assignment cannot move an already
      -- closed full-month wage into a second group of the same legal entity.
      AND NOT EXISTS (
          SELECT 1 FROM payroll_draft_runs paid
          JOIN pay_groups pg ON pg.org_id = paid.org_id AND pg.id = paid.pay_group_id
          JOIN payroll_draft_lines line ON line.org_id = paid.org_id AND line.run_id = paid.id
          WHERE paid.org_id = m.org_id AND pg.legal_entity_id = s.legal_entity_id
            AND paid.attribution_month = s.attribution_month AND paid.kind = 'REGULAR'
            AND paid.pay_group_id <> s.pay_group_id
            AND paid.status NOT IN ('STAGED','BLOCKED_LEGAL_GATE','READY_FOR_REVIEW','VOID')
            AND line.employee_id = m.id AND line.calculation_status <> 'VOID'
      )
      AND (
          NOT s.has_multi_groups
          -- A full-period source belongs to the first applicable group in that period.
          -- A transfer later in the period cannot pay that source a second time.
          OR s.pay_group_id = (
              SELECT pga.pay_group_id FROM employee_pay_group_assignments pga
              JOIN pay_groups pg ON pg.org_id = pga.org_id AND pg.id = pga.pay_group_id
              WHERE pga.org_id = m.org_id AND pga.employee_id = m.id
                AND pg.legal_entity_id = s.legal_entity_id AND pga.superseded_at IS NULL
                AND pga.effective_from <= LEAST($4, m.exit_on)
                AND (pga.effective_to_exclusive IS NULL OR pga.effective_to_exclusive > GREATEST($3, m.hire_on))
              ORDER BY pga.effective_from, pga.id
              LIMIT 1
          )
      )
    FOR KEY SHARE OF m
), import_rows AS (
    SELECT
        r.id,
        r.org_id,
        r.source_sheet,
        r.source_row,
        run.source_filename,
        COALESCE(NULLIF(r.canonical_row->>'source_key', ''), NULLIF(r.source_key, '')) AS canonical_source_key,
        r.raw_row,
        r.canonical_row->'canonical' AS typed,
        COALESCE(run.mapping_profile->'target_allowlist', '[]'::jsonb) ? 'work_days' AS reads_typed,
        present.keys && array['기본시급','통상시급','공제총액','소득세','건강보험','건강/장기요양','고용보험','급여산정일','지급일','연차수당','상여금','은행','계좌','주민번호'] AS is_payroll_source,
        present.keys && array['근무일자','출근','퇴근','근무시간','기본시간','기본근무','연장시간','심야시간','특근시간','특근연장시간','특근연장','근무일명칭','지각,조퇴시간'] AS is_attendance_source,
        present.keys && array['기본급','상여금','월계','합계','총합','연차수당'] AS has_gross_pay_source,
        present.keys && array['차인지급액','실지급액','공제총액','소득세','건강보험','고용보험'] AS has_net_pay_source
    FROM data_import_rows r
    JOIN data_import_runs run
      ON run.id = r.run_id
     AND run.org_id = r.org_id
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
      AND run.status = 'APPLIED'
      AND r.row_status <> 'ERROR'
      AND run.pay_period_start = $3
      AND run.pay_period_end = $4
), row_values AS (
    SELECT
        ir.*,
        CASE WHEN ir.reads_typed THEN ir.typed->>'work_days'
             ELSE COALESCE(ir.raw_row->>'근무일수', ir.raw_row->>'근무일') END AS work_days_text,
        CASE WHEN ir.reads_typed THEN ir.typed->>'regular_hours'
             ELSE COALESCE(ir.raw_row->>'근무시간', ir.raw_row->>'기본시간', ir.raw_row->>'기본근무') END AS regular_hours_text,
        CASE WHEN ir.reads_typed THEN ir.typed->>'overtime_hours'
             ELSE COALESCE(ir.raw_row->>'연장시간', ir.raw_row->>'특근연장시간', ir.raw_row->>'특근연장') END AS overtime_hours_text,
        CASE WHEN ir.reads_typed THEN ir.typed->>'night_hours' ELSE ir.raw_row->>'심야시간' END AS night_hours_text,
        CASE WHEN ir.reads_typed THEN ir.typed->>'holiday_hours' ELSE ir.raw_row->>'특근시간' END AS holiday_hours_text,
        CASE WHEN ir.reads_typed THEN ir.typed->>'leave_used' ELSE ir.raw_row->>'사용연차' END AS leave_used_text,
        CASE WHEN ir.reads_typed THEN ir.typed->>'leave_remaining' ELSE ir.raw_row->>'잔여연차' END AS leave_remaining_text
    FROM import_rows ir
), row_metrics AS (
    SELECT
        rv.*,
        CASE WHEN btrim(COALESCE(rv.work_days_text, '')) ~ '^-?[0-9]+([.]?[0-9]+)?$'
             THEN btrim(rv.work_days_text)::numeric END AS work_days_value,
        CASE WHEN btrim(COALESCE(rv.regular_hours_text, '')) ~ '^-?[0-9]+([.]?[0-9]+)?$'
             THEN btrim(rv.regular_hours_text)::numeric END AS regular_hours_value,
        CASE WHEN btrim(COALESCE(rv.overtime_hours_text, '')) ~ '^-?[0-9]+([.]?[0-9]+)?$'
             THEN btrim(rv.overtime_hours_text)::numeric END AS overtime_hours_value,
        CASE WHEN btrim(COALESCE(rv.night_hours_text, '')) ~ '^-?[0-9]+([.]?[0-9]+)?$'
             THEN btrim(rv.night_hours_text)::numeric END AS night_hours_value,
        CASE WHEN btrim(COALESCE(rv.holiday_hours_text, '')) ~ '^-?[0-9]+([.]?[0-9]+)?$'
             THEN btrim(rv.holiday_hours_text)::numeric END AS holiday_hours_value,
        CASE WHEN btrim(COALESCE(rv.leave_used_text, '')) ~ '^-?[0-9]+([.]?[0-9]+)?$'
             THEN btrim(rv.leave_used_text)::numeric END AS leave_used_value,
        CASE WHEN btrim(COALESCE(rv.leave_remaining_text, '')) ~ '^-?[0-9]+([.]?[0-9]+)?$'
             THEN btrim(rv.leave_remaining_text)::numeric END AS leave_remaining_value
    FROM row_values rv
), employee_basis AS (
    SELECT
        e.org_id,
        e.id AS employee_id,
        COALESCE(NULLIF(e.source_key, ''), e.id::text) AS employee_source_key,
        e.name AS employee_display_name,
        e.leave_used,
        e.leave_remaining,
        COALESCE(epf.bank_account_registered, FALSE) AS bank_account_registered
    FROM person_employees_current e
    LEFT JOIN employee_personal_facts epf
      ON epf.org_id = e.org_id AND epf.employee_id = e.id
    WHERE e.org_id = $1
), employee_metrics AS (
    SELECT
        eb.org_id,
        eb.employee_id,
        eb.employee_source_key,
        eb.employee_display_name,
        eb.bank_account_registered,
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
        eb.employee_display_name, eb.bank_account_registered,
        eb.leave_used, eb.leave_remaining
), upserted AS (
INSERT INTO payroll_draft_lines (
    org_id, run_id, employee_id, employee_source_key, employee_display_name,
    employee_company, payroll_source_row_count, attendance_source_row_count,
    attendance_event_count, work_days, regular_hours, overtime_hours, night_hours,
    holiday_hours, leave_used, leave_remaining, gross_pay_source_present,
    net_pay_source_present, bank_account_registered, nts_tax_row_status, calculation_status, blockers,
    source_data_import_row_ids
)
SELECT
    em.org_id, $2, em.employee_id, em.employee_source_key, em.employee_display_name,
    'UNKNOWN_COMPANY', em.payroll_source_row_count::integer,
    em.attendance_source_row_count::integer,
    0,
    em.work_days, em.regular_hours, em.overtime_hours, em.night_hours,
    em.holiday_hours, em.leave_used, em.leave_remaining,
    em.gross_pay_source_present, em.net_pay_source_present,
    em.bank_account_registered,
    'REQUIRED_NOT_SUPPLIED',
    'BLOCKED_LEGAL_GATE',
    jsonb_build_array(
        'Payroll calculation remains blocked until an official NTS row and professional validation are attached',
        'HR must review source rows, leave balances, employment status, and statutory insurance applicability before approval',
        'Wage-statement issuance requires approved payroll run, passkey step-up, and immutable audit evidence'
    ),
    em.source_data_import_row_ids
FROM employee_metrics em
CROSS JOIN scope s
WHERE CASE WHEN s.pay_group_id IS NULL
           THEN em.payroll_source_row_count > 0 OR em.attendance_source_row_count > 0
           ELSE em.employee_id IN (SELECT employee_id FROM members) END
ON CONFLICT (org_id, run_id, employee_source_key) DO UPDATE SET
    employee_id = EXCLUDED.employee_id,
    employee_display_name = EXCLUDED.employee_display_name,
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
    bank_account_registered = EXCLUDED.bank_account_registered,
    nts_tax_row_status = 'REQUIRED_NOT_SUPPLIED',
    calculation_status = 'BLOCKED_LEGAL_GATE',
    blockers = EXCLUDED.blockers,
    source_data_import_row_ids = EXCLUDED.source_data_import_row_ids
RETURNING id
), retracted AS (
    UPDATE payroll_draft_lines x
       SET calculation_status = 'VOID', blockers = '[]'::jsonb, updated_at = now()
    FROM scope s
    WHERE s.roster_defined AND x.org_id = $1 AND x.run_id = $2
      AND x.calculation_status <> 'VOID' AND x.id NOT IN (SELECT id FROM upserted)
)
SELECT count(*) FROM upserted
"#;
