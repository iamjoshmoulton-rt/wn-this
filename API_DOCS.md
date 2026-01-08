# Whatnot Pulse Extension - API Documentation

This document describes the API endpoints that the Chrome extension uses to communicate with the Lovable backend.

## Base URL

All endpoints are located at:
```
https://bahjsgjolebntwdxybek.supabase.co/functions/v1
```

## Authentication

All requests require an API key in the `x-api-key` header:
```javascript
headers: {
  'Content-Type': 'application/json',
  'x-api-key': 'YOUR_API_KEY'
}
```

---

## Endpoint 1: Validate API Key

**Endpoint:** `POST /validate-api-key`

**Description:** Validates the provided API key and returns the organization information.

**Request:**
```javascript
fetch('https://bahjsgjolebntwdxybek.supabase.co/functions/v1/validate-api-key', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'YOUR_API_KEY'
  },
  body: JSON.stringify({})  // Empty body, key is in header
})
```

**Success Response (200):**
```json
{
  "valid": true,
  "organization_id": "d7516078-d74b-45d5-85dd-c77a8eced213",
  "organization_name": "My Organization",
  "message": "API key is valid"
}
```

**Error Response (401):**
```json
{
  "valid": false,
  "error": "Invalid API key"  // or "API key has been revoked"
}
```

---

## Endpoint 2: Log Sale

**Endpoint:** `POST /log-sale`

**Description:** Logs a sale or giveaway event from a Whatnot live stream. This is the MOST IMPORTANT endpoint - called every time a sale or giveaway occurs.

**Request:**
```javascript
fetch('https://bahjsgjolebntwdxybek.supabase.co/functions/v1/log-sale', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'YOUR_API_KEY'
  },
  body: JSON.stringify({
    // REQUIRED FIELDS
    streamer_username: "refreshedtech",      // The seller's username
    item_name: "Apple iPad 10.2\"",          // Product name
    sold_price: 101.00,                       // Price as number (use 0 for giveaways)
    buyer_username: "wirelessguys",          // Buyer's username

    // OPTIONAL FIELDS
    is_giveaway: false,                       // true if this was a giveaway (default: false)
    is_pending: false,                        // true if payment is still pending (default: false)
    pending_items: 15,                        // Number of items still waiting to be sold
    raw_data: {                               // Full scraped data for debugging
      listingId: "TGlzdGluZ05vZGU6MTIzNDU2", // Unique listing ID from href
      href: "/live/...",
      imageUrl: "https://...",
      timestamp: "2025-01-08T12:30:00Z"
    }
  })
})
```

**Request Body:**
- `streamer_username` (string, required): Username of the streamer/seller
- `item_name` (string, required): Name of the item sold
- `sold_price` (number, required): Price the item sold for (use 0 for giveaways)
- `buyer_username` (string, required): Username of the buyer
- `is_giveaway` (boolean, optional): Whether this was a giveaway (default: false, auto-detected if price = 0)
- `is_pending` (boolean, optional): Whether payment is still pending (default: false, true if "Payment Pending" text found)
- `pending_items` (number, optional): Number of items still waiting to be sold in the queue
- `raw_data` (object, optional): Full scraped data for debugging (listingId, href, imageUrl, timestamp, etc.)

**Success Response (200):**
```json
{
  "success": true,
  "sale_id": "uuid",
  "message": "Sale logged successfully"
}
```

**Duplicate Response (200):**
If the same sale is sent twice within 5 minutes, the server automatically ignores it:
```json
{
  "success": true,
  "duplicate": true,
  "message": "Duplicate sale ignored"
}
```

**Error Response (400):**
```json
{
  "error": "Missing required fields: streamer_username, item_name, sold_price, buyer_username"
}
```

**Important Notes:**
- **Duplicate Detection**: The server automatically ignores duplicate sales based on:
  - Same `streamer_username`
  - Same `item_name`
  - Same `buyer_username`
  - Same `sold_price`
  - Within 5 minutes of each other
- The extension doesn't need to handle deduplication - the server handles it automatically
- Always send giveaways with `sold_price: 0` and `is_giveaway: true`
- Pending payments are tracked with `is_pending: true` and the actual pending price in `sold_price`

---

## Endpoint 3: Update Live Status

**Endpoint:** `POST /update-live-status`

**Description:** Called when a streamer goes live or ends their stream. Also updates viewer count periodically.

**Request:**
```javascript
fetch('https://bahjsgjolebntwdxybek.supabase.co/functions/v1/update-live-status', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'YOUR_API_KEY'
  },
  body: JSON.stringify({
    // REQUIRED FIELDS
    streamer_username: "refreshedtech",      // The seller's username
    is_live: true,                            // true = currently live, false = stream ended

    // OPTIONAL FIELDS (only needed when is_live: true)
    stream_url: "https://www.whatnot.com/live/abc123",
    title: "iPad Auction Night!",
    viewer_count: 1250                        // Current viewer count (tracks peak automatically)
  })
})
```

**Request Body:**
- `streamer_username` (string, required): Username of the streamer
- `is_live` (boolean, required): Whether the stream is currently live
- `stream_url` (string, optional): URL of the live stream (only when `is_live: true`)
- `title` (string, optional): Stream title (only when `is_live: true`)
- `viewer_count` (number, optional): Current viewer count (only when `is_live: true`, tracks peak automatically)

**Success Response (200):**
```json
{
  "success": true,
  "session_id": "uuid",
  "action": "created"   // or "updated" or "ended" or "no_active_session"
}
```

**When to call:**
- Call with `is_live: true` when you detect a streamer is live
- Call with updated `viewer_count` periodically (every 30-60 seconds) to track peak viewers
- Call with `is_live: false` when the stream ends

---

## Endpoint 4: Update Profile

**Endpoint:** `POST /update-profile`

**Description:** Scrape and send streamer profile data (follower count, category, avatar).

**Request:**
```javascript
fetch('https://bahjsgjolebntwdxybek.supabase.co/functions/v1/update-profile', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'YOUR_API_KEY'
  },
  body: JSON.stringify({
    // REQUIRED FIELDS
    username: "refreshedtech",               // The seller's username

    // OPTIONAL FIELDS
    followers: 15420,                         // Follower count as number
    category: "Electronics",                  // Primary category
    avatarUrl: "https://cdn.whatnot.com/...", // Profile image URL
    rating: 4.9                               // Seller rating (if available)
  })
})
```

**Request Body:**
- `username` (string, required): Streamer username
- `followers` (number, optional): Number of followers
- `category` (string, optional): Primary category (e.g., "Electronics")
- `avatarUrl` (string, optional): URL to the streamer's avatar image
- `rating` (number, optional): Seller rating (if available)

**Success Response (200):**
```json
{
  "success": true,
  "message": "Profile updated for refreshedtech",
  "streamer_id": "uuid"
}
```

**When to call:**
- When visiting a seller's profile page
- Periodically to keep data fresh (e.g., once per day per seller)

---

## Endpoint 5: Update Scheduled Lives

**Endpoint:** `POST /update-scheduled-lives`

**Description:** Send upcoming scheduled streams from a seller's profile.

**Request:**
```javascript
fetch('https://bahjsgjolebntwdxybek.supabase.co/functions/v1/update-scheduled-lives', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'YOUR_API_KEY'
  },
  body: JSON.stringify({
    // REQUIRED FIELDS
    username: "refreshedtech",
    scheduledLives: [
      {
        streamId: "TGl2ZVNob3dOb2RlOjEyMzQ1",   // Unique ID from href
        streamUrl: "https://www.whatnot.com/live/refreshedtech/...",
        scheduledAt: "2026-01-08T19:00:00Z",    // ISO 8601 format
        title: "Wednesday Night Electronics"    // Optional
      },
      {
        streamId: "TGl2ZVNob3dOb2RlOjY3ODkw",
        streamUrl: "https://www.whatnot.com/live/refreshedtech/...",
        scheduledAt: "2026-01-09T20:00:00Z",
        title: "Thursday Clearance Sale"
      }
    ]
  })
})
```

**Request Body:**
- `username` (string, required): Streamer username
- `scheduledLives` (array, required): Array of scheduled live stream objects
  - `streamId` (string, required): Unique stream identifier (extract from href containing `TGl2ZVNob3dOb2RlOi...`)
  - `streamUrl` (string, required): Full URL to the scheduled stream
  - `scheduledAt` (string, ISO 8601, required): Scheduled start time
  - `title` (string, optional): Stream title

**Success Response (200):**
```json
{
  "success": true,
  "message": "Processed 2 scheduled lives for refreshedtech",
  "processed": 2,
  "errors": 0
}
```

---

## Error Handling

All endpoints may return error responses:

**Error Response:**
```json
{
  "error": "Error message",
  "success": false
}
```

**Common HTTP Status Codes:**
- `200`: Success
- `400`: Bad Request (invalid payload or missing required fields)
- `401`: Unauthorized (invalid API key or API key revoked)
- `500`: Internal Server Error

---

## Rate Limiting

The extension implements:
- Request queuing with automatic retry
- Exponential backoff for failed requests
- Maximum retry attempts: 3
- Retry delays: 1s → 2s → 4s → max 30s

---

## Extension Behavior

### Automatic Operations

1. **Sales Tracking**: Automatically captures and sends sales every 5 seconds
2. **Heartbeat**: Sends status updates every 30 seconds via `/update-live-status`
3. **Profile Updates**: Scrapes and sends profile data when visiting profile pages
4. **Scheduled Lives**: Automatically detects and monitors scheduled streams

### Data Scraping Targets

#### On Live Stream Page:
| Data Point | Where to Find | Endpoint |
|------------|---------------|----------|
| Sale item name | Sales feed card | log-sale |
| Sold price | Sales feed card | log-sale |
| Buyer username | Sales feed card | log-sale |
| Is giveaway | Price = $0 or "giveaway" text | log-sale |
| Is pending payment | "Payment Pending: $XX" text/orange styling | log-sale |
| Pending items count | Queue/pending section | log-sale |
| Viewer count | Stream header | update-live-status |
| Stream title | Stream header | update-live-status |
| Listing ID | `href` attribute containing `TGlzdGluZ05vZGU6...` | log-sale (in raw_data) |

#### On Profile Page:
| Data Point | Where to Find | Endpoint |
|------------|---------------|----------|
| Follower count | Profile stats | update-profile |
| Category | Profile header | update-profile |
| Avatar URL | Profile image src | update-profile |
| Scheduled streams | Upcoming streams section | update-scheduled-lives |
| Stream IDs | `href` containing `TGl2ZVNob3dOb2RlOi...` | update-scheduled-lives |

---

## Testing

To test endpoints manually, use the browser console on a Whatnot page with the extension loaded:

```javascript
// Test sale logging
chrome.runtime.sendMessage({
  type: 'NEW_SALE',
  sale: {
    streamer_username: 'refreshedtech',
    item_name: 'Test Item',
    sold_price: 50.00,
    buyer_username: 'testbuyer',
    is_giveaway: false,
    pending_items: 10
  }
});

// Test profile update
chrome.runtime.sendMessage({
  type: 'PROFILE_DATA',
  data: {
    username: 'refreshedtech',
    followers: 15420,
    category: 'Electronics',
    avatar_url: 'https://example.com/avatar.jpg'
  }
});
```

---

## Support

For issues or questions, check the extension logs:
- **Content Script**: Browser console on Whatnot pages (F12)
- **Background Script**: `chrome://extensions` → Service Worker → Inspect
