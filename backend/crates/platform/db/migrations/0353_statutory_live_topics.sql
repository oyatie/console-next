-- Reuse the existing employee topic and its Cedar fanout; no personal receipt data in the stream.
SET LOCAL lock_timeout = '2s';
INSERT INTO realtime_topic_map(target_type, action, resource_type, carries_id) VALUES
    ('insurance_filing', 'insurance_filing.recorded', 'employee', false),
    ('insurance_filing', 'insurance_filing.clock_tick', 'employee', false);
