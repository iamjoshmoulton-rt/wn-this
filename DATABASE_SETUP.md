# Database Setup Guide

This guide walks you through setting up the Supabase database for the Whatnot Pulse extension.

## Prerequisites

- A Supabase project (sign up at https://supabase.com)
- Access to your Supabase SQL Editor

## Step 1: Apply Database Migration

The extension requires a database migration to enable full real-time updates for viewer counts and pending items.

### Apply Migration

1. Open your Supabase Dashboard
2. Navigate to **SQL Editor**
3. Click **New Query**
4. Copy the entire contents of [`migrations/001_enable_full_replica_identity_live_sessions.sql`](migrations/001_enable_full_replica_identity_live_sessions.sql)
5. Paste into the SQL Editor
6. Click **Run** (or press `Ctrl/Cmd + Enter`)

### Verify Migration

After running the migration, you should see output showing:

```
replica_identity | FULL
```

If you see `DEFAULT` instead, the migration did not apply correctly. Check for any error messages.

### What This Does

Setting `REPLICA IDENTITY FULL` ensures that when the extension updates viewer counts or pending items:
- All column changes are included in real-time UPDATE events
- Your dashboard receives complete data in real-time subscriptions
- Updates appear instantly without polling delays

**Without this migration:**
- Real-time updates may only include primary key changes
- Viewer counts and pending items may not update in real-time
- Dashboard may rely solely on polling intervals

**With this migration:**
- ✅ Real-time viewer count updates work immediately
- ✅ Real-time pending items tracking works immediately
- ✅ Dashboard refreshes instantly via Supabase realtime subscriptions

## Step 2: Verify Realtime Publication

Ensure that `live_sessions` and `sales_feed` tables are in your Supabase realtime publication:

1. Go to **Database** → **Replication** in your Supabase Dashboard
2. Check that both tables are enabled for realtime:
   - `live_sessions`
   - `sales_feed`

If they're not enabled, enable them from the Supabase Dashboard.

## Step 3: Test Real-Time Updates

After applying the migration:

1. Open your dashboard that subscribes to `live_sessions` changes
2. Have the extension send an `update-live-status` request with new viewer count or pending items
3. Verify the dashboard updates immediately (within 1-2 seconds) without requiring a manual refresh

## Troubleshooting

### Migration fails with permission error

- Ensure you're logged in as a project owner or have database admin privileges
- Try running the migration from the Supabase Dashboard SQL Editor (recommended)

### Real-time updates still not working

1. **Check replica identity:**
   ```sql
   SELECT 
     schemaname,
     tablename,
     CASE 
       WHEN relreplident = 'd' THEN 'DEFAULT'
       WHEN relreplident = 'f' THEN 'FULL'
       ELSE 'UNKNOWN'
     END as replica_identity
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   JOIN pg_tables t ON t.schemaname = n.nspname AND t.tablename = c.relname
   WHERE schemaname = 'public' 
     AND tablename = 'live_sessions';
   ```
   Should return `FULL`.

2. **Check realtime publication:**
   - Go to Database → Replication
   - Verify `live_sessions` is enabled

3. **Check dashboard subscription:**
   - Ensure your dashboard code subscribes to `postgres_changes` on `live_sessions` table
   - Verify the subscription is active (check browser console for connection status)

## Related Files

- [`migrations/001_enable_full_replica_identity_live_sessions.sql`](migrations/001_enable_full_replica_identity_live_sessions.sql) - The migration SQL
- [`migrations/README.md`](migrations/README.md) - Detailed migration instructions
- [`API_DOCS.md`](API_DOCS.md) - API endpoint documentation

