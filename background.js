/**
 * Whatnot Pulse - Background Service Worker
 * Handles API communication, tenant authentication, and request queuing
 */

// Configuration
const CONFIG = {
  // Supabase configuration - will be set via popup
  SUPABASE_URL: null,
  SUPABASE_ENDPOINT: '/functions/v1/log-sale',
  VALIDATION_ENDPOINT: '/functions/v1/validate-api-key',
  LIVE_STATUS_ENDPOINT: '/functions/v1/update-live-status',
  PROFILE_ENDPOINT: '/functions/v1/update-profile',
  SCHEDULED_LIVES_ENDPOINT: '/functions/v1/update-scheduled-lives',
  
  // Retry configuration
  MAX_RETRIES: 3,
  INITIAL_RETRY_DELAY: 1000, // 1 second
  MAX_RETRY_DELAY: 30000, // 30 seconds
  
  // Request queue
  QUEUE_MAX_SIZE: 100,
  
  // Viewer count update interval (30 seconds)
  VIEWER_COUNT_INTERVAL: 30000
};

// State
let apiKey = null;
let organizationId = null;
let requestQueue = [];
let isProcessingQueue = false;
let retryDelays = new Map(); // Track retry delays per request
let connectionStatus = {
  connected: false,
  lastCheck: null,
  error: null
};

// Multi-stream state management - Map keyed by livestream_id (UUID)
const streamsMap = new Map(); // Key: stream_id (UUID), Value: stream state object
const updateIntervalsMap = new Map(); // Key: stream_id, Value: intervalId for viewer count updates

/**
 * Get or create stream state for a given stream ID
 * @param {string} streamId - Livestream UUID
 * @returns {Object} Stream state object
 */
function getOrCreateStream(streamId) {
  if (!streamId) {
    console.warn('[Whatnot Pulse] getOrCreateStream called without streamId');
    return null;
  }
  
  if (!streamsMap.has(streamId)) {
    streamsMap.set(streamId, {
      streamer_username: null,
      title: null,
      stream_url: null,
      stream_id: streamId,
      lastViewerCount: null,
      lastPendingItems: null,
      stream_start_time: null
    });
    console.log('[Whatnot Pulse] Created new stream state for:', streamId);
  }
  return streamsMap.get(streamId);
}

/**
 * Get stream state by tab ID
 * @param {number} tabId - Chrome tab ID
 * @returns {Promise<Object|null>} Stream state or null if not found
 */
async function getStreamByTabId(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url) return null;
    
    const streamId = extractStreamIdFromUrl(tab.url);
    if (!streamId) return null;
    
    return streamsMap.get(streamId) || null;
  } catch (error) {
    console.warn('[Whatnot Pulse] Error getting stream by tab ID:', error);
    return null;
  }
}

/**
 * Reset stream session - clears stream-specific state
 * If streamId is provided, only clears that specific stream. Otherwise clears all streams.
 * Called when URL changes, streamer changes, or tab navigates away
 * @param {string|null} streamId - Optional stream ID to reset. If null, resets all streams.
 */
function resetStreamSession(streamId = null) {
  if (streamId) {
    // Reset only this specific stream
    console.log('[Whatnot Pulse] Resetting stream session for stream:', streamId);
    
    // Stop any active viewer count updates for this stream
    const intervalId = updateIntervalsMap.get(streamId);
    if (intervalId) {
      clearInterval(intervalId);
      updateIntervalsMap.delete(streamId);
      console.log('[Whatnot Pulse] Stopped viewer count updates for stream:', streamId);
    }
    
    // Remove stream from map
    const streamState = streamsMap.get(streamId);
    if (streamState) {
      streamsMap.delete(streamId);
      console.log('[Whatnot Pulse] Removed stream state for:', streamId);
      
      // Clear stored stream info if this was the last stream (legacy storage)
      // Note: In multi-stream mode, we may want to keep storage per-stream
      // For now, we'll keep the legacy behavior but it only affects the last stream
    }
    
    console.log('[Whatnot Pulse] Stream session reset complete for:', streamId);
  } else {
    // Reset all streams
    console.log('[Whatnot Pulse] Resetting ALL stream sessions - clearing all streams');
    
    // Stop all active viewer count updates
    updateIntervalsMap.forEach((intervalId, sid) => {
      clearInterval(intervalId);
      console.log('[Whatnot Pulse] Stopped viewer count updates for stream:', sid);
    });
    updateIntervalsMap.clear();
    
    // Clear all streams from map
    streamsMap.clear();
    
    // Clear stored stream info
    chrome.storage.local.remove([
      'current_streamer_username',
      'current_stream_title',
      'current_stream_url'
    ]).catch(err => {
      console.warn('[Whatnot Pulse] Error clearing stored stream info:', err);
    });
    
    console.log('[Whatnot Pulse] All stream sessions reset complete');
  }
}

/**
 * Extract streamer username from URL
 * Returns username or null if not a live stream URL
 */
function extractStreamerFromUrl(url) {
  if (!url) return null;
  
  // Pattern: /live/username or /live/uuid
  const liveMatch = url.match(/\/live\/([^\/\?]+)/);
  if (liveMatch && liveMatch[1]) {
    return liveMatch[1];
  }
  
  return null;
}

/**
 * Extract stream ID (UUID) from URL
 * Returns UUID or null if not found
 */
function extractStreamIdFromUrl(url) {
  if (!url) return null;
  // Pattern: /live/{uuid} where uuid is 36 characters (8-4-4-4-12 hex digits)
  const match = url.match(/\/live\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  return match ? match[1] : null;
}

/**
 * Load configuration from storage
 */
async function loadConfig() {
  try {
    const result = await chrome.storage.local.get([
      'api_key',
      'organization_id',
      'supabase_url',
      'connection_status',
      'connection_checked_at'
    ]);
    
    if (result.api_key) {
      apiKey = result.api_key;
    }
    
    if (result.organization_id) {
      organizationId = result.organization_id;
    }
    
    if (result.supabase_url) {
      CONFIG.SUPABASE_URL = result.supabase_url;
    }

    // Restore connection status from storage
    if (result.connection_status === 'connected' && result.connection_checked_at) {
      const timeSinceCheck = Date.now() - result.connection_checked_at;
      // If checked within last hour, assume still connected
      if (timeSinceCheck < 3600000) {
        connectionStatus.connected = true;
        connectionStatus.lastCheck = result.connection_checked_at;
      }
    }
    
    return { apiKey, organizationId, supabaseUrl: CONFIG.SUPABASE_URL };
  } catch (error) {
    console.error('[Whatnot Pulse] Error loading config:', error);
    return { apiKey: null, organizationId: null, supabaseUrl: null };
  }
}

/**
 * Validate API key and get organization_id from Supabase
 */
async function validateApiKey(key) {
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:95',message:'validateApiKey called',data:{hasUrl:!!CONFIG.SUPABASE_URL,url:CONFIG.SUPABASE_URL?.substring(0,50),hasKey:!!key},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion
  
  if (!CONFIG.SUPABASE_URL) {
    throw new Error('Supabase URL not configured');
  }

  try {
    const url = `${CONFIG.SUPABASE_URL}${CONFIG.VALIDATION_ENDPOINT}`;
    
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:103',message:'About to call fetch',data:{url:url.substring(0,100)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    
    const fetchStartTime = Date.now();
    // Add timeout to prevent hanging (10 seconds)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key
        },
        signal: controller.signal
      });
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') {
        throw new Error('Connection timeout: Request took longer than 10 seconds');
      }
      throw fetchError;
    }
    
    clearTimeout(timeoutId);

    // #region agent log
    const fetchDuration = Date.now() - fetchStartTime;
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:113',message:'Fetch response received',data:{ok:response.ok,status:response.status,duration:fetchDuration},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `Validation failed: ${response.status}`;
      try {
        const errorData = JSON.parse(errorText);
        errorMessage = errorData.error || errorMessage;
      } catch {
        errorMessage += ` - ${errorText}`;
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:126',message:'Validation response parsed',data:{valid:data.valid,hasOrgId:!!data.organization_id},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    
    if (data.valid && data.organization_id) {
      organizationId = data.organization_id;
      const now = Date.now();
      await chrome.storage.local.set({ 
        organization_id: organizationId,
        connection_status: 'connected',
        connection_checked_at: now
      });
      connectionStatus.connected = true;
      connectionStatus.lastCheck = now;
      connectionStatus.error = null;
      
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:137',message:'validateApiKey success',data:{organizationId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      
      return organizationId;
    } else {
      // Update status to disconnected on validation failure
      await chrome.storage.local.set({ connection_status: 'disconnected' });
      throw new Error(data.error || 'Invalid API key');
    }
  } catch (error) {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:145',message:'validateApiKey error',data:{error:error.message,stack:error.stack?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    console.error('[Whatnot Pulse] API key validation error:', error);
    connectionStatus.connected = false;
    connectionStatus.error = error.message;
    throw error;
  }
}

/**
 * Calculate exponential backoff delay
 */
function getRetryDelay(attemptNumber) {
  const delay = Math.min(
    CONFIG.INITIAL_RETRY_DELAY * Math.pow(2, attemptNumber),
    CONFIG.MAX_RETRY_DELAY
  );
  // Add jitter to prevent thundering herd
  return delay + Math.random() * 1000;
}

/**
 * Send sale data to Supabase
 */
async function sendSaleToSupabase(sale, retryCount = 0) {
  if (!CONFIG.SUPABASE_URL) {
    throw new Error('Supabase URL not configured');
  }

  if (!apiKey) {
    throw new Error('API key not configured');
  }

  if (!organizationId) {
    // Try to validate API key first
    try {
      await validateApiKey(apiKey);
    } catch (error) {
      throw new Error(`Cannot get organization_id: ${error.message}`);
    }
  }

  try {
    const url = `${CONFIG.SUPABASE_URL}${CONFIG.SUPABASE_ENDPOINT}`;
    const payload = {
      streamer_username: sale.streamer_username,
      item_name: sale.item_name,
      sold_price: sale.sold_price,
      buyer_username: sale.buyer_username,
      is_giveaway: sale.is_giveaway || false,
      is_pending: sale.is_pending || false, // Track pending payments
      payment_status: sale.payment_status || undefined, // NEW: Payment status string
      pending_items: sale.pending_items || undefined,
      raw_data: sale.raw_data || undefined
    };
    
    // Remove undefined fields
    Object.keys(payload).forEach(key => {
      if (payload[key] === undefined) {
        delete payload[key];
      }
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    connectionStatus.connected = true;
    connectionStatus.lastCheck = Date.now();
    connectionStatus.error = null;
    
    // Reset retry delay on success
    retryDelays.delete(JSON.stringify(sale));
    
    return result;
  } catch (error) {
    console.error(`[Whatnot Pulse] Error sending sale (attempt ${retryCount + 1}):`, error);
    connectionStatus.connected = false;
    connectionStatus.error = error.message;
    
    // Retry logic
    if (retryCount < CONFIG.MAX_RETRIES) {
      const delay = getRetryDelay(retryCount);
      retryDelays.set(JSON.stringify(sale), delay);
      
      // Queue for retry
      setTimeout(() => {
        sendSaleToSupabase(sale, retryCount + 1).catch(err => {
          console.error('[Whatnot Pulse] Retry failed:', err);
        });
      }, delay);
      
      throw error; // Still throw to queue the request
    } else {
      // Max retries exceeded
      console.error('[Whatnot Pulse] Max retries exceeded for sale:', sale);
      throw error;
    }
  }
}

/**
 * Process queued requests
 */
async function processQueue() {
  if (isProcessingQueue || requestQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;

  while (requestQueue.length > 0) {
    const sale = requestQueue.shift();
    
    try {
      await sendSaleToSupabase(sale);
      console.log('[Whatnot Pulse] Sale sent successfully:', sale);
      
      // Update last sale sent timestamp
      await chrome.storage.local.set({ 
        last_sale_sent_at: new Date().toISOString() 
      });
    } catch (error) {
      // Re-queue if not max retries
      const saleString = JSON.stringify(sale);
      const retryCount = retryDelays.get(saleString) ? 
        Math.floor(Math.log2((retryDelays.get(saleString) || CONFIG.INITIAL_RETRY_DELAY) / CONFIG.INITIAL_RETRY_DELAY)) : 0;
      
      if (retryCount < CONFIG.MAX_RETRIES) {
        requestQueue.push(sale);
        console.log('[Whatnot Pulse] Re-queued sale for retry:', sale);
      } else {
        console.error('[Whatnot Pulse] Failed to send sale after max retries:', sale);
      }
    }
    
    // Small delay between requests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  isProcessingQueue = false;
}

/**
 * Queue a sale for processing
 */
function queueSale(sale) {
  // Deduplication check - include stream_id to prevent cross-stream duplicates
  // This ensures "iPad" sold in Stream A is not marked as duplicate of "iPad" sold in Stream B
  const streamId = sale.stream_id || 'unknown';
  const saleSignature = `${streamId}|${sale.streamer_username}|${sale.item_name}|${sale.buyer_username}|${sale.timestamp || Date.now()}`;
  const existingSale = requestQueue.find(s => {
    const existingStreamId = s.stream_id || 'unknown';
    const existingSignature = `${existingStreamId}|${s.streamer_username}|${s.item_name}|${s.buyer_username}|${s.timestamp || Date.now()}`;
    return existingSignature === saleSignature;
  });
  
  if (existingSale) {
    console.log('[Whatnot Pulse] Duplicate sale ignored (including stream_id check):', sale);
    return;
  }

  if (requestQueue.length >= CONFIG.QUEUE_MAX_SIZE) {
    console.warn('[Whatnot Pulse] Queue full, dropping oldest sale');
    requestQueue.shift();
  }

  requestQueue.push(sale);
  processQueue();
}

/**
 * Update live stream status
 */
async function updateLiveStatus(data) {
  if (!CONFIG.SUPABASE_URL || !apiKey) {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:364',message:'updateLiveStatus skipped - no URL or API key',data:{hasUrl:!!CONFIG.SUPABASE_URL,hasApiKey:!!apiKey},timestamp:Date.now(),sessionId:'debug-session',runId:'run5',hypothesisId:'H5'})}).catch(()=>{});
    // #endregion
    return;
  }

  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:370',message:'updateLiveStatus called',data:{viewer_count:data.viewer_count,streamer_username:data.streamer_username,is_live:data.is_live,fullPayload:data},timestamp:Date.now(),sessionId:'debug-session',runId:'run5',hypothesisId:'H5,H6'})}).catch(()=>{});
  // #endregion

  try {
    const url = `${CONFIG.SUPABASE_URL}${CONFIG.LIVE_STATUS_ENDPOINT}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn('[Whatnot Pulse] Failed to update live status:', response.status, errorText);
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:385',message:'updateLiveStatus failed',data:{status:response.status,errorText,viewer_count:data.viewer_count},timestamp:Date.now(),sessionId:'debug-session',runId:'run5',hypothesisId:'H6'})}).catch(()=>{});
      // #endregion
      return null;
    }

    const result = await response.json();
    console.log('[Whatnot Pulse] Live status updated:', result);
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:391',message:'updateLiveStatus success',data:{result,viewer_count:data.viewer_count},timestamp:Date.now(),sessionId:'debug-session',runId:'run5',hypothesisId:'H6'})}).catch(()=>{});
    // #endregion
    return result;
  } catch (error) {
    console.error('[Whatnot Pulse] Error updating live status:', error);
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:395',message:'updateLiveStatus error',data:{error:error.message,viewer_count:data.viewer_count},timestamp:Date.now(),sessionId:'debug-session',runId:'run5',hypothesisId:'H5'})}).catch(()=>{});
    // #endregion
    return null;
  }
}

/**
 * Start periodic viewer count updates for a specific stream
 * Note: For multi-stream monitoring, the heartbeat alarm is the primary mechanism.
 * These per-stream intervals are kept for legacy compatibility.
 * @param {string} streamId - Stream ID to start updates for
 */
function startViewerCountUpdates(streamId) {
  if (!streamId) {
    console.warn('[Whatnot Pulse] startViewerCountUpdates called without streamId');
    return;
  }
  
  const streamState = getOrCreateStream(streamId);
  if (!streamState) {
    console.warn('[Whatnot Pulse] Could not create stream state for:', streamId);
    return;
  }
  
  // Clear any existing interval for this stream
  const existingIntervalId = updateIntervalsMap.get(streamId);
  if (existingIntervalId) {
    clearInterval(existingIntervalId);
    updateIntervalsMap.delete(streamId);
  }

  // Set up periodic updates every 30 seconds for this specific stream
  const intervalId = setInterval(async () => {
    const currentStreamState = streamsMap.get(streamId);
    if (!currentStreamState || !currentStreamState.streamer_username) {
      return;
    }

    // Find tab for this specific stream
    try {
      const tabs = await chrome.tabs.query({ url: ['*://*.whatnot.com/live/*'] });
      const streamTab = tabs.find(tab => {
        if (!tab.url) return false;
        const tabStreamId = extractStreamIdFromUrl(tab.url);
        return tabStreamId === streamId;
      });
      
      if (!streamTab) {
        // Tab not found, stop updates for this stream
        stopViewerCountUpdates(streamId);
        return;
      }

      chrome.tabs.sendMessage(streamTab.id, { type: 'GET_VIEWER_COUNT' }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn(`[Whatnot Pulse] Could not get viewer count for stream ${streamId}:`, chrome.runtime.lastError);
          return;
        }

        if (response) {
          const viewerCount = response.viewerCount;
          const pendingItems = response.pendingItems;
          
          const streamState = streamsMap.get(streamId);
          if (!streamState) return;
          
          // Always send viewer count updates (even if same value) to keep dashboard fresh
          if (viewerCount !== undefined && viewerCount !== null) {
            const numViewers = typeof viewerCount === 'number' ? viewerCount : parseInt(viewerCount, 10);
            if (!isNaN(numViewers) && numViewers > 0) {
              const previousValue = streamState.lastViewerCount;
              streamState.lastViewerCount = numViewers;
              
              const updateData = {
                streamer_username: streamState.streamer_username,
                is_live: true,
                title: streamState.title,
                stream_url: streamState.stream_url,
                stream_id: streamId,
                viewer_count: numViewers
              };
              
              if (pendingItems !== undefined && pendingItems !== null) {
                updateData.pending_items = pendingItems;
                streamState.lastPendingItems = pendingItems;
              }
              if (streamState.stream_start_time) {
                updateData.stream_start_time = streamState.stream_start_time;
              }
              
              console.log(`[Whatnot Pulse] Updating viewer count for stream ${streamId}:`, numViewers, '(was:', previousValue, ')');
              updateLiveStatus(updateData);
            }
          }
          
          // Check if only pending items changed
          if (pendingItems !== undefined && pendingItems !== null && pendingItems !== streamState.lastPendingItems) {
            streamState.lastPendingItems = pendingItems;
            const updateData = {
              streamer_username: streamState.streamer_username,
              is_live: true,
              title: streamState.title,
              stream_url: streamState.stream_url,
              stream_id: streamId,
              pending_items: pendingItems
            };
            if (streamState.lastViewerCount !== null) {
              updateData.viewer_count = streamState.lastViewerCount;
            }
            if (streamState.stream_start_time) {
              updateData.stream_start_time = streamState.stream_start_time;
            }
            updateLiveStatus(updateData);
          }
        }
      });
    } catch (error) {
      console.error(`[Whatnot Pulse] Error getting viewer count for stream ${streamId}:`, error);
    }
  }, CONFIG.VIEWER_COUNT_INTERVAL);
  
  updateIntervalsMap.set(streamId, intervalId);
  console.log(`[Whatnot Pulse] Started viewer count updates for stream:`, streamId);
}

/**
 * Stop viewer count updates for a specific stream
 * @param {string} streamId - Stream ID to stop updates for
 */
function stopViewerCountUpdates(streamId) {
  if (streamId) {
    const intervalId = updateIntervalsMap.get(streamId);
    if (intervalId) {
      clearInterval(intervalId);
      updateIntervalsMap.delete(streamId);
      console.log(`[Whatnot Pulse] Stopped viewer count updates for stream:`, streamId);
    }
  } else {
    // Legacy: stop all if no streamId provided
    updateIntervalsMap.forEach((intervalId, sid) => {
      clearInterval(intervalId);
      console.log(`[Whatnot Pulse] Stopped viewer count updates for stream:`, sid);
    });
    updateIntervalsMap.clear();
  }
}

/**
 * Message listener from content script and popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle async responses
  const handleAsync = async () => {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:438',message:'Message handler invoked',data:{type:message.type},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
    // #endregion
    try {
      if (message.type === 'NEW_SALE') {
        console.log('[Whatnot Pulse] Background received NEW_SALE message:', message);
        
        // Extract stream_id from sender tab URL for session isolation
        let senderStreamId = null;
        if (sender && sender.tab && sender.tab.url) {
          senderStreamId = extractStreamIdFromUrl(sender.tab.url);
          if (senderStreamId) {
            console.log('[Whatnot Pulse] Extracted stream_id from sender tab:', senderStreamId);
          }
        }
        
        // Handle single sale or array of sales
        const sales = Array.isArray(message.sales) ? message.sales : [message.sale || message];
        console.log('[Whatnot Pulse] Processing', sales.length, 'sales for stream:', senderStreamId || 'unknown');
        
        let queued = 0;
        let invalid = 0;
        
        for (const sale of sales) {
          // Validate sale structure - now uses streamer_username
          if (!sale.streamer_username || sale.sold_price === undefined) {
            console.warn('[Whatnot Pulse] Invalid sale data:', sale);
            invalid++;
            continue;
          }
          
          // Associate sale with specific stream_id for session isolation
          if (senderStreamId && !sale.stream_id) {
            sale.stream_id = senderStreamId;
          }
          
          console.log('[Whatnot Pulse] Queueing sale:', sale);
          queueSale(sale);
          queued++;
        }
        
        console.log('[Whatnot Pulse] Queued', queued, 'sales,', invalid, 'invalid');
        sendResponse({ success: true, queued, invalid });
      }
      
      else if (message.type === 'STREAM_ID_CHANGED') {
        // Handle stream ID change notification from content script
        console.log('[Whatnot Pulse] Stream ID changed notification:', message.data);
        const changeData = message.data;
        
        // Reset session immediately when stream ID changes
        if (changeData.previous_stream_id && changeData.new_stream_id && 
            changeData.previous_stream_id !== changeData.new_stream_id) {
          console.log('[Whatnot Pulse] Resetting session due to stream ID change (Accuracy First)');
          resetStreamSession();
        }
        
        sendResponse({ success: true });
      }
      
      else if (message.type === 'FULL_HISTORY_DATA') {
        // Handle full history batch extraction
        console.log('[Whatnot Pulse] Received FULL_HISTORY_DATA message:', message.data);
        
        const historyData = message.data;
        
        // Extract stream_id if available
        const streamId = historyData.stream_id || (historyData.stream_url ? extractStreamIdFromUrl(historyData.stream_url) : null);
        
        // Store stream_id in streamsMap if this is a tracked stream
        if (streamId) {
          // Get or create stream state for this stream
          const streamState = getOrCreateStream(streamId);
          if (historyData.stream_url) {
            streamState.stream_url = historyData.stream_url;
          }
          streamsMap.set(streamId, streamState);
        }
        
        // Update stream_start_time if provided (accept historical times)
        if (historyData.stream_start_time && streamId) {
          const streamStart = new Date(historyData.stream_start_time);
          const now = new Date();
          const hoursSinceStart = (now - streamStart) / (1000 * 60 * 60);
          
          // For full history, accept times up to 7 days old
          if (hoursSinceStart >= 0 && hoursSinceStart <= 168) {
            const streamState = streamsMap.get(streamId);
            if (streamState) {
              streamState.stream_start_time = historyData.stream_start_time;
              streamsMap.set(streamId, streamState);
              console.log('[Whatnot Pulse] Set stream_start_time from full history for stream', streamId, ':', historyData.stream_start_time, `(${hoursSinceStart.toFixed(2)}h ago)`);
            }
          }
        }
        
        // Process all sales in batch
        if (historyData.sales && Array.isArray(historyData.sales)) {
          console.log(`[Whatnot Pulse] Processing ${historyData.sales.length} sales from full history`);
          
          let queued = 0;
          let invalid = 0;
          
          for (const sale of historyData.sales) {
            // Validate sale structure
            if (!sale.streamer_username || sale.sold_price === undefined) {
              console.warn('[Whatnot Pulse] Invalid sale data in full history:', sale);
              invalid++;
              continue;
            }
            
            console.log('[Whatnot Pulse] Queueing sale from full history:', sale);
            queueSale(sale);
            queued++;
          }
          
          console.log('[Whatnot Pulse] Queued', queued, 'sales from full history,', invalid, 'invalid');
          sendResponse({ success: true, queued, invalid, total: historyData.sales.length });
        } else {
          console.warn('[Whatnot Pulse] No sales array in FULL_HISTORY_DATA');
          sendResponse({ success: false, error: 'No sales array provided' });
        }
      }
      
      else if (message.type === 'STREAM_DETECTED') {
        console.log('[Whatnot Pulse] Received STREAM_DETECTED message:', message.data);
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:578',message:'STREAM_DETECTED message received',data:{username:message.data?.username,viewerCount:message.data?.viewerCount,title:message.data?.title,streamUrl:message.data?.url},timestamp:Date.now(),sessionId:'debug-session',runId:'run7',hypothesisId:'H5'})}).catch(()=>{});
        // #endregion
        
        // Stream detected on live page
        const streamData = message.data;
        
        // Extract stream_id from URL if available
        const streamId = streamData.url ? extractStreamIdFromUrl(streamData.url) : null;
        
        if (!streamId) {
          console.warn('[Whatnot Pulse] STREAM_DETECTED received but could not extract stream_id from URL:', streamData.url);
          sendResponse({ success: false, error: 'Could not extract stream_id from URL' });
          return;
        }
        
        // Clean Slate Architecture: Reset session for THIS specific stream only
        // This ensures no "Ghost State" persists for this stream, but other streams continue
        resetStreamSession(streamId);
        
        // Get or create stream state in map
        const streamState = getOrCreateStream(streamId);
        
        // Update stream state with new data
        streamState.streamer_username = streamData.username;
        streamState.title = streamData.title || null;
        streamState.stream_url = streamData.url || null;
        streamState.stream_id = streamId;
        streamState.lastViewerCount = streamData.viewerCount || null;
        streamState.lastPendingItems = streamData.pendingItems !== undefined ? streamData.pendingItems : null;
        
        // Check if this is a historical pull (indicated by historical_mode flag or stream_start_time > 12h)
        const isHistoricalPull = streamData.historical_mode === true;
        
        // Set stream_start_time if provided and valid
        // For historical pulls, accept times up to 7 days old
        // For live monitoring, accept times within last 12 hours
        if (streamData.stream_start_time) {
          const streamStart = new Date(streamData.stream_start_time);
          const now = new Date();
          const hoursSinceStart = (now - streamStart) / (1000 * 60 * 60);
          const maxHoursAgo = isHistoricalPull ? 168 : 12; // 7 days vs 12 hours
          
          // Validate: must be within time window
          if (hoursSinceStart >= 0 && hoursSinceStart <= maxHoursAgo) {
            streamState.stream_start_time = streamData.stream_start_time;
            console.log('[Whatnot Pulse] Set stream_start_time for stream', streamId, ':', streamData.stream_start_time, `(${hoursSinceStart.toFixed(2)}h ago, historical: ${isHistoricalPull})`);
          } else {
            console.warn('[Whatnot Pulse] Rejected stream_start_time for stream', streamId, '- outside validation window:', hoursSinceStart.toFixed(2), 'hours (max:', maxHoursAgo, 'h)');
            streamState.stream_start_time = null;
          }
        } else {
          // If no start time provided, keep as null
          streamState.stream_start_time = null;
        }

        // Store stream state in map
        streamsMap.set(streamId, streamState);
        console.log('[Whatnot Pulse] Updated stream state in map for:', streamId, streamState);

        // Add streamer to watched list if not already there
        const watchedResult = await chrome.storage.local.get(['watched_streamers']);
        const watchedStreamers = watchedResult.watched_streamers || [];
        if (!watchedStreamers.includes(streamData.username)) {
          watchedStreamers.push(streamData.username);
          await chrome.storage.local.set({ watched_streamers: watchedStreamers });
          console.log('[Whatnot Pulse] Added', streamData.username, 'to watched streamers list');
        }

        // Store current stream info (legacy storage - for backward compatibility)
        await chrome.storage.local.set({ 
          current_streamer_username: streamData.username,
          current_stream_title: streamData.title,
          current_stream_url: streamData.url
        });
        console.log('[Whatnot Pulse] Stored stream info in chrome.storage for stream:', streamId);
        
        // Report stream is live with active status
        const updateData = {
          streamer_username: streamData.username,
          is_live: true,
          title: streamData.title,
          stream_url: streamData.url,
          stream_id: streamId // Include stream_id for multi-stream support
        };
        if (streamData.viewerCount !== undefined && streamData.viewerCount !== null) {
          // Ensure viewer_count is a number
          const numViewers = typeof streamData.viewerCount === 'number' ? streamData.viewerCount : parseInt(streamData.viewerCount, 10);
          if (!isNaN(numViewers)) {
            updateData.viewer_count = numViewers;
          }
        }
        if (streamData.pendingItems !== undefined && streamData.pendingItems !== null) {
          updateData.pending_items = streamData.pendingItems;
        }
        if (streamState.stream_start_time) {
          updateData.stream_start_time = streamState.stream_start_time;
        }
        
        console.log('[Whatnot Pulse] Calling updateLiveStatus for stream', streamId, 'with:', updateData);
        
        const updateResult = await updateLiveStatus(updateData);
        
        console.log('[Whatnot Pulse] updateLiveStatus result for stream', streamId, ':', updateResult);
        
        // Start periodic viewer count updates for THIS specific stream
        startViewerCountUpdates(streamId);
        console.log('[Whatnot Pulse] Started viewer count updates for stream:', streamId);
        
        // Automatically trigger full history extraction 5 seconds after stream detection
        // This ensures we capture all sales even if joining mid-stream
        setTimeout(async () => {
          try {
            // Find the tab for this specific stream
            const tabs = await chrome.tabs.query({ url: ['*://*.whatnot.com/live/*', '*://www.whatnot.com/live/*'] });
            const streamTab = tabs.find(t => {
              if (!t.url) return false;
              const tabStreamId = extractStreamIdFromUrl(t.url);
              return tabStreamId === streamId;
            });
            
            if (streamTab && streamTab.id) {
              console.log('[Whatnot Pulse] Automatically triggering full history extraction for stream', streamId, 'tab:', streamTab.id);
              try {
                // Try to send message to content script (if already loaded)
                await chrome.tabs.sendMessage(streamTab.id, { type: 'EXTRACT_FULL_HISTORY' });
                console.log('[Whatnot Pulse] Sent EXTRACT_FULL_HISTORY message to tab', streamTab.id);
              } catch (msgError) {
                // Content script not loaded yet, inject it
                console.log('[Whatnot Pulse] Content script not loaded, injecting for full history extraction...');
                try {
                  await chrome.scripting.executeScript({
                    target: { tabId: streamTab.id },
                    files: ['content.js']
                  });
                  // Wait for script to initialize
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  // Now send message
                  await chrome.tabs.sendMessage(streamTab.id, { type: 'EXTRACT_FULL_HISTORY' });
                  console.log('[Whatnot Pulse] Sent EXTRACT_FULL_HISTORY message after injection');
                } catch (injectError) {
                  console.warn('[Whatnot Pulse] Error injecting script for automatic full history extraction:', injectError);
                }
              }
            } else {
              console.warn('[Whatnot Pulse] No tab found for stream', streamId, 'for automatic full history extraction');
            }
          } catch (error) {
            console.error('[Whatnot Pulse] Error triggering automatic full history extraction for stream', streamId, ':', error);
          }
        }, 5000); // 5 second delay
        
        sendResponse({ success: true });
      }

      else if (message.type === 'VIEWER_COUNT_UPDATE') {
        // Viewer count and pending items updated from content script
        // Extract stream_id from sender tab for multi-stream support
        let senderStreamId = null;
        if (sender && sender.tab && sender.tab.url) {
          senderStreamId = extractStreamIdFromUrl(sender.tab.url);
        }
        
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:656',message:'VIEWER_COUNT_UPDATE message received',data:{viewerCount:message.viewerCount,streamId:senderStreamId},timestamp:Date.now(),sessionId:'debug-session',runId:'run7',hypothesisId:'H2,H5'})}).catch(()=>{});
        // #endregion
        
        if (!senderStreamId) {
          console.warn('[Whatnot Pulse] VIEWER_COUNT_UPDATE received but could not extract stream_id from sender tab');
          sendResponse({ success: true });
          return;
        }
        
        // Get stream state from map
        const streamState = streamsMap.get(senderStreamId);
        if (!streamState || !streamState.streamer_username) {
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:662',message:'VIEWER_COUNT_UPDATE skipped - stream not in map',data:{viewerCount:message.viewerCount,streamId:senderStreamId},timestamp:Date.now(),sessionId:'debug-session',runId:'run7',hypothesisId:'H5'})}).catch(()=>{});
          // #endregion
          console.warn('[Whatnot Pulse] VIEWER_COUNT_UPDATE received for stream', senderStreamId, 'but stream not in map - waiting for STREAM_DETECTED');
          sendResponse({ success: true });
          return;
        }
        
        const viewerChanged = message.viewerCount !== undefined && message.viewerCount !== streamState.lastViewerCount;
        const pendingChanged = message.pendingItems !== undefined && message.pendingItems !== streamState.lastPendingItems;
        
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:616',message:'VIEWER_COUNT_UPDATE change check',data:{viewerChanged,pendingChanged,newViewerCount:message.viewerCount,oldViewerCount:streamState.lastViewerCount,streamId:senderStreamId},timestamp:Date.now(),sessionId:'debug-session',runId:'run5',hypothesisId:'H2'})}).catch(()=>{});
        // #endregion
        
        // Always send updates (even if same value) to keep dashboard fresh
        // Update stored values
        if (message.viewerCount !== undefined) streamState.lastViewerCount = message.viewerCount;
        if (message.pendingItems !== undefined) streamState.lastPendingItems = message.pendingItems;
        if (message.stream_start_time !== undefined) streamState.stream_start_time = message.stream_start_time;
        streamsMap.set(senderStreamId, streamState);
        
        const updateData = {
          streamer_username: streamState.streamer_username,
          stream_id: senderStreamId,
          is_live: true,
          title: streamState.title,
          stream_url: streamState.stream_url
        };
        
        // Ensure viewer_count is a number
        if (message.viewerCount !== undefined && message.viewerCount !== null) {
          const numViewers = typeof message.viewerCount === 'number' ? message.viewerCount : parseInt(message.viewerCount, 10);
          if (!isNaN(numViewers)) {
            // Allow 0 viewers (stream might be just starting)
            updateData.viewer_count = numViewers;
          }
        }
        if (message.pendingItems !== undefined && message.pendingItems !== null) {
          updateData.pending_items = message.pendingItems;
        }
        if (streamState.stream_start_time) {
          updateData.stream_start_time = streamState.stream_start_time;
        }
        
        // Only send if we have viewer_count
        if (updateData.viewer_count !== undefined) {
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:680',message:'VIEWER_COUNT_UPDATE calling updateLiveStatus',data:{updateData,streamId:senderStreamId},timestamp:Date.now(),sessionId:'debug-session',runId:'run7',hypothesisId:'H5'})}).catch(()=>{});
          // #endregion
          
          await updateLiveStatus(updateData);
        } else {
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:688',message:'VIEWER_COUNT_UPDATE skipped - no viewer count',data:{viewerCount:message.viewerCount,viewerCountType:typeof message.viewerCount,streamId:senderStreamId},timestamp:Date.now(),sessionId:'debug-session',runId:'run7',hypothesisId:'H5'})}).catch(()=>{});
          // #endregion
        }
        
        sendResponse({ success: true });
      }

      else if (message.type === 'PROFILE_DATA') {
        // Profile data scraped from profile page
        console.log('[Whatnot Pulse] Received profile data:', message.data);
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:730',message:'PROFILE_DATA message received',data:{username:message.data?.username,followers:message.data?.followers,category:message.data?.category,hasAvatar:!!(message.data?.avatar_url || message.data?.avatarUrl)},timestamp:Date.now(),sessionId:'debug-session',runId:'run9',hypothesisId:'H2'})}).catch(()=>{});
        // #endregion
        
        // Send profile data to backend
        if (message.data && message.data.username) {
          try {
            const profileUrl = `${CONFIG.SUPABASE_URL}${CONFIG.PROFILE_ENDPOINT}`;
            const payload = {
              username: message.data.username,
              followers: message.data.followers || null,
              category: message.data.category || null,
              avatarUrl: message.data.avatar_url || message.data.avatarUrl || null
            };
            
            // Remove null fields
            Object.keys(payload).forEach(key => {
              if (payload[key] === null || payload[key] === undefined) {
                delete payload[key];
              }
            });
            
            console.log('[Whatnot Pulse] Sending profile data:', payload);
            // #region agent log
            fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:752',message:'About to send profile data to backend',data:{payload,hasApiKey:!!apiKey,hasUrl:!!CONFIG.SUPABASE_URL},timestamp:Date.now(),sessionId:'debug-session',runId:'run9',hypothesisId:'H2'})}).catch(()=>{});
            // #endregion
            
            const response = await fetch(profileUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey
              },
              body: JSON.stringify(payload)
            });
            
            if (response.ok) {
              const result = await response.json();
              console.log('[Whatnot Pulse] Profile data updated successfully:', result);
              // #region agent log
              fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:768',message:'Profile data updated successfully',data:{result,username:payload.username,followers:payload.followers},timestamp:Date.now(),sessionId:'debug-session',runId:'run9',hypothesisId:'H2'})}).catch(()=>{});
              // #endregion
            } else {
              const errorText = await response.text();
              console.warn('[Whatnot Pulse] Failed to update profile data:', response.status, errorText);
              // #region agent log
              fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:773',message:'Profile data update failed',data:{status:response.status,errorText,username:payload.username},timestamp:Date.now(),sessionId:'debug-session',runId:'run9',hypothesisId:'H2'})}).catch(()=>{});
              // #endregion
            }
          } catch (error) {
            console.error('[Whatnot Pulse] Error updating profile data:', error);
            // #region agent log
            fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:780',message:'Profile data update error',data:{error:error.message,username:message.data?.username},timestamp:Date.now(),sessionId:'debug-session',runId:'run9',hypothesisId:'H2'})}).catch(()=>{});
            // #endregion
          }
        }
        
        sendResponse({ success: true });
      }
      
      else if (message.type === 'SCHEDULED_LIVES') {
        // Scheduled lives detected from profile page
        console.log('[Whatnot Pulse] Received scheduled lives:', message.data);
        
        if (Array.isArray(message.data) && message.data.length > 0) {
          // Extract username from sender tab URL
          const senderUrl = sender?.tab?.url || '';
          const match = senderUrl.match(/\/user\/([^\/\?]+)/);
          const username = match ? match[1].toLowerCase() : null;
          
          if (username) {
            // Transform data to match API format
            const scheduledLives = message.data.map(live => ({
              streamId: live.stream_id,
              scheduledAt: live.scheduled_time || new Date().toISOString(),
              title: live.title || null,
              streamUrl: live.stream_url
            })).filter(live => live.streamId && live.streamUrl); // Only include valid entries
            
            // Send to backend API
            try {
              const scheduledLivesUrl = `${CONFIG.SUPABASE_URL}${CONFIG.SCHEDULED_LIVES_ENDPOINT}`;
              const payload = {
                username: username,
                scheduledLives: scheduledLives
              };
              
              console.log('[Whatnot Pulse] Sending scheduled lives to backend:', payload);
              const response = await fetch(scheduledLivesUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-api-key': apiKey
                },
                body: JSON.stringify(payload)
              });
              
              if (response.ok) {
                console.log('[Whatnot Pulse] Scheduled lives updated successfully');
              } else {
                const errorText = await response.text();
                console.warn('[Whatnot Pulse] Failed to update scheduled lives:', response.status, errorText);
              }
            } catch (error) {
              console.error('[Whatnot Pulse] Error updating scheduled lives:', error);
            }
            
            // Store scheduled lives locally for automatic monitoring
            const result = await chrome.storage.local.get(['scheduled_lives']);
            const existing = result.scheduled_lives || {};
            
            existing[username] = {
              lives: message.data, // Store original format for internal use
              last_updated: new Date().toISOString()
            };
            
            await chrome.storage.local.set({ scheduled_lives: existing });
            console.log('[Whatnot Pulse] Stored scheduled lives for:', username);
            
            // Trigger automatic monitoring setup
            setupAutomaticMonitoring(username, message.data);
          }
        }
        
        sendResponse({ success: true });
      }
      
      else if (message.type === 'STREAM_LEFT') {
        // User left the live stream page - extract stream_id from sender tab
        let senderStreamId = null;
        if (sender && sender.tab && sender.tab.url) {
          senderStreamId = extractStreamIdFromUrl(sender.tab.url);
        }
        
        if (senderStreamId) {
          const streamState = streamsMap.get(senderStreamId);
          if (streamState && streamState.streamer_username) {
            console.log('[Whatnot Pulse] Stream', senderStreamId, 'left, marking as offline');
            const updateData = {
              streamer_username: streamState.streamer_username,
              stream_id: senderStreamId,
              is_live: false
            };
            // Include stream_start_time if available so backend can calculate duration correctly
            if (streamState.stream_start_time) {
              updateData.stream_start_time = streamState.stream_start_time;
            }
            await updateLiveStatus(updateData);
            
            // Clear update interval for this stream only
            stopViewerCountUpdates(senderStreamId);
            
            // Reset session for this stream only (other streams continue)
            resetStreamSession(senderStreamId);
          } else {
            console.warn('[Whatnot Pulse] STREAM_LEFT received for stream', senderStreamId, 'but stream not in map');
          }
        } else {
          console.warn('[Whatnot Pulse] STREAM_LEFT received but could not extract stream_id from sender tab');
        }
        sendResponse({ success: true });
      }
      
      else if (message.type === 'SET_API_KEY') {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:704',message:'SET_API_KEY message received',data:{hasUrl:!!message.supabase_url,url:message.supabase_url?.substring(0,50),hasKey:!!message.api_key},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B,C'})}).catch(()=>{});
        // #endregion
        
        apiKey = message.api_key;
        const providedUrl = message.supabase_url || CONFIG.SUPABASE_URL;
        CONFIG.SUPABASE_URL = providedUrl;
        
        // Always save URL and API key to storage first
        await chrome.storage.local.set({
          api_key: apiKey,
          supabase_url: CONFIG.SUPABASE_URL
        });
        
        console.log('[Whatnot Pulse] Saved API key and URL to storage');
        
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:718',message:'About to validate API key in SET_API_KEY handler',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A,C'})}).catch(()=>{});
        // #endregion
        
        // Validate API key
        try {
          organizationId = await validateApiKey(apiKey);
          
          // Update connection status
          connectionStatus.connected = true;
          connectionStatus.lastCheck = Date.now();
          connectionStatus.error = null;
          
          await chrome.storage.local.set({
            connection_status: 'connected',
            connection_checked_at: Date.now()
          });
          
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:733',message:'SET_API_KEY success, sending response',data:{hasOrgId:!!organizationId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          
          sendResponse({ 
            success: true, 
            organization_id: organizationId,
            connected: true
          });
        } catch (error) {
          console.error('[Whatnot Pulse] API key validation failed:', error);
          
          // Update connection status
          connectionStatus.connected = false;
          connectionStatus.lastCheck = Date.now();
          connectionStatus.error = error.message;
          
          await chrome.storage.local.set({
            connection_status: 'disconnected',
            connection_checked_at: Date.now()
          });
          
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:750',message:'SET_API_KEY error, sending error response',data:{error:error.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          
          sendResponse({ 
            success: false, 
            error: error.message,
            connected: false
          });
        }
      }
      
      else if (message.type === 'EXTRACT_FULL_HISTORY') {
        // Trigger full history extraction for current live stream tab
        console.log('[Whatnot Pulse] Received EXTRACT_FULL_HISTORY request');
        
        try {
          // Find live stream tabs
          const tabs = await chrome.tabs.query({ url: ['*://*.whatnot.com/live/*', '*://www.whatnot.com/live/*'] });
          const liveTabs = tabs.filter(tab => tab.url && tab.url.includes('/live/'));
          
          if (liveTabs.length === 0) {
            console.warn('[Whatnot Pulse] No live stream tabs found for full history extraction');
            sendResponse({ success: false, error: 'No live stream tabs found' });
            return;
          }
          
          // Use the first live stream tab
          const tab = liveTabs[0];
          console.log('[Whatnot Pulse] Extracting full history from tab:', tab.id, tab.url);
          
          // Try to send message to content script first (if already loaded)
          try {
            await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_FULL_HISTORY' });
            console.log('[Whatnot Pulse] Sent EXTRACT_FULL_HISTORY message to tab', tab.id);
          } catch (msgError) {
            // Content script not loaded yet, inject it via executeScript
            console.log('[Whatnot Pulse] Content script not loaded, injecting...');
            try {
              // Inject content.js file
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
              });
              // Wait a bit for script to initialize
              await new Promise(resolve => setTimeout(resolve, 2000));
              // Now send message
              await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_FULL_HISTORY' });
              console.log('[Whatnot Pulse] Sent EXTRACT_FULL_HISTORY message after injection');
            } catch (injectError) {
              console.error('[Whatnot Pulse] Error injecting script for full history:', injectError);
              sendResponse({ success: false, error: injectError.message });
              return;
            }
          }
          
          // Response will be sent asynchronously via FULL_HISTORY_DATA message
          sendResponse({ success: true, message: 'Full history extraction initiated' });
        } catch (error) {
          console.error('[Whatnot Pulse] Error initiating full history extraction:', error);
          sendResponse({ success: false, error: error.message });
        }
      }
      
      else if (message.type === 'GET_STATUS') {
        await loadConfig();
        const streamInfo = await chrome.storage.local.get([
          'current_streamer_username',
          'current_stream_title',
          'current_stream_url'
        ]);
        
        sendResponse({
          connected: connectionStatus.connected,
          hasApiKey: !!apiKey,
          hasOrganizationId: !!organizationId,
          queueLength: requestQueue.length,
          lastCheck: connectionStatus.lastCheck,
          error: connectionStatus.error,
          supabaseUrl: CONFIG.SUPABASE_URL,
          currentStream: {
            username: streamInfo.current_streamer_username || null,
            title: streamInfo.current_stream_title || null,
            url: streamInfo.current_stream_url || null
          }
        });
      }
      
      else if (message.type === 'VALIDATE_API_KEY') {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:781',message:'VALIDATE_API_KEY message received',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B,C'})}).catch(()=>{});
        // #endregion
        
        await loadConfig();
        
        if (!apiKey) {
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:787',message:'No API key in VALIDATE_API_KEY',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
          // #endregion
          sendResponse({ 
            success: false, 
            error: 'No API key configured' 
          });
          return;
        }
        
        try {
          organizationId = await validateApiKey(apiKey);
          
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:796',message:'VALIDATE_API_KEY success, sending response',data:{hasOrgId:!!organizationId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          
          sendResponse({ 
            success: true, 
            organization_id: organizationId,
            connected: true
          });
        } catch (error) {
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:804',message:'VALIDATE_API_KEY error, sending error response',data:{error:error.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          sendResponse({ 
            success: false, 
            error: error.message,
            connected: false
          });
        }
      }
      
      else if (message.type === 'GET_STATS') {
        await loadConfig();
        sendResponse({
          queueLength: requestQueue.length,
          isProcessing: isProcessingQueue,
          connected: connectionStatus.connected,
          lastCheck: connectionStatus.lastCheck,
          error: connectionStatus.error
        });
      }
      
      else {
        sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (error) {
      console.error('[Whatnot Pulse] Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  };

  handleAsync();
  return true; // Keep channel open for async response
});


// Initialize on service worker startup
// Use non-async listeners to prevent Status Code 15 errors
chrome.runtime.onStartup.addListener(() => {
  // Use setTimeout to defer async operations, preventing service worker crash
  setTimeout(() => {
    loadConfig().catch(err => {
      console.warn('[Whatnot Pulse] Error loading config on startup:', err);
    }).then(() => {
      // Load current stream state on startup (legacy support)
      // Note: In multi-stream mode, streams are re-initialized via STREAM_DETECTED messages
      // This legacy code is kept for backward compatibility but may not be reliable for multi-stream
      chrome.storage.local.get(['current_streamer_username', 'current_stream_title', 'current_stream_url']).then(result => {
        if (result.current_stream_url) {
          const streamId = extractStreamIdFromUrl(result.current_stream_url);
          if (streamId) {
            const streamState = getOrCreateStream(streamId);
            streamState.streamer_username = result.current_streamer_username || null;
            streamState.title = result.current_stream_title || null;
            streamState.stream_url = result.current_stream_url || null;
            streamsMap.set(streamId, streamState);
            console.log('[Whatnot Pulse] Restored stream state on startup for:', streamId);
          }
        }
        // Note: We don't automatically restart viewer count updates on service worker restart
        // They will restart when content script sends STREAM_DETECTED message
      }).catch(err => {
        console.warn('[Whatnot Pulse] Error loading stream state on startup:', err);
      });
    });
  }, 0);
});

chrome.runtime.onInstalled.addListener(() => {
  // Use setTimeout to defer async operations, preventing service worker crash
  setTimeout(() => {
    loadConfig().catch(err => {
      console.warn('[Whatnot Pulse] Error loading config on install:', err);
    }).then(() => {
      // Load current stream state on startup (legacy support)
      // Note: In multi-stream mode, streams are re-initialized via STREAM_DETECTED messages
      // This legacy code is kept for backward compatibility but may not be reliable for multi-stream
      chrome.storage.local.get(['current_streamer_username', 'current_stream_title', 'current_stream_url']).then(result => {
        if (result.current_stream_url) {
          const streamId = extractStreamIdFromUrl(result.current_stream_url);
          if (streamId) {
            const streamState = getOrCreateStream(streamId);
            streamState.streamer_username = result.current_streamer_username || null;
            streamState.title = result.current_stream_title || null;
            streamState.stream_url = result.current_stream_url || null;
            streamsMap.set(streamId, streamState);
            console.log('[Whatnot Pulse] Restored stream state on install for:', streamId);
          }
        }
        // Note: We don't automatically restart viewer count updates on service worker restart
        // They will restart when content script sends STREAM_DETECTED message
      }).catch(err => {
        console.warn('[Whatnot Pulse] Error loading stream state on install:', err);
      });
    });
  }, 0);
});

/**
 * Setup automatic monitoring for scheduled lives
 */
async function setupAutomaticMonitoring(username, scheduledLives) {
  console.log('[Whatnot Pulse] Setting up automatic monitoring for', scheduledLives.length, 'scheduled lives');
  
  for (const live of scheduledLives) {
    if (!live.scheduled_time || !live.stream_url) continue;
    
    try {
      const scheduledDate = new Date(live.scheduled_time);
      const now = new Date();
      const timeUntilLive = scheduledDate - now;
      
      // Only monitor if scheduled time is in the future
      if (timeUntilLive > 0) {
        // Schedule tab opening 1 minute before the live starts
        const openTime = scheduledDate - 60000; // 1 minute before
        const delay = openTime - now;
        
        if (delay > 0 && delay < 86400000) { // Within 24 hours
          console.log('[Whatnot Pulse] Scheduling automatic monitoring for:', live.stream_url, 'at', scheduledDate);
          
          // Use chrome.alarms to schedule tab opening
          if (chrome.alarms && chrome.alarms.create) {
            const alarmName = `monitor_${username}_${live.stream_id}`;
            chrome.alarms.create(alarmName, {
              when: openTime.getTime()
            });
            console.log('[Whatnot Pulse] Created alarm:', alarmName, 'for', new Date(openTime));
          }
        }
      }
    } catch (error) {
      console.error('[Whatnot Pulse] Error scheduling live:', error, live);
    }
  }
}

/**
 * Periodically refresh profile data for watched streamers
 */
async function refreshProfileData() {
  const result = await chrome.storage.local.get(['watched_streamers']);
  const watchedStreamers = result.watched_streamers || [];
  
  console.log('[Whatnot Pulse] Refreshing profile data for', watchedStreamers.length, 'watched streamers');
  
  for (const username of watchedStreamers) {
    try {
      const profileUrl = `https://www.whatnot.com/user/${username}`;
      
      // Try to find existing tab with this profile page
      const tabs = await chrome.tabs.query({ url: `*://*.whatnot.com/user/${username}*` });
      let tab = tabs.find(t => t.url && t.url.includes(`/user/${username}`));
      let tabCreated = false;
      
      if (!tab) {
        // No existing tab, create one in background
        tab = await chrome.tabs.create({
          url: profileUrl,
          active: false
        });
        tabCreated = true;
        // Wait for page to load (content script should auto-inject)
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
      // Try to send message to content script first (if already loaded)
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PROFILE_DATA' });
        console.log('[Whatnot Pulse] Sent EXTRACT_PROFILE_DATA message to tab', tab.id);
      } catch (msgError) {
        // Content script not loaded yet, inject it via executeScript
        console.log('[Whatnot Pulse] Content script not loaded, injecting...');
        try {
          // Inject content.js file
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });
          // Wait a bit for script to initialize
          await new Promise(resolve => setTimeout(resolve, 1000));
          // Now send message
          await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PROFILE_DATA' });
        } catch (injectError) {
          console.error('[Whatnot Pulse] Error injecting script:', injectError);
        }
      }
      
      // Close tab if we created it (after a delay to allow scraping)
      if (tabCreated) {
        setTimeout(() => {
          chrome.tabs.remove(tab.id).catch(() => {
            // Tab might already be closed
          });
        }, 5000);
      }
    } catch (error) {
      console.error('[Whatnot Pulse] Error refreshing profile data for', username, ':', error);
    }
  }
}

/**
 * Periodically check for new scheduled lives on watched profiles
 */
async function checkScheduledLives() {
  const result = await chrome.storage.local.get(['watched_streamers', 'scheduled_lives']);
  const watchedStreamers = result.watched_streamers || [];
  const existingScheduled = result.scheduled_lives || {};
  
  console.log('[Whatnot Pulse] Checking scheduled lives for', watchedStreamers.length, 'watched streamers');
  
  for (const username of watchedStreamers) {
    try {
      // Check if we already have recent data (within last 30 minutes - changed from 1 hour)
      const lastUpdate = existingScheduled[username]?.last_updated;
      if (lastUpdate) {
        const lastUpdateDate = new Date(lastUpdate);
        const minutesSinceUpdate = (Date.now() - lastUpdateDate.getTime()) / (1000 * 60);
        if (minutesSinceUpdate < 30) {
          console.log('[Whatnot Pulse] Skipping', username, '- scheduled lives data is recent');
          continue;
        }
      }
      
      const profileUrl = `https://www.whatnot.com/user/${username}`;
      
      // Try to find existing tab with this profile page
      const tabs = await chrome.tabs.query({ url: `*://*.whatnot.com/user/${username}*` });
      let tab = tabs.find(t => t.url && t.url.includes(`/user/${username}`));
      let tabCreated = false;
      
      if (!tab) {
        // No existing tab, create one in background
        tab = await chrome.tabs.create({
          url: profileUrl,
          active: false
        });
        tabCreated = true;
        // Wait for page to load
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
      // Try to send message to content script first (if already loaded)
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_SCHEDULED_LIVES' });
        console.log('[Whatnot Pulse] Sent EXTRACT_SCHEDULED_LIVES message to tab', tab.id);
      } catch (msgError) {
        // Content script not loaded yet, inject it via executeScript
        console.log('[Whatnot Pulse] Content script not loaded, injecting...');
        try {
          // Inject content.js file
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });
          // Wait a bit for script to initialize
          await new Promise(resolve => setTimeout(resolve, 1000));
          // Now send message
          await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_SCHEDULED_LIVES' });
        } catch (injectError) {
          console.error('[Whatnot Pulse] Error injecting script:', injectError);
        }
      }
      
      // Close tab if we created it (after a delay to allow scraping)
      if (tabCreated) {
        setTimeout(() => {
          chrome.tabs.remove(tab.id).catch(() => {
            // Tab might already be closed
          });
        }, 5000);
      }
    } catch (error) {
      console.error('[Whatnot Pulse] Error checking scheduled lives for', username, ':', error);
    }
  }
}

/**
 * Check if watched streamers are currently live
 * Opens live streams automatically if detected
 */
async function checkLiveStreams() {
  // Auto-opening live streams via background automation caused too many tabs.
  // For now, this function is disabled and only logs that it was invoked.
  console.log('[Whatnot Pulse] checkLiveStreams called - auto-opening streams is currently disabled');
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'background.js:1226',message:'checkLiveStreams disabled',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run7',hypothesisId:'AUTO_TABS'})}).catch(()=>{});
  // #endregion
}

// Session Manager: Monitor tab updates to detect stream changes (Multi-Stream Support)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Reset immediately if URL changed (before page finishes loading)
  // This prevents "Ghost State" - lingering data from old tabs
  // PRIMARY KEY: Use livestream ID from URL as the unique identifier
  if (changeInfo.url) {
    const newUrl = changeInfo.url;
    const isLiveStream = newUrl.includes('/live/');
    
    if (isLiveStream) {
      // Extract stream ID from new URL
      const newStreamId = extractStreamIdFromUrl(newUrl);
      
      if (newStreamId) {
        // Find existing stream for this tab (look up by matching URL)
        // Note: We need to check all streams since we don't have tab-to-stream mapping
        let existingStreamId = null;
        let existingStreamState = null;
        
        for (const [streamId, streamState] of streamsMap.entries()) {
          // Check if any tab matches this URL (we can't directly map tab to stream without checking URL)
          // For now, if stream_id changed, we know it's a different stream
          if (streamState.stream_url === newUrl) {
            existingStreamId = streamId;
            existingStreamState = streamState;
            break;
          }
        }
        
        // If stream ID changed or URL changed, reset this specific stream
        if (existingStreamId && existingStreamId !== newStreamId) {
          console.log('[Whatnot Pulse] Livestream ID changed for tab', tabId, '- resetting old stream:', existingStreamId);
          console.log('[Whatnot Pulse] Previous stream ID:', existingStreamId, 'New stream ID:', newStreamId);
          resetStreamSession(existingStreamId); // Reset old stream
        } else if (existingStreamId && existingStreamState && existingStreamState.stream_url !== newUrl) {
          console.log('[Whatnot Pulse] URL changed for stream', existingStreamId, '- resetting session');
          console.log('[Whatnot Pulse] Previous:', existingStreamState.stream_url, 'New:', newUrl);
          resetStreamSession(existingStreamId); // Reset this specific stream
        }
        // If newStreamId is new (not in map), let STREAM_DETECTED handler create it
      }
    } else {
      // If navigating away from live stream, find and reset the stream for this tab
      // Check all streams to find which one was in this tab
      const oldUrl = tab.url;
      if (oldUrl && oldUrl.includes('/live/')) {
        const oldStreamId = extractStreamIdFromUrl(oldUrl);
        if (oldStreamId && streamsMap.has(oldStreamId)) {
          console.log('[Whatnot Pulse] Navigated away from live stream', oldStreamId, 'in tab', tabId, '- resetting session');
          resetStreamSession(oldStreamId); // Reset only this stream
          return;
        }
      }
    }
  }
  
  // Also check when page completes loading for additional validation
  if (changeInfo.status === 'complete' && tab.url) {
    const url = tab.url;
    const isLiveStream = url.includes('/live/');
    
    if (!isLiveStream) {
      // Check if we were tracking a stream in this tab
      const oldStreamId = changeInfo.url ? extractStreamIdFromUrl(changeInfo.url) : null;
      if (oldStreamId && streamsMap.has(oldStreamId)) {
        console.log('[Whatnot Pulse] Tab', tabId, 'finished loading - not a live stream, ensuring stream', oldStreamId, 'is reset');
        resetStreamSession(oldStreamId); // Reset only this stream
        return;
      }
    }
    
    // If navigating to a live stream, check if it's a different stream
    if (isLiveStream) {
      const newStreamId = extractStreamIdFromUrl(url);
      if (!newStreamId) return;
      
      // Find if we have a stream state for this stream
      const streamState = streamsMap.get(newStreamId);
      if (streamState) {
        const streamerInUrl = extractStreamerFromUrl(url);
        const currentStreamer = streamState.streamer_username;
        const currentUrl = streamState.stream_url;
        
        // If URL changed to a different stream URL (same stream_id), no reset needed
        // If streamer changed, that's also handled by stream_id change
        // Stream ID is the primary key - if it matches, it's the same stream
      }
      // If stream not in map, STREAM_DETECTED handler will create it
    }
  }
});

// Set up periodic heartbeat (every 30 seconds) to keep connection alive
if (chrome.alarms && chrome.alarms.create) {
  chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 });
  // Check for scheduled lives every 30 minutes (changed from 6 hours)
  chrome.alarms.create('checkScheduledLives', { periodInMinutes: 30 });
  // Refresh profile data every 1 hour for watched streamers
  // Refresh profile data more frequently (every 30 minutes) to keep follower counts updated
  chrome.alarms.create('refreshProfileData', { periodInMinutes: 30 });
  // Check for live streams every 5 minutes
  chrome.alarms.create('checkLiveStreams', { periodInMinutes: 5 });
} else {
  console.warn('[Whatnot Pulse] chrome.alarms API not available - heartbeat will not work');
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkScheduledLives') {
    // Periodically check for new scheduled lives
    await checkScheduledLives();
  }
  else if (alarm.name === 'refreshProfileData') {
    // Periodically refresh profile data for watched streamers
    await refreshProfileData();
  }
  else if (alarm.name === 'checkLiveStreams') {
    // Periodically check if watched streamers are live
    await checkLiveStreams();
  }
  else if (alarm.name.startsWith('monitor_')) {
    // Extract stream info from alarm name
    const parts = alarm.name.replace('monitor_', '').split('_');
    const username = parts[0];
    const streamId = parts.slice(1).join('_');
    
    // Get scheduled lives for this user
    const result = await chrome.storage.local.get(['scheduled_lives']);
    const scheduledLives = result.scheduled_lives?.[username]?.lives || [];
    const live = scheduledLives.find(l => l.stream_id === streamId);
    
    if (live && live.stream_url) {
      console.log('[Whatnot Pulse] Opening scheduled live stream:', live.stream_url);
      
      // Open the live stream in a new tab
      chrome.tabs.create({
        url: live.stream_url,
        active: false // Open in background
      });
    }
  }
  else if (alarm.name === 'heartbeat') {
    // Multi-stream heartbeat: Process ALL open live stream tabs independently
    try {
      // Query ALL live stream tabs
      const tabs = await chrome.tabs.query({ url: ['*://*.whatnot.com/live/*', '*://www.whatnot.com/live/*'] });
      const liveTabs = tabs.filter(tab => tab.url && tab.url.includes('/live/'));
      
      if (liveTabs.length === 0) {
        // No live tabs open - mark all tracked streams as ended
        for (const [streamId, streamState] of streamsMap.entries()) {
          if (streamState.streamer_username) {
            console.log('[Whatnot Pulse] Heartbeat: No live tabs, marking stream', streamId, 'as ended');
            const updateData = {
              streamer_username: streamState.streamer_username,
              stream_id: streamId,
              is_live: false
            };
            if (streamState.stream_start_time) {
              updateData.stream_start_time = streamState.stream_start_time;
            }
            await updateLiveStatus(updateData);
            stopViewerCountUpdates(streamId);
            resetStreamSession(streamId);
          }
        }
        return;
      }
      
      // Process EACH tab independently (multi-stream support)
      // NO BREAK statement - continue processing all streams
      for (const tab of liveTabs) {
        try {
          // Extract stream_id from this tab's URL
          const streamId = extractStreamIdFromUrl(tab.url);
          if (!streamId) {
            console.warn('[Whatnot Pulse] Heartbeat: Could not extract stream_id from tab:', tab.url);
            continue; // Skip this tab
          }
          
          // Get stream state from map
          const streamState = streamsMap.get(streamId);
          if (!streamState || !streamState.streamer_username) {
            // Stream not in map yet - might be a new tab, skip for now
            continue;
          }
          
          // Check if stream is actually still live by querying content script for THIS tab
          let streamIsActuallyLive = false;
          let latestViewerCount = streamState.lastViewerCount;
          let latestStreamStartTime = streamState.stream_start_time;
          
          try {
            const response = await chrome.tabs.sendMessage(tab.id, { type: 'CHECK_STREAM_STATUS' });
            if (response && response.isLive) {
              streamIsActuallyLive = true;
              if (response.viewerCount !== undefined) latestViewerCount = response.viewerCount;
              if (response.stream_start_time) latestStreamStartTime = response.stream_start_time;
            }
          } catch (err) {
            // Tab might not have content script loaded, assume stream is still live
            console.warn(`[Whatnot Pulse] Could not check stream status for stream ${streamId} in tab ${tab.id}:`, err);
            streamIsActuallyLive = true; // Assume live if we can't check
          }
          
          // Update stored values for this stream
          if (latestViewerCount !== null) streamState.lastViewerCount = latestViewerCount;
          if (latestStreamStartTime) streamState.stream_start_time = latestStreamStartTime;
          streamsMap.set(streamId, streamState);
          
          if (streamIsActuallyLive) {
            // Send heartbeat update for THIS stream
            const updateData = {
              streamer_username: streamState.streamer_username,
              stream_id: streamId,
              is_live: true,
              title: streamState.title,
              stream_url: streamState.stream_url
            };
            // Ensure viewer_count is a number
            if (latestViewerCount !== null && latestViewerCount !== undefined) {
              const numViewers = typeof latestViewerCount === 'number' ? latestViewerCount : parseInt(latestViewerCount, 10);
              if (!isNaN(numViewers)) {
                updateData.viewer_count = numViewers;
              }
            }
            if (streamState.lastPendingItems !== null) updateData.pending_items = streamState.lastPendingItems;
            if (latestStreamStartTime) updateData.stream_start_time = latestStreamStartTime;
            
            console.log('[Whatnot Pulse] Heartbeat: Sending update for stream', streamId);
            await updateLiveStatus(updateData);
            
            // Request viewer count update from THIS tab's content script
            chrome.tabs.sendMessage(tab.id, { type: 'GET_VIEWER_COUNT' }).catch(err => {
              console.warn(`[Whatnot Pulse] Could not send GET_VIEWER_COUNT to stream ${streamId} tab ${tab.id}:`, err);
            });
          } else {
            // Stream is no longer live (tab open but stream ended)
            console.log('[Whatnot Pulse] Heartbeat: Stream', streamId, 'no longer live, marking as ended');
            const updateData = {
              streamer_username: streamState.streamer_username,
              stream_id: streamId,
              is_live: false
            };
            if (streamState.stream_start_time) {
              updateData.stream_start_time = streamState.stream_start_time;
            }
            await updateLiveStatus(updateData);
            
            stopViewerCountUpdates(streamId);
            resetStreamSession(streamId);
          }
        } catch (tabError) {
          // Error processing this tab - continue with next tab
          console.error(`[Whatnot Pulse] Error processing tab ${tab.id} in heartbeat:`, tabError);
          continue;
        }
      }
    } catch (error) {
      console.error('[Whatnot Pulse] Error in heartbeat:', error);
    }
  }
});

console.log('[Whatnot Pulse] Background service worker initialized');
