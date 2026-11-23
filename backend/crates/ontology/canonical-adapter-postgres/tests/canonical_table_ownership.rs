// SPDX-License-Identifier: LicenseRef-Proprietary
use console_ontology_canonical_domain::ObjectKey;
use sqlx::PgPool;

#[sqlx::test(migrations = false)]
async fn migrated_canonical_tables_have_only_expected_writers(pool: PgPool) -> sqlx::Result<()> {
    let mut connection = pool.acquire().await?;
    let transfer: String = sqlx::query_scalar(
        "SELECT format('ALTER DATABASE %I OWNER TO console_app', current_database())",
    )
    .fetch_one(&mut *connection)
    .await?;
    sqlx::query(sqlx::AssertSqlSafe(transfer))
        .execute(&mut *connection)
        .await?;
    sqlx::query("SET SESSION AUTHORIZATION console_app")
        .execute(&mut *connection)
        .await?;
    sqlx::migrate!("../../platform/db/migrations")
        .run(&mut *connection)
        .await?;
    sqlx::query("RESET SESSION AUTHORIZATION")
        .execute(&mut *connection)
        .await?;

    let mut tables: Vec<_> = ObjectKey::ALL
        .iter()
        .flat_map(|key| key.owned_tables().iter().copied())
        .collect();
    tables.sort_unstable();
    // An entry lost from the registry would otherwise also disappear from the census.
    assert_eq!(
        tables,
        [
            "company_revisions",
            "employee_person_bindings",
            "employees",
            "employment_heads",
            "employment_revisions",
            "employment_source_bindings",
            "job_position_revisions",
            "job_positions",
            "org_unit_revisions",
            "org_unit_source_bindings",
            "org_units",
            "organizations",
            "payroll_disbursements",
            "payroll_draft_lines",
            "payroll_draft_runs",
            "payroll_line_calculations",
            "payroll_payslip_deliveries",
            "payroll_run_exceptions",
            "person_revisions",
            "persons",
        ]
    );

    // One real public table per registry name, including partitioned tables.
    let resolved: Vec<String> = sqlx::query_scalar(
        "SELECT relname::text FROM pg_class WHERE relname = ANY($1)
         GROUP BY relname HAVING count(*) = 1 AND bool_and(
           relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')
         ) ORDER BY relname COLLATE \"C\"",
    )
    .bind(&tables)
    .fetch_all(&mut *connection)
    .await?;
    assert_eq!(tables, resolved);

    let findings: Vec<(String, String)> = sqlx::query_as(
        "WITH RECURSIVE relations(oid) AS (
           SELECT oid FROM pg_class WHERE relname = ANY($1)
           UNION
           SELECT CASE WHEN i.inhparent = r.oid THEN i.inhrelid ELSE i.inhparent END
           FROM relations r JOIN pg_inherits i ON r.oid IN (i.inhparent, i.inhrelid)
         )
         SELECT c.oid::regclass::text, 'owner: ' || pg_get_userbyid(c.relowner)
         FROM relations r JOIN pg_class c USING (oid)
         WHERE c.relowner <> 'console_app'::regrole
         UNION ALL
         SELECT 'console_app', 'owner membership: ' || rolname FROM pg_roles
         WHERE rolname NOT IN (session_user, 'console_app')
           AND (pg_has_role(oid, 'console_app', 'USAGE') OR pg_has_role(oid, 'console_app', 'SET'))
         UNION ALL
         SELECT c.oid::regclass::text, candidate.rolname || ': ' || privilege
         FROM relations r JOIN pg_class c USING (oid) CROSS JOIN pg_roles candidate
         CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS verb(privilege)
         WHERE candidate.rolname NOT IN (session_user, 'console_app', 'console_rt', 'pg_write_all_data')
           AND NOT (candidate.rolname = 'console_leave_definer' AND (
             (c.oid = 'public.employees'::regclass AND privilege IN ('INSERT', 'UPDATE'))
             OR (c.oid IN ('public.persons'::regclass, 'public.person_revisions'::regclass,
                     'public.employee_person_bindings'::regclass) AND privilege = 'INSERT')
           ))
           AND EXISTS (
             SELECT FROM pg_roles holder WHERE pg_has_role(candidate.oid, holder.oid, 'SET')
               AND CASE WHEN privilege IN ('INSERT', 'UPDATE')
                   THEN has_any_column_privilege(holder.oid, c.oid, privilege)
                   ELSE has_table_privilege(holder.oid, c.oid, privilege) END
           )
         ORDER BY 1, 2",
    )
    .bind(&tables)
    .fetch_all(&mut *connection)
    .await?;
    assert!(
        findings.is_empty(),
        "unexpected canonical table access: {findings:?}"
    );
    Ok(())
}
