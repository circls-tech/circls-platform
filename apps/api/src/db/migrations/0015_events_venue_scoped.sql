-- Subproject C: events are venue-scoped, not arena-scoped. Drop the
-- event_arenas M2M join entirely (cascade FKs go with it).
DROP TABLE IF EXISTS "event_arenas";
