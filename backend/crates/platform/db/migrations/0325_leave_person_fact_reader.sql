-- Expand the locked fact reader to the leave command connection. It returns
-- only independence, explicitly qualifies the tenant, and changes no rows.
-- The leave routine and its integrity trigger use the same transaction.
GRANT EXECUTE ON FUNCTION public.console_independent_people(UUID, UUID, UUID)
    TO console_leave_cmd;
