/**
 * Whatnot Pulse - Popup Script
 * Handles UI interactions and communicates with background service worker
 */

// DOM elements
const elements = {
  supabaseUrl: document.getElementById('supabaseUrl'),
  apiKey: document.getElementById('apiKey'),
  saveBtn: document.getElementById('saveBtn'),
  validateBtn: document.getElementById('validateBtn'),
  statusIndicator: document.getElementById('statusIndicator'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  statusSection: document.getElementById('statusSection'),
  connectionStatus: document.getElementById('connectionStatus'),
  organizationId: document.getElementById('organizationId'),
  currentStreamer: document.getElementById('currentStreamer'),
  queueLength: document.getElementById('queueLength'),
  lastSync: document.getElementById('lastSync'),
  errorMessage: document.getElementById('errorMessage'),
  successMessage: document.getElementById('successMessage'),
  debugSection: document.getElementById('debugSection'),
  debugContent: document.getElementById('debugContent'),
  toggleDebug: document.getElementById('toggleDebug'),
  refreshDebug: document.getElementById('refreshDebug'),
  injectConsoleTest: document.getElementById('injectConsoleTest'),
  getDomStructure: document.getElementById('getDomStructure'),
  debugCurrentPage: document.getElementById('debugCurrentPage'),
  debugIsLive: document.getElementById('debugIsLive'),
  debugStreamer: document.getElementById('debugStreamer'),
  debugLastApiCall: document.getElementById('debugLastApiCall'),
  debugLastError: document.getElementById('debugLastError')
};

/**
 * Show error message
 */
function showError(message) {
  elements.errorMessage.textContent = message;
  elements.errorMessage.style.display = 'block';
  elements.successMessage.style.display = 'none';
  
  setTimeout(() => {
    elements.errorMessage.style.display = 'none';
  }, 5000);
}

/**
 * Show success message
 */
function showSuccess(message) {
  elements.successMessage.textContent = message;
  elements.successMessage.style.display = 'block';
  elements.errorMessage.style.display = 'none';
  
  setTimeout(() => {
    elements.successMessage.style.display = 'none';
  }, 3000);
}

/**
 * Update connection status indicator
 */
function updateStatusIndicator(connected, error = null) {
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:65',message:'updateStatusIndicator called',data:{connected,hasError:!!error},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'STATUS'})}).catch(()=>{});
  // #endregion
  
  if (connected) {
    elements.statusDot.className = 'status-dot connected';
    elements.statusText.textContent = 'Connected';
    elements.statusText.className = 'status-text connected';
  } else {
    elements.statusDot.className = 'status-dot disconnected';
    elements.statusText.textContent = error ? 'Error: ' + error : 'Disconnected';
    elements.statusText.className = 'status-text disconnected';
  }
  
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:77',message:'updateStatusIndicator completed',data:{newText:elements.statusText.textContent},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'STATUS'})}).catch(()=>{});
  // #endregion
}

/**
 * Load current configuration from storage
 */
async function loadConfig() {
  try {
    const result = await chrome.storage.local.get([
      'api_key',
      'organization_id',
      'supabase_url',
      'current_streamer_username',
      'current_stream_title',
      'current_stream_url',
      'connection_status',
      'connection_checked_at'
    ]);

    // Set default Supabase URL if not configured
    if (result.supabase_url) {
      elements.supabaseUrl.value = result.supabase_url;
    } else {
      // Always set default URL
      elements.supabaseUrl.value = 'https://bahjsgjolebntwdxybek.supabase.co';
      // Save default URL to storage so it persists
      chrome.storage.local.set({ supabase_url: 'https://bahjsgjolebntwdxybek.supabase.co' });
    }

    if (result.api_key) {
      elements.apiKey.value = result.api_key;
    } else {
      // Clear the field if no API key
      elements.apiKey.value = '';
    }

    // If we have an organization_id stored, assume connected initially
    // This prevents the "disconnected" flash when reopening popup
    if (result.organization_id && result.api_key) {
      // Show as connected if we have org ID and API key
      updateStatusIndicator(true);
      elements.connectionStatus.textContent = 'Connected';
      elements.connectionStatus.className = 'status-value connected';
      elements.organizationId.textContent = result.organization_id;
      elements.statusSection.style.display = 'block';
    } else {
      // No credentials - show disconnected immediately
      updateStatusIndicator(false);
      elements.connectionStatus.textContent = 'Not Connected';
      elements.connectionStatus.className = 'status-value disconnected';
      elements.organizationId.textContent = '-';
      elements.statusSection.style.display = 'block';
    }

    // Get actual status from background script (will update if different)
    // Use timeout to prevent hanging - don't await, let it run in background
    updateStatus().catch(error => {
      console.warn('Status update failed:', error);
      // Ensure status is updated even if background script fails
      // Status already set from stored values above, so this is fine
      // But make sure "Checking..." is cleared
      if (elements.statusText.textContent === 'Checking...') {
        if (result.organization_id && result.api_key) {
          updateStatusIndicator(true);
        } else {
          updateStatusIndicator(false);
        }
      }
    });
  } catch (error) {
    console.error('Error loading config:', error);
    showError('Failed to load configuration');
  }
}

/**
 * Update status information
 */
async function updateStatus() {
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:143',message:'updateStatus called',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'STATUS'})}).catch(()=>{});
  // #endregion
  
  try {
    // Add timeout to prevent hanging if background worker is unresponsive
    let response;
    try {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:150',message:'Sending GET_STATUS message',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'STATUS'})}).catch(()=>{});
      // #endregion
      
      response = await Promise.race([
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 2000) // Reduced to 2 seconds
        )
      ]);
      
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:157',message:'GET_STATUS response received',data:{hasResponse:!!response,connected:response?.connected},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'STATUS'})}).catch(()=>{});
      // #endregion
    } catch (timeoutError) {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:159',message:'GET_STATUS timeout or error',data:{error:timeoutError.message,runtimeError:chrome.runtime.lastError?.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'STATUS'})}).catch(()=>{});
      // #endregion
      
      // If message fails or times out, check if we have stored credentials
      console.warn('Background worker not responding, using stored status');
      const stored = await chrome.storage.local.get(['organization_id', 'api_key', 'connection_status', 'supabase_url']);
      if (stored.organization_id && stored.api_key) {
        // Assume connected if we have credentials stored
        response = {
          connected: stored.connection_status === 'connected',
          hasApiKey: true,
          hasOrganizationId: true,
          queueLength: 0
        };
        // Update status indicator immediately
        updateStatusIndicator(response.connected);
        elements.connectionStatus.textContent = response.connected ? 'Connected' : 'Disconnected';
        elements.organizationId.textContent = stored.organization_id || '-';
        elements.statusSection.style.display = 'block';
      } else {
        response = { connected: false, hasApiKey: false, hasOrganizationId: false };
        // Show disconnected if no credentials
        updateStatusIndicator(false);
        elements.statusSection.style.display = 'block';
      }
      // Return early if we're using stored status
      return;
    }
    
    if (chrome.runtime.lastError && !response) {
      console.warn('Background worker error:', chrome.runtime.lastError);
      // Don't show error if we have stored credentials - background might just be sleeping
      const stored = await chrome.storage.local.get(['organization_id', 'api_key']);
      if (stored.organization_id && stored.api_key) {
        // Use stored status instead
        updateStatusIndicator(true);
        elements.connectionStatus.textContent = 'Connected';
        elements.organizationId.textContent = stored.organization_id || '-';
        elements.statusSection.style.display = 'block';
        return;
      } else {
        // No credentials - show disconnected
        updateStatusIndicator(false);
        elements.statusSection.style.display = 'block';
        return;
      }
    }

    // Only proceed if we got a valid response
    if (!response) {
      // No response - check stored credentials
      const stored = await chrome.storage.local.get(['organization_id', 'api_key']);
      if (stored.organization_id && stored.api_key) {
        updateStatusIndicator(true);
        elements.connectionStatus.textContent = 'Connected';
        elements.organizationId.textContent = stored.organization_id || '-';
      } else {
        updateStatusIndicator(false);
        elements.connectionStatus.textContent = 'Disconnected';
      }
      elements.statusSection.style.display = 'block';
      return;
    }

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:217',message:'About to update status indicator',data:{connected:response.connected,hasError:!!response.error},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'STATUS'})}).catch(()=>{});
    // #endregion
    
    // Update connection status
    updateStatusIndicator(response.connected, response.error);
    elements.connectionStatus.textContent = response.connected ? 'Connected' : 'Disconnected';
    elements.connectionStatus.className = response.connected ? 'status-value connected' : 'status-value disconnected';
    
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:223',message:'Status indicator updated',data:{statusText:elements.statusText.textContent},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'STATUS'})}).catch(()=>{});
    // #endregion

    // Update organization ID
    if (response.hasOrganizationId) {
      const orgResult = await chrome.storage.local.get(['organization_id']);
      elements.organizationId.textContent = orgResult.organization_id || '-';
    } else {
      elements.organizationId.textContent = '-';
    }

    // Update current streamer
    const streamerResult = await chrome.storage.local.get(['current_streamer_username', 'current_stream_title']);
    if (streamerResult.current_streamer_username) {
      const titleText = streamerResult.current_stream_title ? ` - ${streamerResult.current_stream_title}` : '';
      elements.currentStreamer.textContent = streamerResult.current_streamer_username + titleText;
    } else {
      elements.currentStreamer.textContent = 'None';
    }

    // Update queue length
    elements.queueLength.textContent = response.queueLength || 0;

    // Update last sync
    if (response.lastCheck) {
      const lastSyncDate = new Date(response.lastCheck);
      const now = new Date();
      const diffMs = now - lastSyncDate;
      const diffMins = Math.floor(diffMs / 60000);
      
      if (diffMins < 1) {
        elements.lastSync.textContent = 'Just now';
      } else if (diffMins < 60) {
        elements.lastSync.textContent = `${diffMins} min ago`;
      } else {
        const diffHours = Math.floor(diffMins / 60);
        elements.lastSync.textContent = `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
      }
    } else {
      elements.lastSync.textContent = 'Never';
    }

    // Show status section if we have configuration
    if (response.hasApiKey || response.hasOrganizationId) {
      elements.statusSection.style.display = 'block';
    }
  } catch (error) {
    console.error('Error updating status:', error);
  }
}

/**
 * Save configuration
 */
async function saveConfig() {
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:272',message:'saveConfig started',data:{hasUrl:!!elements.supabaseUrl.value,hasKey:!!elements.apiKey.value},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A,B,C,D,E'})}).catch(()=>{});
  // #endregion
  
  const supabaseUrl = elements.supabaseUrl.value.trim();
  const apiKey = elements.apiKey.value.trim();

  if (!supabaseUrl) {
    showError('Please enter your Supabase URL');
    return;
  }

  if (!apiKey) {
    showError('Please enter your API key');
    return;
  }

  // Validate URL format
  try {
    new URL(supabaseUrl);
  } catch (error) {
    showError('Invalid Supabase URL format');
    return;
  }

  elements.saveBtn.disabled = true;
  elements.saveBtn.textContent = 'Saving...';

  try {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:298',message:'Sending SET_API_KEY message from saveConfig',data:{url:supabaseUrl.substring(0,50)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    
    const response = await chrome.runtime.sendMessage({
      type: 'SET_API_KEY',
      api_key: apiKey,
      supabase_url: supabaseUrl
    });

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:305',message:'SET_API_KEY response received in saveConfig',data:{hasResponse:!!response,success:response?.success,error:response?.error?.substring(0,100),runtimeError:chrome.runtime.lastError?.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C,D'})}).catch(()=>{});
    // #endregion

    if (chrome.runtime.lastError) {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:309',message:'Runtime error after SET_API_KEY in saveConfig',data:{error:chrome.runtime.lastError.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B,D'})}).catch(()=>{});
      // #endregion
      throw new Error(chrome.runtime.lastError.message);
    }

    if (response.success) {
      showSuccess('Configuration saved successfully!');
      await updateStatus();
    } else {
      showError(response.error || 'Failed to save configuration');
    }
  } catch (error) {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:318',message:'saveConfig error caught',data:{error:error.message,stack:error.stack?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
    console.error('Error saving config:', error);
    showError(`Failed to save: ${error.message}`);
  } finally {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:324',message:'saveConfig finally block executing',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
    elements.saveBtn.disabled = false;
    elements.saveBtn.textContent = 'Save & Connect';
  }
}

/**
 * Test connection
 */
async function testConnection() {
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:326',message:'testConnection started',data:{hasUrl:!!elements.supabaseUrl.value,hasKey:!!elements.apiKey.value},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A,B,C,D,E'})}).catch(()=>{});
  // #endregion
  
  const supabaseUrl = elements.supabaseUrl.value.trim();
  const apiKey = elements.apiKey.value.trim();

  if (!supabaseUrl || !apiKey) {
    showError('Please enter both Supabase URL and API key');
    return;
  }

  elements.validateBtn.disabled = true;
  elements.validateBtn.textContent = 'Testing...';

  try {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:340',message:'Sending SET_API_KEY message',data:{url:supabaseUrl.substring(0,50)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    
    // First save the config
    const setKeyResponse = await chrome.runtime.sendMessage({
      type: 'SET_API_KEY',
      api_key: apiKey,
      supabase_url: supabaseUrl
    });

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:347',message:'SET_API_KEY response received',data:{hasResponse:!!setKeyResponse,success:setKeyResponse?.success,error:setKeyResponse?.error?.substring(0,100),runtimeError:chrome.runtime.lastError?.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C,D'})}).catch(()=>{});
    // #endregion

    if (chrome.runtime.lastError) {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:352',message:'Runtime error after SET_API_KEY',data:{error:chrome.runtime.lastError.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B,D'})}).catch(()=>{});
      // #endregion
      throw new Error(chrome.runtime.lastError.message);
    }

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:357',message:'Sending VALIDATE_API_KEY message',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    
    // Then validate
    const response = await chrome.runtime.sendMessage({
      type: 'VALIDATE_API_KEY'
    });

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:363',message:'VALIDATE_API_KEY response received',data:{hasResponse:!!response,success:response?.success,hasOrgId:!!response?.organization_id,error:response?.error?.substring(0,100),runtimeError:chrome.runtime.lastError?.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A,C,D'})}).catch(()=>{});
    // #endregion

    if (chrome.runtime.lastError) {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:368',message:'Runtime error after VALIDATE_API_KEY',data:{error:chrome.runtime.lastError.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B,D'})}).catch(()=>{});
      // #endregion
      throw new Error(chrome.runtime.lastError.message);
    }

    if (response.success) {
      showSuccess('Connection successful! Organization ID: ' + response.organization_id);
      await updateStatus();
    } else {
      showError(response.error || 'Connection failed');
      updateStatusIndicator(false, response.error);
    }
  } catch (error) {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:377',message:'testConnection error caught',data:{error:error.message,stack:error.stack?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
    console.error('Error testing connection:', error);
    showError(`Connection test failed: ${error.message}`);
    updateStatusIndicator(false, error.message);
  } finally {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:383',message:'testConnection finally block executing',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
    elements.validateBtn.disabled = false;
    elements.validateBtn.textContent = 'Test Connection';
  }
}

/**
 * Update debug information
 */
async function updateDebugInfo() {
  try {
    // Get current active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      const currentTab = tabs[0];
      elements.debugCurrentPage.textContent = currentTab.url || '-';
      
      // Check if it's a Whatnot live page
      const isLive = currentTab.url && currentTab.url.includes('/live/');
      elements.debugIsLive.textContent = isLive ? 'Yes' : 'No';
      
      // If it's a live page, try to get streamer info from storage
      if (isLive) {
        const stored = await chrome.storage.local.get(['current_streamer_username']);
        elements.debugStreamer.textContent = stored.current_streamer_username || 'Not detected yet';
        
        // Send message to content script to get current state
        try {
          chrome.tabs.sendMessage(currentTab.id, { type: 'GET_DEBUG_INFO' }, (response) => {
            if (!chrome.runtime.lastError && response) {
              if (response.streamerUsername) {
                elements.debugStreamer.textContent = response.streamerUsername;
              }
              if (response.isLivePage !== undefined) {
                elements.debugIsLive.textContent = response.isLivePage ? 'Yes' : 'No';
              }
            }
          });
        } catch (e) {
          // Content script might not be loaded or ready
        }
      } else {
        elements.debugStreamer.textContent = 'N/A (not on live page)';
      }
    } else {
      elements.debugCurrentPage.textContent = 'No active tab';
    }
    
    // Get last API call info from background
    const statusResponse = await chrome.runtime.sendMessage({ type: 'GET_STATUS' }).catch(() => null);
    if (statusResponse && statusResponse.lastCheck) {
      const lastCall = new Date(statusResponse.lastCheck);
      elements.debugLastApiCall.textContent = lastCall.toLocaleTimeString();
    } else {
      elements.debugLastApiCall.textContent = 'Never';
    }
    
    if (statusResponse && statusResponse.error) {
      elements.debugLastError.textContent = statusResponse.error;
    } else {
      elements.debugLastError.textContent = 'None';
    }
  } catch (error) {
    console.error('Error updating debug info:', error);
    elements.debugLastError.textContent = error.message;
  }
}

/**
 * Inject console test into current tab
 */
async function injectConsoleTest() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) {
      showError('No active tab found');
      return;
    }
    
    const testScript = `
      (function() {
        console.log('=== WN-Pulse Enhanced DOM Diagnostic ===');
        console.log('URL:', window.location.href);
        console.log('Pathname:', window.location.pathname);
        console.log('Is live:', window.location.pathname.startsWith('/live/'));
        
        // === STREAMER USERNAME ===
        console.log('\\n=== STREAMER USERNAME ===');
        const userLinks = document.querySelectorAll('a[href*="/user/"]');
        console.log('User links found:', userLinks.length);
        userLinks.forEach((link, idx) => {
          if (idx < 5) {
            const match = link.href.match(/\\/user\\/([^\\/\\?]+)/);
            console.log(\`  [\${idx}] \${link.href} → \${match?.[1] || 'no match'}\`);
            console.log(\`      Text: "\${link.textContent?.trim()?.substring(0, 50)}"\`);
            console.log(\`      Classes: \${link.className}\`);
            console.log(\`      Parent: \${link.parentElement?.tagName}.\${link.parentElement?.className?.split(' ')[0]}\`);
          }
        });
        
        // === STREAM TITLE ===
        console.log('\\n=== STREAM TITLE ===');
        
        // Try all title-related selectors
        const titleSelectors = [
          '[data-testid*="title"]',
          '[class*="title"]',
          'h1', 'h2', 'h3',
          '[title]:not([title=""])',
          '[aria-label*="title" i]'
        ];
        
        titleSelectors.forEach(selector => {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            console.log(\`Selector "\${selector}" found \${elements.length} element(s):\`);
            elements.forEach((el, idx) => {
              if (idx < 3) {
                const text = el.textContent?.trim() || el.getAttribute('title') || el.getAttribute('aria-label') || '';
                if (text.length > 0 && text.length < 200) {
                  const style = window.getComputedStyle(el);
                  console.log(\`  [\${idx}] "\${text.substring(0, 100)}"\`);
                  console.log(\`      Tag: \${el.tagName}, Classes: \${el.className?.substring(0, 100)}\`);
                  console.log(\`      FontSize: \${style.fontSize}, FontWeight: \${style.fontWeight}\`);
                  console.log(\`      HTML: \${el.outerHTML.substring(0, 200)}\`);
                }
              }
            });
          }
        });
        
        // === VIEWER COUNT ===
        console.log('\\n=== VIEWER COUNT ===');
        const viewerSelectors = [
          '[data-testid*="viewer"]',
          '[data-testid*="watching"]',
          '[class*="viewer"]',
          '[class*="watching"]'
        ];
        
        viewerSelectors.forEach(selector => {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            console.log(\`Selector "\${selector}" found \${elements.length} element(s):\`);
            elements.forEach((el, idx) => {
              if (idx < 5) {
                const text = el.textContent?.trim() || '';
                if (text.match(/[\\d.,kKmM]/)) {
                  console.log(\`  [\${idx}] "\${text}"\`);
                  console.log(\`      Tag: \${el.tagName}, Classes: \${el.className?.substring(0, 100)}\`);
                  console.log(\`      HTML: \${el.outerHTML.substring(0, 200)}\`);
                }
              }
            });
          }
        });
        
        // Search for watching/viewer patterns in text
        const pageText = document.body.innerText || '';
        const viewerMatches = pageText.match(/([\\d.,]+\\s*[kKmM]?)\\s*(?:watching|viewers?)/gi);
        if (viewerMatches) {
          console.log('Found in page text:', viewerMatches.slice(0, 5));
        }
        
        // === PENDING ITEMS ===
        console.log('\\n=== PENDING ITEMS / QUEUE ===');
        const pendingSelectors = [
          '[data-testid*="pending"]',
          '[data-testid*="queue"]',
          '[class*="pending"]',
          '[class*="queue"]'
        ];
        
        pendingSelectors.forEach(selector => {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            console.log(\`Selector "\${selector}" found \${elements.length} element(s):\`);
            elements.forEach((el, idx) => {
              if (idx < 5) {
                const text = el.textContent?.trim() || '';
                if (text.match(/[\\d]/) || text.toLowerCase().includes('pending') || text.toLowerCase().includes('queue')) {
                  console.log(\`  [\${idx}] "\${text}"\`);
                  console.log(\`      Tag: \${el.tagName}, Classes: \${el.className?.substring(0, 100)}\`);
                  console.log(\`      HTML: \${el.outerHTML.substring(0, 200)}\`);
                }
              }
            });
          }
        });
        
        // Search for pending/queue patterns
        const pendingMatches = pageText.match(/(?:pending|queue)[:\\(\\s]*([\\d.,]+)/gi);
        if (pendingMatches) {
          console.log('Found in page text:', pendingMatches.slice(0, 5));
        }
        
        // === DOM STRUCTURE SAMPLE ===
        console.log('\\n=== DOM STRUCTURE SAMPLE (First 500 chars of body) ===');
        console.log(document.body.innerHTML.substring(0, 500));
        
        console.log('\\n=== End Diagnostic ===');
        console.log('\\nCopy the above output and share it to help improve scraping accuracy!');
        alert('Diagnostic complete! Check the browser console (F12) for detailed results.');
      })();
    `;
    
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: new Function(testScript)
    });
    
    showSuccess('Console test injected! Check the browser console (F12) for results.');
  } catch (error) {
    console.error('Error injecting console test:', error);
    showError(`Failed to inject test: ${error.message}`);
  }
}

/**
 * Get DOM structure from content script for debugging
 */
async function getDomStructure() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) {
      showError('No active tab found');
      return;
    }
    
    const response = await chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_DOM_STRUCTURE' });
    
    if (response && response.domInfo) {
      console.log('=== DOM Structure Info ===', response.domInfo);
      
      // Display in a readable format
      const info = response.domInfo;
      let output = '=== DOM Structure Information ===\\n\\n';
      
      output += 'URL: ' + info.url + '\\n';
      output += 'Is Live Page: ' + info.isLivePage + '\\n\\n';
      
      output += '--- STREAM TITLE ---\\n';
      output += 'Extracted: ' + (info.title.extracted || 'null') + '\\n';
      output += 'Page Title: ' + info.title.pageTitle + '\\n';
      output += 'Meta OG Title: ' + (info.title.metaOgTitle || 'null') + '\\n';
      output += 'H1 Elements Found: ' + info.title.h1Elements.length + '\\n';
      if (info.title.h1Elements.length > 0) {
        info.title.h1Elements.forEach((h, idx) => {
          output += '  [' + idx + '] "' + (h.text || '') + '"\\n';
          output += '      Classes: ' + (h.classes || 'none') + '\\n';
        });
      }
      output += '\\n';
      
      output += '--- VIEWER COUNT ---\\n';
      output += 'Extracted: ' + info.viewerCount.extracted + '\\n';
      output += 'Elements Found: ' + info.viewerCount.elements.length + '\\n';
      if (info.viewerCount.elements.length > 0) {
        info.viewerCount.elements.forEach((el, idx) => {
          output += '  [' + idx + '] "' + (el.text || '') + '"\\n';
          output += '      Tag: ' + (el.tag || '') + ', Classes: ' + (el.classes || 'none') + '\\n';
        });
      }
      output += '\\n';
      
      output += '--- PENDING ITEMS ---\\n';
      output += 'Extracted: ' + (info.pendingItems.extracted || 'null') + '\\n';
      output += 'Elements Found: ' + info.pendingItems.elements.length + '\\n';
      if (info.pendingItems.elements.length > 0) {
        info.pendingItems.elements.forEach((el, idx) => {
          output += '  [' + idx + '] "' + (el.text || '') + '"\\n';
          output += '      Tag: ' + (el.tag || '') + ', Classes: ' + (el.classes || 'none') + '\\n';
        });
      }
      output += '\\n';
      
      output += '--- STREAMER USERNAME ---\\n';
      output += 'Extracted: ' + (info.streamerUsername.extracted || 'null') + '\\n';
      output += 'User Links Found: ' + info.streamerUsername.userLinks.length + '\\n';
      
      alert(output + '\\nFull details logged to console. Check F12 console for complete DOM structure.');
      showSuccess('DOM structure retrieved! Check console (F12) for full details.');
    } else {
      showError('Could not get DOM structure. Make sure you\'re on a Whatnot page.');
    }
  } catch (error) {
    console.error('Error getting DOM structure:', error);
    showError('Failed to get DOM structure: ' + error.message);
  }
}

/**
 * Initialize popup
 */
function init() {
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:758',message:'init() called',data:{hasStatusText:!!elements.statusText,initialText:elements.statusText?.textContent},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'INIT'})}).catch(()=>{});
  // #endregion
  
  // Ensure status text is cleared from "Checking..." immediately
  if (elements.statusText && elements.statusText.textContent === 'Checking...') {
    elements.statusText.textContent = 'Loading...';
  }
  
  // Load existing configuration
  loadConfig();

  // Set up event listeners
  elements.saveBtn.addEventListener('click', saveConfig);
  elements.validateBtn.addEventListener('click', testConnection);
  
  // Debug section toggle
  if (elements.toggleDebug) {
    elements.toggleDebug.addEventListener('click', () => {
      const isVisible = elements.debugContent.style.display !== 'none';
      elements.debugContent.style.display = isVisible ? 'none' : 'block';
      elements.toggleDebug.textContent = isVisible ? 'Show Debug' : 'Hide Debug';
      if (!isVisible) {
        updateDebugInfo();
      }
    });
  }
  
  if (elements.refreshDebug) {
    elements.refreshDebug.addEventListener('click', updateDebugInfo);
  }
  
  if (elements.injectConsoleTest) {
    elements.injectConsoleTest.addEventListener('click', injectConsoleTest);
  }
  
  if (elements.getDomStructure) {
    elements.getDomStructure.addEventListener('click', getDomStructure);
  }

  // Allow Enter key to save
  elements.supabaseUrl.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      saveConfig();
    }
  });

  elements.apiKey.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      saveConfig();
    }
  });

  // Show debug section
  if (elements.debugSection) {
    elements.debugSection.style.display = 'block';
  }

  // Update status every 2 seconds
  setInterval(updateStatus, 2000);
  
  // Update debug info every 3 seconds if visible
  setInterval(() => {
    if (elements.debugContent && elements.debugContent.style.display !== 'none') {
      updateDebugInfo();
    }
  }, 3000);

  // Initial status update
  updateStatus();
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    try {
      init();
    } catch (error) {
      console.error('Error initializing popup:', error);
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:827',message:'init() error in DOMContentLoaded',data:{error:error.message,stack:error.stack?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'INIT'})}).catch(()=>{});
      // #endregion
      // Fallback: ensure status is updated even if init fails
      if (elements.statusText) {
        elements.statusText.textContent = 'Error: Failed to load';
      }
    }
  });
} else {
  try {
    init();
  } catch (error) {
    console.error('Error initializing popup:', error);
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:840',message:'init() error in immediate call',data:{error:error.message,stack:error.stack?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'INIT'})}).catch(()=>{});
    // #endregion
    // Fallback: ensure status is updated even if init fails
    if (elements.statusText) {
      elements.statusText.textContent = 'Error: Failed to load';
    }
  }
}
