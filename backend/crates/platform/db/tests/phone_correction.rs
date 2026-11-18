// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::panic)]

use sqlx::{Connection, PgPool};

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
            INSERT INTO users(org_id,display_name,phone) VALUES (org,'Owner','+820021234567') RETURNING id INTO actor;
            INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key)
                VALUES (org,'Co','Worker','test','test',1,'worker') RETURNING id INTO employee;
            PERFORM console_bind_employee_person(org,employee,NULL);
            INSERT INTO employee_employment_profiles(org_id,employee_id,employment_type,phone_e164,idempotency_key,request_hash,created_by)
                VALUES (org,employee,'REGULAR','+820031234567','worker',repeat('a',64),actor);
            INSERT INTO employee_emergency_contacts(org_id,employee_id,seq,name,relation,phone_e164,created_by)
                VALUES (org,employee,1,'Contact','OTHER','+820042345678',actor);
            INSERT INTO data_import_runs(org_id,entity_type,status,source_filename,source_format,source_sha256,created_by)
                VALUES (org,'employee_hr','PREVIEWED','sample.csv','csv',repeat('a',64),actor) RETURNING id INTO run;
            INSERT INTO data_import_row_phones(org_id,run_id,source_key,phone_e164)
                VALUES (org,run,'worker','+820071234567');
            INSERT INTO legal_entities(org_id,created_change_mode,needs_confirmation)
                VALUES (org,'MIGRATION',true) RETURNING id INTO entity;
            INSERT INTO legal_entity_revisions(org_id,legal_entity_id,version,command_id,effective_from,name,main_phone,
                change_mode,reason_code,payload_digest,settings_snapshot)
                VALUES (org,entity,1,gen_random_uuid(),CURRENT_DATE,'Entity','+820051234567',
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
            "+8231234567".into(),
            "+8242345678".into()
        )
    );

    let staged: String = sqlx::query_scalar("SELECT phone_e164 FROM data_import_row_phones p JOIN organizations o ON o.id=p.org_id WHERE o.slug='phone-correction'")
        .fetch_one(&mut *conn).await.unwrap();
    assert_eq!(staged, "+8271234567");
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
        ("+820051234567", "+820061234567"),
        ("+8251234567", "+8261234567"),
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
}

#[sqlx::test(migrations = false)]
async fn unresolved_account_phones_roll_back_without_reassigning_a_contact(pool: PgPool) {
    let migrator = sqlx::migrate!("./migrations");
    migrator.run_to(20261117160918000, &pool).await.unwrap();
    let org: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO organizations(slug,name) VALUES ('phone-review','Contacts') RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO users(org_id,display_name,phone) VALUES ($1,'Recoverable','+820021234567')",
    )
    .bind(org)
    .execute(&pool)
    .await
    .unwrap();
    for (phone, expected) in [
        ("+8221234567", "23505"),
        ("+82055100080", "P0001"),
        ("+82000000", "P0001"),
    ] {
        let id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO users(org_id,display_name,phone) VALUES ($1,'Review',$2) RETURNING id",
        )
        .bind(org)
        .bind(phone)
        .fetch_one(&pool)
        .await
        .unwrap();
        let mut conn = pool.acquire().await.unwrap();
        let err = migrator.run(&mut *conn).await.unwrap_err();
        conn.detach().close().await.unwrap();
        let sqlx::migrate::MigrateError::ExecuteMigration(sqlx::Error::Database(db), _) = err
        else {
            panic!("expected a database migration error, got {err}");
        };
        assert_eq!(db.code().as_deref(), Some(expected));
        let preserved: String = sqlx::query_scalar(
            "SELECT phone FROM users WHERE org_id=$1 AND display_name='Recoverable'",
        )
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(preserved, "+820021234567");
        sqlx::query("UPDATE users SET phone=NULL WHERE id=$1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        // Person contact facts have independent ownership from account sign-in phones.
        sqlx::query(r#"SELECT console_revise_person_facts(org_id,person_id,'{"phone":null}',NULL) FROM users WHERE id=$1"#)
            .bind(id).execute(&pool).await.unwrap();
    }
    migrator.run(&pool).await.unwrap();
}
