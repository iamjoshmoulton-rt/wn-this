# Database Migrations

This directory contains SQL migration files for the Supabase database used by the Whatnot Pulse extension.

## How to Apply Migrations

### Option 1: Using Supabase Dashboard (Recommended)

1. Log in to your Supabase Dashboard: https://supabase.com/dashboard
2. Select your project
3. Navigate to **SQL Editor** in the left sidebar
4. Click **New Query**
5. Copy and paste the contents of the migration file (e.g., `001_enable_full_replica_identity_live_sessions.sql`)
6. Click **Run** (or press `Ctrl/Cmd + Enter`)
7. Verify the output shows `replica_identity = 'FULL'`

### Option 2: Using Supabase CLI

If you have the Supabase CLI installed and configured:

```bash
# Make sure you're in the project root
cd /path/to/your/project

# Apply the migration
supabase db push migrations/001_enable_full_replica_identity_live_sessions.sql
```

### Option 3: Direct psql Connection

If you have direct database access:

```bash
psql -h <your-db-host> -U postgres -d postgres -f migrations/001_enable_full_replica_identity_live_sessions.sql
```

## Migration Files

### `001_enable_full_replica_identity_live_sessions.sql`

**Purpose:** Enables full row data in real-time UPDATE events for the `live_sessions` table.

**Why this matters:**
- By default, Supabase realtime UPDATE events only include the primary key
- Setting `REPLICA IDENTITY FULL` ensures all column changes are included in the event payload
- This allows the dashboard to properly react to real-time updates for `current_viewers`, `pending_items`, etc.

**Impact:**
- ✅ Real-time viewer count updates work immediately
- ✅ Real-time pending items tracking works immediately
- ✅ Dashboard refreshes instantly without relying on polling

**Safety:** This is a safe, non-breaking change that only affects how data is replicated for real-time subscriptions.

## Verifying Migrations

After applying a migration, you can verify it worked by running:

```sql
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
```

Expected result: `replica_identity = 'FULL'`

## Notes

- Migrations are run in order by filename
- Always backup your database before running migrations in production
- Test migrations in a development/staging environment first

