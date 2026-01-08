-- Migration: Enable Full Replica Identity for live_sessions table
-- Purpose: Ensures real-time UPDATE events include full row data for all column changes
-- Date: 2025-01-08
--
-- Background:
-- By default, Supabase realtime UPDATE events only include the primary key when
-- REPLICA IDENTITY is set to DEFAULT. Setting it to FULL ensures all column
-- changes (current_viewers, pending_items, etc.) are included in the event payload,
-- allowing the dashboard to properly react to real-time updates from the extension.
--
-- This is critical for:
-- - Real-time viewer count updates
-- - Real-time pending items tracking
-- - Immediate dashboard refresh without polling delays

-- Enable full row data in realtime updates for live_sessions
ALTER TABLE public.live_sessions REPLICA IDENTITY FULL;

-- Verify the change was applied (this will be included in the migration output)
SELECT 
  schemaname,
  tablename,
  CASE 
    WHEN relreplident = 'd' THEN 'DEFAULT'
    WHEN relreplident = 'n' THEN 'NOTHING'
    WHEN relreplident = 'f' THEN 'FULL'
    WHEN relreplident = 'i' THEN 'INDEX'
    ELSE 'UNKNOWN'
  END as replica_identity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_tables t ON t.schemaname = n.nspname AND t.tablename = c.relname
WHERE schemaname = 'public' 
  AND tablename = 'live_sessions';

-- Expected output: replica_identity should be 'FULL'

