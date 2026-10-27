-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Calendar reference data for the supported country-pack zone. Holidays reuse
-- attendance_public_holidays, the migration-owned official reference calendar.
CREATE TABLE access_log_review_calendar (
    time_zone TEXT PRIMARY KEY,
    weekend_isodays SMALLINT[] NOT NULL CHECK (weekend_isodays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
    edition TEXT NOT NULL
);
REVOKE ALL PRIVILEGES ON access_log_review_calendar FROM PUBLIC, console_rt;
GRANT SELECT ON access_log_review_calendar TO console_rt;
INSERT INTO access_log_review_calendar(time_zone, weekend_isodays, edition)
VALUES ('Asia/Seoul', ARRAY[6,7]::smallint[], 'KR-2026-10-28');
COMMENT ON TABLE access_log_review_calendar IS 'Migration-owned calendar reference data for access review';
COMMENT ON COLUMN access_log_review_calendar.time_zone IS 'pd:none — country-pack time zone';
COMMENT ON COLUMN access_log_review_calendar.weekend_isodays IS 'pd:none — ISO weekend days';
COMMENT ON COLUMN access_log_review_calendar.edition IS 'pd:none — reference data edition';
