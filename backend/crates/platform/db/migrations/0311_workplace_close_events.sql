-- UX-R2 ENDS (#27 event stream, #28 jobs report progress): the close job's
-- audit actions become change events once the realtime pair's topic map
-- (hard/rt/stream 0273) exists. The DO block is a no-op before it; if the
-- realtime pair lands after this migration, INTEG copies these rows into it.
SET LOCAL lock_timeout = '2s';

DO $$
BEGIN
    IF to_regclass('public.realtime_topic_map') IS NOT NULL THEN
        INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
            ('workplace', 'workplace.close_plan', 'workplace', true),
            ('workplace', 'workplace.close_job.apply', 'workplace', true),
            ('workplace', 'workplace.close_job.wait', 'workplace', true),
            ('workplace', 'workplace.close_job.fail', 'workplace', true),
            ('workplace', 'workplace.close_job.cancel', 'workplace', true)
        ON CONFLICT DO NOTHING;
    END IF;
END $$;
