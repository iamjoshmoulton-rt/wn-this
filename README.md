# Whatnot Pulse Chrome Extension

A high-performance Chrome extension (Manifest V3) that captures live sales data from Whatnot.com livestreams and sends it to your multi-tenant Supabase backend.

## Features

- **Real-time Sales Monitoring**: Automatically detects and captures sales events from Whatnot livestreams
- **Streamer Identification**: Extracts streamer information from DOM (profile links, title, meta tags)
- **Adaptive Detection**: Smart pattern matching that adapts to different Whatnot page layouts
- **Deduplication**: Prevents duplicate sales entries using transaction signatures
- **Multi-tenant Support**: Secure API key authentication with tenant isolation
- **Error Handling**: Automatic retry logic with exponential backoff
- **Connection Monitoring**: Heartbeat system to track API connectivity

## Installation

1. **Clone or download this repository**

2. **Load the extension in Chrome**:
   - Open Chrome and navigate to `chrome://extensions`
   - Enable "Developer mode" (toggle in top-right)
   - Click "Load unpacked"
   - Select the `WhatNot-Extension` folder

3. **Configure the extension**:
   - Click the extension icon in Chrome toolbar
   - Enter your Supabase project URL (e.g., `https://your-project.supabase.co`)
   - Enter your SaaS API key
   - Click "Save & Connect"

## Configuration

### Supabase Setup

You'll need to create two Edge Functions in your Supabase project:

#### 1. `/functions/v1/log-sale`

This function receives sales data and stores it in your database.

**Request format:**
```json
{
  "organization_id": "string",
  "streamer_id": "string",
  "item_name": "string",
  "sold_price": number,
  "buyer_username": "string",
  "is_giveaway": boolean,
  "timestamp": "ISO 8601 string"
}
```

**Response:**
```json
{
  "success": true,
  "id": "record_id"
}
```

#### 2. `/functions/v1/validate-api-key`

This function validates the API key and returns the organization_id.

**Request:**
- Method: `GET`
- Headers: `x-api-key: <your-api-key>`

**Response:**
```json
{
  "valid": true,
  "organization_id": "string",
  "organization_name": "string",
  "message": "API key is valid"
}
```

#### 3. `/functions/v1/extension-heartbeat`

This function receives periodic presence updates from the extension to track active status in the dashboard.

**Request:**
- Method: `POST`
- Headers: `x-api-key: <your-api-key>`, `Content-Type: application/json`

**Request Body:**
```json
{
  "organization_id": "string",
  "streamer_id": "string or null",
  "is_active": boolean,
  "is_connected": boolean,
  "queue_length": number,
  "is_processing": boolean,
  "last_sale_sent_at": "ISO 8601 string or null",
  "last_heartbeat_at": "ISO 8601 string",
  "timestamp": "ISO 8601 string"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Heartbeat received"
}
```

**Note:** The extension sends heartbeats every 30 seconds when connected. The dashboard can use this to:
- Track if extensions are online/offline
- Monitor which streamers are being tracked
- See queue status and activity levels
- Display real-time extension status

### Database Schema

You'll need a table to store sales data. Example schema:

```sql
CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  streamer_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  sold_price DECIMAL(10, 2) NOT NULL,
  buyer_username TEXT NOT NULL,
  is_giveaway BOOLEAN DEFAULT FALSE,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sales_org_streamer ON sales(organization_id, streamer_id);
CREATE INDEX idx_sales_timestamp ON sales(timestamp);
```

### Database Migrations

**Important:** For real-time dashboard updates to work properly, you need to run the database migration to enable full replica identity on the `live_sessions` table.

See [`migrations/README.md`](migrations/README.md) for detailed instructions on how to apply migrations.

**Quick Start:**
1. Go to your Supabase Dashboard → SQL Editor
2. Run the migration: `migrations/001_enable_full_replica_identity_live_sessions.sql`
3. Verify the output shows `replica_identity = 'FULL'`

This ensures that real-time viewer count and pending items updates work immediately in your dashboard.

## Usage

1. **Configure API credentials** in the extension popup
2. **Navigate to any Whatnot live stream** (URL pattern: `https://www.whatnot.com/live/*`)
3. **The extension automatically starts monitoring** when it detects a live stream
4. **Sales are captured in real-time** and sent to your Supabase backend
5. **Check the popup** to see connection status, queue length, and current streamer

## How It Works

1. **Content Script** (`content.js`):
   - Monitors the Whatnot page DOM for changes
   - Extracts streamer ID from profile links or page title
   - Detects sales events using adaptive pattern matching
   - Creates transaction signatures for deduplication

2. **Background Service Worker** (`background.js`):
   - Validates API keys and fetches tenant_id
   - Queues sales data for transmission
   - Implements retry logic with exponential backoff
   - Maintains connection heartbeat

3. **Popup UI** (`popup.html/js`):
   - Provides interface for API key configuration
   - Displays connection status and statistics
   - Shows current streamer being monitored

## Development

### Project Structure

```
WhatNot-Extension/
├── manifest.json          # Extension manifest (Manifest V3)
├── content.js             # DOM monitoring script
├── background.js          # Service worker for API calls
├── popup.html             # Configuration UI
├── popup.js               # Popup logic
├── styles/
│   └── popup.css          # Popup styling
├── icons/                 # Extension icons
└── README.md              # This file
```

### Testing

1. Open Chrome DevTools on a Whatnot live stream page
2. Check the Console tab for `[Whatnot Pulse]` log messages
3. Monitor the Network tab for API requests to Supabase
4. Use the extension popup to check status and configuration

### Debugging

- **Content Script**: Check browser console on the Whatnot page
- **Background Script**: Check `chrome://extensions` → "Service Worker" link
- **Storage**: Use `chrome.storage.local` in DevTools console

## Permissions

The extension requires:
- `activeTab`: Access to current tab content
- `storage`: Store API keys and configuration
- `unlimitedStorage`: Handle large transaction logs
- Host permission for `*.whatnot.com/*`: Monitor Whatnot pages

## Privacy & Security

- All data processing happens locally in your browser
- API keys are stored securely in Chrome's local storage
- No data is shared with third parties
- Direct communication only between extension and your Supabase instance

## Troubleshooting

**Extension not detecting sales:**
- Ensure you're on a live stream page (`/live/` in URL)
- Check browser console for error messages
- Verify the page structure hasn't changed (Whatnot may update their DOM)

**API connection issues:**
- Verify your Supabase URL is correct
- Check that your API key is valid
- Ensure Edge Functions are deployed correctly
- Check network tab for failed requests

**Streamer ID not detected:**
- The extension tries multiple methods to extract streamer ID
- Check console for extraction attempts
- Manually verify profile links exist on the page

## License

MIT License - See LICENSE file for details

## Support

For issues or feature requests, please open an issue on the repository.
