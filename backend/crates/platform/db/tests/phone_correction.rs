// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::panic)]

use sqlx::PgPool;

#[sqlx::test(migrations = false)]
async fn corrects_stored_phones_and_preserves_revision_history(pool: PgPool) {
    let migrator = sqlx::migrate!("./migrations");
    let mut conn = pool.acquire().await.unwrap();
    sqlx::raw_sql(
        "DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO console_app', current_database()); END $$;
         GRANT CREATE ON SCHEMA public TO console_app;
         SET SESSION AUTHORIZATION console_app;",
    ).execute(&mut *conn).await.unwrap();
    migrator
        .run_to(20261117160918000, &mut *conn)
        .await
        .unwrap();
    sqlx::query("RESET SESSION AUTHORIZATION")
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::raw_sql(
        "DO $$ DECLARE
            org uuid; run uuid; actor uuid; employee uuid; entity uuid; workplace uuid; revision uuid;
        BEGIN
            INSERT INTO organizations(slug,name) VALUES ('phone-correction','Contacts') RETURNING id INTO org;
            INSERT INTO users(org_id,display_name,phone) VALUES (org,'Owner','+82021234567') RETURNING id INTO actor;
            INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key)
                VALUES (org,'Co','Worker','test','test',1,'worker') RETURNING id INTO employee;
            PERFORM console_bind_employee_person(org,employee,NULL);
            INSERT INTO employee_employment_profiles(org_id,employee_id,employment_type,phone_e164,idempotency_key,request_hash,created_by)
                VALUES (org,employee,'REGULAR','+8201012345678','worker',repeat('a',64),actor);
            INSERT INTO employee_emergency_contacts(org_id,employee_id,seq,name,relation,phone_e164,created_by)
                VALUES (org,employee,1,'Contact','OTHER','+820821012345678',actor);
            INSERT INTO data_import_runs(org_id,entity_type,status,source_filename,source_format,source_sha256,created_by)
                VALUES (org,'employee_hr','PREVIEWED','sample.csv','csv',repeat('a',64),actor) RETURNING id INTO run;
            INSERT INTO data_import_row_phones(org_id,run_id,source_key,phone_e164)
                VALUES (org,run,'worker','+82055100080');
            INSERT INTO legal_entities(org_id,created_change_mode,needs_confirmation)
                VALUES (org,'MIGRATION',true) RETURNING id INTO entity;
            INSERT INTO legal_entity_revisions(org_id,legal_entity_id,version,command_id,effective_from,name,main_phone,
                change_mode,reason_code,payload_digest,settings_snapshot)
                VALUES (org,entity,1,gen_random_uuid(),CURRENT_DATE,'Entity','+82821012345678',
                    'MIGRATION','import',digest('entity','sha256'),'{}') RETURNING id INTO revision;
            INSERT INTO legal_entity_representatives(org_id,revision_id,seq,name) VALUES (org,revision,1,'Owner');
            INSERT INTO workplaces(org_id,legal_entity_id,created_change_mode,needs_confirmation)
                VALUES (org,entity,'MIGRATION',true) RETURNING id INTO workplace;
            INSERT INTO workplace_revisions(org_id,workplace_id,version,command_id,effective_from,name,
                phone,fax,mobile,status,change_mode,reason_code,payload_digest,settings_snapshot)
                VALUES (org,workplace,1,gen_random_uuid(),CURRENT_DATE,'Workplace','+820061234567',
                    '+821055556666',NULL,'CONTINUING','MIGRATION','import',digest('workplace','sha256'),'{}');
            INSERT INTO workplace_revisions(org_id,workplace_id,version,command_id,effective_from,name,
                phone,status,status_since,change_mode,reason_code,payload_digest,settings_snapshot)
                VALUES (org,workplace,2,gen_random_uuid(),CURRENT_DATE + 1,'Closed','+821055550000',
                    'CLOSED',CURRENT_DATE + 1,'MIGRATION','LEGAL_ENTITY_DISSOLVED',digest('close','sha256'),'{}');
        END $$;",
    )
    .execute(&mut *conn)
    .await
    .unwrap();

    sqlx::query("SET SESSION AUTHORIZATION console_app")
        .execute(&mut *conn)
        .await
        .unwrap();
    migrator.run(&mut *conn).await.unwrap();
    sqlx::query("RESET SESSION AUTHORIZATION")
        .execute(&mut *conn)
        .await
        .unwrap();
    let contacts: (String, String, String, String) = sqlx::query_as(
        "SELECT u.phone, console_person_facts(u.org_id,u.person_id)->>'phone',
            p.phone_e164, c.phone_e164 FROM users u JOIN organizations o ON u.org_id=o.id
            JOIN employee_employment_profiles p ON p.org_id=o.id
            JOIN employee_emergency_contacts c ON c.employee_id=p.employee_id
            WHERE o.slug='phone-correction'",
    )
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    assert_eq!(
        contacts,
        (
            "+8221234567".into(),
            "+8221234567".into(),
            "+821012345678".into(),
            "+821012345678".into()
        )
    );

    let staged: String = sqlx::query_scalar("SELECT phone_e164 FROM data_import_row_phones p JOIN organizations o ON o.id=p.org_id WHERE o.slug='phone-correction'")
        .fetch_one(&mut *conn).await.unwrap();
    assert_eq!(staged, "+8255100080");
    let history: Vec<(String, String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT e.main_phone,w.phone,w.fax,w.mobile,r.name FROM legal_entity_revisions e
            JOIN organizations o ON e.org_id=o.id
            JOIN workplace_revisions w ON w.org_id=e.org_id AND w.effective_from=e.effective_from AND (e.version=1)=(w.version=1)
            JOIN legal_entity_representatives r ON r.revision_id=e.id
            WHERE o.slug='phone-correction' ORDER BY e.version",
    )
    .fetch_all(&mut *conn)
    .await
    .unwrap();
    assert_eq!(history.len(), 2);
    for ((entity, work, fax, mobile, rep), (main_phone, phone)) in history.into_iter().zip([
        ("+82821012345678", "+820061234567"),
        ("+821012345678", "+8261234567"),
    ]) {
        assert_eq!((entity.as_str(), work.as_str()), (main_phone, phone));
        assert_eq!(fax, "+821055556666");
        assert_eq!(mobile, None);
        assert_eq!(rep, "Owner");
    }
    let head: (String, String, String) = sqlx::query_as(
        "SELECT w.name,w.phone,w.reason_code FROM workplace_revisions w JOIN organizations o ON o.id=w.org_id
            WHERE o.slug='phone-correction' ORDER BY w.version DESC LIMIT 1",
    ).fetch_one(&mut *conn).await.unwrap();
    assert_eq!(
        head,
        (
            "Closed".into(),
            "+821055550000".into(),
            "LEGAL_ENTITY_DISSOLVED".into()
        )
    );
    // A canary rollback can put the old writers back on every contact surface.
    sqlx::raw_sql(
        r#"DO $$ DECLARE field record; val jsonb;
        BEGIN
            FOR field IN SELECT * FROM (VALUES
                ('users','phone'), ('employee_employment_profiles','phone_e164'),
                ('employee_emergency_contacts','phone_e164'), ('data_import_row_phones','phone_e164'),
                ('person_revisions','attributes'), ('legal_entity_revisions','main_phone'),
                ('workplace_revisions','phone'), ('workplace_revisions','fax'), ('workplace_revisions','mobile')
            ) fields(rel,col) LOOP
                val := CASE WHEN field.col='attributes' THEN '{"phone":"+82055100080"}'::jsonb
                    ELSE to_jsonb('+82055100080'::text) END;
                BEGIN
                    EXECUTE format('INSERT INTO %I SELECT (jsonb_populate_record(r,$1)).* FROM %I r
                        WHERE org_id=(SELECT id FROM organizations WHERE slug=%L) LIMIT 1',
                        field.rel, field.rel, 'phone-correction') USING jsonb_build_object(field.col,val);
                    RAISE EXCEPTION 'Legacy write accepted on %.%', field.rel, field.col;
                EXCEPTION WHEN check_violation THEN
                    IF SQLERRM <> 'Noncanonical Korean phone' THEN RAISE; END IF;
                END;
            END LOOP;
        END $$;"#,
    ).execute(&mut *conn).await.unwrap();
}

#[sqlx::test(migrations = false)]
async fn preserves_unresolved_and_colliding_accounts_across_tenants(pool: PgPool) {
    let migrator = sqlx::migrate!("./migrations");
    migrator.run_to(20261117160918000, &pool).await.unwrap();
    sqlx::raw_sql(
        "INSERT INTO organizations(slug,name) VALUES ('phone-a','A'), ('phone-b','B');
         INSERT INTO users(org_id,display_name,phone)
         SELECT o.id, label, phone FROM (VALUES
             ('phone-a','1','+82000000'),
             ('phone-a','2','+8201012345678'),
             ('phone-b','3','+82821012345678'),
             ('phone-a','4','+82021234567'),
             ('phone-b','5','+8221234567'),
             ('phone-a','6','+82055100080')
         ) cases(slug,label,phone) JOIN organizations o USING(slug);",
    )
    .execute(&pool)
    .await
    .unwrap();
    migrator.run(&pool).await.unwrap();
    let phones: Vec<String> = sqlx::query_scalar(
        "SELECT phone FROM users JOIN organizations o ON o.id=users.org_id
         WHERE o.slug IN ('phone-a','phone-b') ORDER BY display_name",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        phones,
        [
            "+82000000",
            "+8201012345678",
            "+82821012345678",
            "+82021234567",
            "+8221234567",
            "+8255100080",
        ]
    );
}
