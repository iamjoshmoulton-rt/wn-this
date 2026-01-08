/**
 * Whatnot Pulse - Content Script
 * Monitors Whatnot livestreams for sales events and extracts streamer information
 */

(function() {
  'use strict';

  // Configuration
  const CONFIG = {
    // Supabase URL - to be configured by user via popup
    SUPABASE_URL: null,
    
    // MutationObserver debounce delay
    DEBOUNCE_DELAY: 100,
    
    // Periodic polling interval (fallback to catch missed sales)
    POLLING_INTERVAL: 15000, // 15 seconds (user requested 15-20 seconds)
    
    // Scan all existing sales on initialization
    SCAN_ALL_ON_INIT: true,
    
    // Streamer ID extraction selectors
    STREAMER_SELECTORS: [
      'a[href*="/user/"]',
      '[data-testid*="username"]',
      '[data-testid*="seller"]',
      '.user-name',
      '.streamer-name',
      '[class*="username"]',
      '[class*="seller"]'
    ],
    
    // Sales container selectors (adaptive)
    SALES_CONTAINER_SELECTORS: [
      '.sold-items-list',
      '.sales-feed',
      '[data-testid*="sold"]',
      '[data-testid*="sales"]',
      '[class*="sold"]',
      '[class*="sales"]',
      '[class*="transaction"]',
      '.activity-feed',
      '.live-feed'
    ]
  };

  // State management
  let streamerUsername = null;
  let processedTransactions = new Set();
  let observer = null;
  let debounceTimer = null;
  let lastSaleCheck = Date.now();
  let isMonitoringLive = false;
  let lastUrl = window.location.href;
  let viewerCountUpdateInterval = null;
  let loggedInUsername = null; // Cache for logged-in user detection
  let salesPollingInterval = null; // Interval for periodic sales scanning
  let lastSalesCount = 0; // Track number of sales found to detect new ones

  /**
   * Detect the logged-in user's username to filter it out from streamer detection
   * Returns lowercase username or null
   */
  function detectLoggedInUser() {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:57',message:'detectLoggedInUser called',data:{cached:loggedInUsername!==null,cachedValue:loggedInUsername},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    
    if (loggedInUsername !== null) {
      return loggedInUsername; // Return cached value
    }

    console.log('[Whatnot Pulse] Detecting logged-in user...');
    
    // Strategy 1: Check navigation/profile menu links (usually in header/nav)
    const navSelectors = [
      'nav a[href*="/user/"]',
      'header a[href*="/user/"]',
      '[data-testid="user-menu"] a[href*="/user/"]',
      '[data-testid="profile-link"]',
      '.user-menu a[href*="/user/"]',
      '.profile-link',
      '[class*="user-menu"] a[href*="/user/"]',
      '[class*="profile"] a[href*="/user/"]'
    ];

    for (const selector of navSelectors) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
          if (element.href) {
            const match = element.href.match(/\/user\/([^\/\?]+)/);
            if (match && match[1]) {
              const username = match[1].toLowerCase().trim();
              // Check if this element is in navigation/header (not in stream content)
              const isInNav = element.closest('nav, header, [role="navigation"], [class*="nav"], [class*="header"]');
              // #region agent log
              fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:82',message:'Checking nav link for logged-in user',data:{username,selector,isInNav:!!isInNav,selectorIncludesNav:selector.includes('nav')||selector.includes('header')||selector.includes('menu')},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
              // #endregion
              if (isInNav || selector.includes('nav') || selector.includes('header') || selector.includes('menu')) {
                loggedInUsername = username;
                console.log('[Whatnot Pulse] Detected logged-in user from navigation:', loggedInUsername);
                // #region agent log
                fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:87',message:'Logged-in user detected',data:{loggedInUsername},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
                // #endregion
                return loggedInUsername;
              }
            }
          }
        }
      } catch (e) {
        // Selector might not exist, continue
      }
    }

    // Strategy 2: Check for profile dropdown or user menu
    const profileMenus = document.querySelectorAll('[data-testid*="user"], [data-testid*="profile"], [class*="user-menu"], [class*="profile-menu"]');
    for (const menu of profileMenus) {
      const links = menu.querySelectorAll('a[href*="/user/"]');
      for (const link of links) {
        const match = link.href.match(/\/user\/([^\/\?]+)/);
        if (match && match[1]) {
          loggedInUsername = match[1].toLowerCase().trim();
          console.log('[Whatnot Pulse] Detected logged-in user from menu:', loggedInUsername);
          return loggedInUsername;
        }
      }
    }

    // Strategy 3: Check cookies or localStorage for username (if Whatnot stores it)
    try {
      // Check if there's any stored user info
      const cookies = document.cookie.split(';');
      for (const cookie of cookies) {
        const [key, value] = cookie.trim().split('=');
        if (key && (key.includes('user') || key.includes('username'))) {
          // This is a fallback, might not always work
          console.log('[Whatnot Pulse] Found potential user cookie:', key);
        }
      }
    } catch (e) {
      // Cookies might not be accessible
    }

    console.log('[Whatnot Pulse] Could not detect logged-in user (this is okay)');
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:129',message:'Logged-in user NOT detected',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    return null;
  }

  /**
   * Extract streamer username from DOM
   * Tries multiple strategies: profile links, DOM elements, title parsing
   * Filters out logged-in user to avoid false positives
   * Returns lowercase username
   */
  function extractStreamerUsername() {
    console.log('[Whatnot Pulse] extractStreamerUsername called');
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:138',message:'extractStreamerUsername called',data:{url:window.location.href},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
    // #endregion
    
    // First, detect logged-in user to filter them out
    const loggedInUser = detectLoggedInUser();
    console.log('[Whatnot Pulse] Logged-in user to filter:', loggedInUser || 'none detected');
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:143',message:'Logged-in user for filtering',data:{loggedInUser:loggedInUser||'none'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion

    // Strategy 1: Look for streamer username in video player overlay area (highest priority)
    // The streamer username appears near the video player, typically with a star rating
    console.log('[Whatnot Pulse] Trying Strategy 1: Video player overlay area');
    
    // Try to find the video player container first
    const videoPlayerSelectors = [
      '[class*="video-player"]',
      '[class*="stream-player"]',
      '[class*="live-player"]',
      'video',
      '[class*="player-container"]',
      '[class*="stream-container"]'
    ];
    
    let videoContainer = null;
    for (const selector of videoPlayerSelectors) {
      videoContainer = document.querySelector(selector);
      if (videoContainer) {
        console.log(`[Whatnot Pulse] Found video container with selector: ${selector}`);
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:161',message:'Video container found',data:{selector,found:true},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        break;
      }
    }
    // #region agent log
    if (!videoContainer) fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:166',message:'Video container NOT found',data:{selectorsTried:videoPlayerSelectors.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    
    // If we found a video container, look for username links within it
    if (videoContainer) {
      const videoUserLinks = videoContainer.querySelectorAll('a[href*="/user/"]');
      console.log(`[Whatnot Pulse] Found ${videoUserLinks.length} user links in video container`);
      
      for (const link of videoUserLinks) {
        const match = link.href.match(/\/user\/([^\/\?]+)/);
        if (match && match[1]) {
          const username = match[1].toLowerCase().trim();
          // Filter out logged-in user
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:174',message:'Found username in video container',data:{username,loggedInUser,isLoggedInUser:loggedInUser===username},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
          // #endregion
          if (loggedInUser && username === loggedInUser) {
            console.log('[Whatnot Pulse] Skipping logged-in user in video container:', username);
            continue;
          }
          console.log('[Whatnot Pulse] Found streamer username in video container:', username);
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:183',message:'RETURNING streamer username from Strategy 1',data:{username,strategy:'video-container'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
          // #endregion
          return username;
        }
      }
      
      // Also check for username text near star rating (common pattern)
      const starRating = videoContainer.querySelector('[class*="star"], [class*="rating"], [aria-label*="star"], [aria-label*="rating"]');
      if (starRating) {
        const nearbyLinks = starRating.closest('[class*="header"], [class*="info"], [class*="meta"]')?.querySelectorAll('a[href*="/user/"]');
        if (nearbyLinks) {
          for (const link of nearbyLinks) {
            const match = link.href.match(/\/user\/([^\/\?]+)/);
            if (match && match[1]) {
              const username = match[1].toLowerCase().trim();
              if (!loggedInUser || username !== loggedInUser) {
                console.log('[Whatnot Pulse] Found streamer username near star rating:', username);
                return username;
              }
            }
          }
        }
      }
    }

    // Strategy 2: Look for streamer-specific data-testid selectors
    const streamerSpecificSelectors = [
      '[data-testid="streamer-username"]',
      '[data-testid="seller-username"]',
      '[data-testid="broadcaster-username"]',
      '[data-testid*="username"]',
      '.streamer-username',
      '.seller-username',
      '.broadcaster-username',
      '[class*="streamer"][class*="username"]',
      '[class*="seller"][class*="username"]'
    ];

    console.log('[Whatnot Pulse] Trying Strategy 2: Streamer-specific selectors');
    for (const selector of streamerSpecificSelectors) {
      try {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          console.log(`[Whatnot Pulse] Found ${elements.length} elements with selector: ${selector}`);
          for (const element of elements) {
            // Check if element is near video player or stream content (not in nav)
            const isInStreamArea = element.closest('[class*="stream"], [class*="video"], [class*="player"], [class*="live"], main, [role="main"]');
            if (!isInStreamArea) continue; // Skip if not in stream area

            // Try href
            if (element.href) {
              const match = element.href.match(/\/user\/([^\/\?]+)/);
              if (match && match[1]) {
                const username = match[1].toLowerCase().trim();
                if (!loggedInUser || username !== loggedInUser) {
                  console.log('[Whatnot Pulse] Found streamer username from streamer-specific selector:', username);
                  return username;
                }
              }
            }

            // Try text content
            const text = element.textContent?.trim();
            if (text && text.length > 0 && text.length < 50 && /^[a-zA-Z0-9_-]+$/.test(text)) {
              const username = text.toLowerCase();
              if (!loggedInUser || username !== loggedInUser) {
                console.log('[Whatnot Pulse] Found streamer username from text:', username);
                return username;
              }
            }
          }
        }
      } catch (e) {
        // Selector might not exist
      }
    }

    // Strategy 3: Look for profile links near video player or stream header
    console.log('[Whatnot Pulse] Trying Strategy 2: Profile links near stream content');
    const streamContainerSelectors = [
      '[class*="stream"]',
      '[class*="video"]',
      '[class*="player"]',
      '[class*="live-content"]',
      'main',
      '[role="main"]'
    ];

    for (const containerSelector of streamContainerSelectors) {
      try {
        const containers = document.querySelectorAll(containerSelector);
        for (const container of containers) {
          // Skip navigation/header containers
          if (container.closest('nav, header, [role="navigation"]')) continue;

          // Look for user links within this container
          const userLinks = container.querySelectorAll('a[href*="/user/"]');
          for (const link of userLinks) {
            const match = link.href.match(/\/user\/([^\/\?]+)/);
            if (match && match[1]) {
              const username = match[1].toLowerCase().trim();
              
              // Filter out logged-in user
              if (loggedInUser && username === loggedInUser) {
                console.log('[Whatnot Pulse] Skipping logged-in user:', username);
                continue;
              }

              // Check if this link is associated with streamer info (near viewer count, title, etc.)
              const nearbyText = link.closest('[class*="streamer"], [class*="seller"], [class*="broadcaster"], [class*="header"]')?.textContent || '';
              const hasStreamerIndicators = nearbyText.includes('★') || nearbyText.includes('viewer') || nearbyText.includes('watching') || 
                                           link.closest('[class*="stream"]') || link.closest('[class*="live"]');

              if (hasStreamerIndicators || !link.closest('nav, header')) {
                console.log('[Whatnot Pulse] Found streamer username near stream content:', username);
                return username;
              }
            }
          }
        }
      } catch (e) {
        // Container might not exist
      }
    }

    // Strategy 4: Extract from general profile links (but exclude nav/header)
    console.log('[Whatnot Pulse] Trying Strategy 3: General profile links (excluding nav/header)');
    const allUserLinks = document.querySelectorAll('a[href*="/user/"]');
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:308',message:'Strategy 4: Found all user links',data:{totalLinks:allUserLinks.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
    // #endregion
    const candidates = [];

    for (const link of allUserLinks) {
      const match = link.href.match(/\/user\/([^\/\?]+)/);
      if (match && match[1]) {
        const username = match[1].toLowerCase().trim();
        const isInNav = !!link.closest('nav, header, [role="navigation"], [class*="nav"], [class*="user-menu"], [class*="profile-menu"]');
        const isInStreamArea = !!link.closest('[class*="stream"], [class*="video"], [class*="live"], main');
        const isLoggedInUser = loggedInUser && username === loggedInUser;
        
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:318',message:'Checking user link',data:{username,isInNav,isInStreamArea,isLoggedInUser,willSkip:isInNav||isLoggedInUser},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        
        // Skip navigation and header links
        if (isInNav) {
          continue;
        }
        
        // Filter out logged-in user
        if (isLoggedInUser) {
          continue;
        }

        // Prioritize links in stream-related areas
        if (isInStreamArea) {
          console.log('[Whatnot Pulse] Found candidate username in stream area:', username);
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:330',message:'RETURNING streamer username from Strategy 4',data:{username,strategy:'general-links-stream-area'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
          // #endregion
          return username; // Return immediately if in stream area
        }

        candidates.push({ username, element: link });
      }
    }

    // If we found candidates but none in stream area, return the first one
    if (candidates.length > 0) {
      const username = candidates[0].username;
      console.log('[Whatnot Pulse] Using first candidate username (not in nav):', username);
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:337',message:'RETURNING first candidate username',data:{username,candidatesCount:candidates.length,strategy:'general-links-fallback'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      return username;
    }

    // Strategy 5: Parse page title (usually has streamer name)
    console.log('[Whatnot Pulse] Trying Strategy 4: Page title');
    const title = document.title;
    console.log('[Whatnot Pulse] Page title:', title);
    // Pattern: "username is live" or "username · ..."
    const titleMatch = title.match(/([a-zA-Z0-9_-]+)\s+(is live|·)/i);
    if (titleMatch && titleMatch[1]) {
      const username = titleMatch[1].toLowerCase().trim();
      // Filter out logged-in user
      if (!loggedInUser || username !== loggedInUser) {
        console.log('[Whatnot Pulse] Found username from title:', username);
        return username;
      }
    }

    // Strategy 6: Parse meta tags
    console.log('[Whatnot Pulse] Trying Strategy 5: Meta tags');
    const metaTags = document.querySelectorAll('meta[property*="profile"], meta[name*="profile"], meta[property*="og:url"]');
    console.log('[Whatnot Pulse] Found', metaTags.length, 'meta tags');
    for (const meta of metaTags) {
      const content = meta.content || meta.getAttribute('content');
      if (content) {
        const match = content.match(/\/user\/([^\/\?]+)/);
        if (match && match[1]) {
          const username = match[1].toLowerCase().trim();
          // Filter out logged-in user
          if (!loggedInUser || username !== loggedInUser) {
            console.log('[Whatnot Pulse] Found username from meta tag:', username);
            return username;
          }
        }
      }
    }

    // Strategy 7: Look for streamer name near viewer count or stream stats
    console.log('[Whatnot Pulse] Trying Strategy 6: Near viewer count/stream stats');
    const viewerElements = document.querySelectorAll('[class*="viewer"], [class*="watching"], [data-testid*="viewer"]');
    for (const viewerEl of viewerElements) {
      // Look for user links near viewer count
      const container = viewerEl.closest('[class*="stream"], [class*="live"], [class*="header"]');
      if (container) {
        const userLink = container.querySelector('a[href*="/user/"]');
        if (userLink) {
          const match = userLink.href.match(/\/user\/([^\/\?]+)/);
          if (match && match[1]) {
            const username = match[1].toLowerCase().trim();
            if (!loggedInUser || username !== loggedInUser) {
              console.log('[Whatnot Pulse] Found username near viewer count:', username);
              return username;
            }
          }
        }
      }
    }

    console.warn('[Whatnot Pulse] All extraction strategies failed, no username found');
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:349',message:'FAILED: No username found',data:{loggedInUser:loggedInUser||'none'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
    return null;
  }

  /**
   * Extract stream title from DOM
   * Uses multiple strategies with comprehensive fallbacks
   */
  function getStreamTitle() {
    console.log('[Whatnot Pulse] Extracting stream title...');
    
    // Strategy 1: Data testid attributes (most reliable)
    const dataTestIdSelectors = [
      '[data-testid="stream-title"]',
      '[data-testid="show-title"]',
      '[data-testid="live-title"]',
      '[data-testid*="title"]'
    ];
    
    for (const selector of dataTestIdSelectors) {
      const element = document.querySelector(selector);
      if (element && element.textContent) {
        const title = element.textContent.trim();
        if (title && title.length > 0 && title !== 'Untitled stream' && title !== 'Untitled') {
          console.log('[Whatnot Pulse] Found title via data-testid:', selector, '→', title);
          return title;
        }
      }
    }
    
    // Strategy 2: Class-based selectors (common patterns)
    const classSelectors = [
      '.stream-title',
      '.show-title',
      '.live-title',
      '[class*="stream-title"]',
      '[class*="show-title"]',
      '[class*="live-title"]',
      '[class*="StreamTitle"]',
      '[class*="ShowTitle"]'
    ];
    
    for (const selector of classSelectors) {
      const element = document.querySelector(selector);
      if (element && element.textContent) {
        const title = element.textContent.trim();
        if (title && title.length > 0 && title !== 'Untitled stream' && title !== 'Untitled') {
          console.log('[Whatnot Pulse] Found title via class:', selector, '→', title);
          return title;
        }
      }
    }
    
    // Strategy 3: Heading elements (h1, h2, h3) near stream content
    const headings = document.querySelectorAll('h1, h2, h3');
    for (const heading of headings) {
      // Check if heading is in stream/live content area (not navigation)
      const isInNav = heading.closest('nav, header, [role="navigation"]');
      const isInStream = heading.closest('[class*="stream"], [class*="live"], [class*="show"], [class*="player"]');
      
      if (!isInNav && (isInStream || !isInNav)) {
        const text = heading.textContent?.trim();
        if (text && text.length > 0 && text.length < 200 && 
            text !== 'Untitled stream' && text !== 'Untitled' &&
            !text.match(/^[0-9]+\s*(watching|viewers?|live)$/i)) {
          console.log('[Whatnot Pulse] Found title via heading:', heading.tagName, '→', text);
          return text;
        }
      }
    }
    
    // Strategy 4: Look for title attribute in prominent elements
    const titleAttributeElements = document.querySelectorAll('[title]:not([title=""]), [aria-label*="title" i]');
    for (const element of titleAttributeElements) {
      const title = element.getAttribute('title') || element.getAttribute('aria-label');
      if (title && title.trim().length > 0 && title.length < 200 &&
          title !== 'Untitled stream' && title !== 'Untitled') {
        // Make sure it's not a tooltip or icon description
        if (!title.match(/^(icon|button|link|click|view|open|close)$/i)) {
          console.log('[Whatnot Pulse] Found title via title attribute →', title);
          return title.trim();
        }
      }
    }
    
    // Strategy 5: Search for text patterns that indicate stream titles
    // Look for large, bold text that's not navigation
    const potentialTitleElements = document.querySelectorAll('div, span, p, section');
    for (const element of potentialTitleElements) {
      const computedStyle = window.getComputedStyle(element);
      const fontSize = parseFloat(computedStyle.fontSize);
      const fontWeight = computedStyle.fontWeight;
      const text = element.textContent?.trim();
      
      // Large, bold text that's not in nav and is reasonably long
      if (fontSize >= 18 && (fontWeight >= 600 || fontWeight === 'bold') &&
          text && text.length > 5 && text.length < 200 &&
          !element.closest('nav, header, [role="navigation"], button, a') &&
          !text.match(/^(watching|viewers?|live|follow|following|message|share)$/i) &&
          !text.includes('Untitled')) {
        console.log('[Whatnot Pulse] Found title via text styling →', text);
        return text;
      }
    }
    
    // Strategy 6: Meta tags fallback
    const metaTitle = document.querySelector('meta[property="og:title"]') || 
                      document.querySelector('meta[name="title"]');
    if (metaTitle) {
      const title = metaTitle.getAttribute('content') || metaTitle.getAttribute('value');
      if (title && title.trim().length > 0 && 
          !title.includes('Whatnot') && !title.match(/^\w+\s+is live$/i)) {
        console.log('[Whatnot Pulse] Found title via meta tag →', title);
        return title.trim();
      }
    }
    
    console.warn('[Whatnot Pulse] Could not extract stream title - all strategies failed');
    return null;
  }

  /**
   * Extract stream ID (UUID) from URL
   * Returns UUID or null if not found
   * @param {string} url - The URL to extract from (defaults to current page URL)
   * @returns {string|null}
   */
  function extractStreamIdFromUrl(url = window.location.href) {
    if (!url) return null;
    // Pattern: /live/{uuid} where uuid is 36 characters (8-4-4-4-12 hex digits)
    const match = url.match(/\/live\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    return match ? match[1] : null;
  }

  /**
   * Extract stream start time from DOM
   * Looks for patterns like "Live for 2h 30m", "Started 1 hour ago", etc.
   * @param {boolean} historicalMode - If true, bypasses pageLoadTime check and accepts times up to 7 days old
   * @returns {string|null} ISO 8601 timestamp or null
   */
  function getStreamStartTime(historicalMode = false) {
    console.log('[Whatnot Pulse] Extracting stream start time...');
    
    const now = new Date();
    const pageLoadTime = new Date(performance.timing.navigationStart || Date.now());
    const pageText = document.body.innerText || document.body.textContent || '';
    
    // Validation: For historical pulls, accept times up to 7 days old
    // For live monitoring, reject any start time that is more than 12 hours in the past
    const maxHoursAgo = historicalMode ? 168 : 12; // 7 days vs 12 hours
    
    // Strategy 1: Look for timer/countdown elements that show stream duration
    const timerElements = document.querySelectorAll('[class*="timer"], [class*="duration"], [class*="elapsed"], [class*="stream-time"], [class*="live-time"]');
    for (const timerEl of timerElements) {
      const text = timerEl.textContent || '';
      // Look for "HH:MM:SS" or "MM:SS" format (elapsed time)
      const timeMatch = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (timeMatch) {
        const hours = parseInt(timeMatch[1] || '0', 10);
        const minutes = parseInt(timeMatch[2] || '0', 10);
        const seconds = parseInt(timeMatch[3] || '0', 10);
        const totalSeconds = hours * 3600 + minutes * 60 + seconds;
        if (totalSeconds > 0 && totalSeconds < (maxHoursAgo * 3600)) {
          const startTime = new Date(now.getTime() - totalSeconds * 1000);
          // Validate: for historical mode, skip pageLoadTime check; otherwise must be after page load
          const isValid = historicalMode 
            ? (startTime <= now && (now - startTime) / (1000 * 60 * 60) <= maxHoursAgo)
            : (startTime >= pageLoadTime && (now - startTime) / (1000 * 60 * 60) <= maxHoursAgo);
          if (isValid) {
            console.log('[Whatnot Pulse] Found stream start time via timer element:', startTime.toISOString(), `(${hours}:${minutes}:${seconds} elapsed, historicalMode: ${historicalMode})`);
            return startTime.toISOString();
          } else {
            console.warn('[Whatnot Pulse] Rejected stream start time - outside validation window');
          }
        }
      }
    }
    
    // Strategy 2: Look for "Live for X" or "X ago" patterns (expanded)
    const timePatterns = [
      /live\s+for\s+(\d+)\s*(?:h|hour|hr|hours)?\s*(?:(\d+)\s*(?:m|min|minute|minutes))?\s*(?:(\d+)\s*(?:s|sec|second|seconds))?/i,
      /started\s+(\d+)\s*(?:h|hour|hr|hours)?\s*(?:(\d+)\s*(?:m|min|minute|minutes))?\s*(?:(\d+)\s*(?:s|sec|second|seconds))?\s*ago/i,
      /(\d+)\s*(?:h|hour|hr|hours)?\s*(?:(\d+)\s*(?:m|min|minute|minutes))?\s*(?:(\d+)\s*(?:s|sec|second|seconds))?\s*(?:ago|since|live)/i,
      /streaming\s+(?:for|since)\s+(\d+)\s*(?:h|hour|hr|hours)?\s*(?:(\d+)\s*(?:m|min|minute|minutes))?/i,
      /went\s+live\s+(\d+)\s*(?:h|hour|hr|hours)?\s*(?:(\d+)\s*(?:m|min|minute|minutes))?\s*ago/i
    ];
    
    for (const pattern of timePatterns) {
      const match = pageText.match(pattern);
      if (match) {
        const hours = parseInt(match[1] || '0', 10);
        const minutes = parseInt(match[2] || '0', 10);
        const seconds = parseInt(match[3] || '0', 10);
        const totalSeconds = hours * 3600 + minutes * 60 + seconds;
        if (totalSeconds > 0 && totalSeconds < (maxHoursAgo * 3600)) {
          const startTime = new Date(now.getTime() - totalSeconds * 1000);
          // Validate: for historical mode, skip pageLoadTime check; otherwise must be after page load
          const isValid = historicalMode 
            ? (startTime <= now && (now - startTime) / (1000 * 60 * 60) <= maxHoursAgo)
            : (startTime >= pageLoadTime && (now - startTime) / (1000 * 60 * 60) <= maxHoursAgo);
          if (isValid) {
            console.log('[Whatnot Pulse] Found stream start time via text pattern:', startTime.toISOString(), `(${hours}h ${minutes}m ${seconds}s ago, historicalMode: ${historicalMode})`);
            return startTime.toISOString();
          } else {
            console.warn('[Whatnot Pulse] Rejected stream start time - outside validation window');
          }
        }
      }
    }
    
    // Strategy 3: Look for datetime attributes or data attributes (expanded)
    const timeElements = document.querySelectorAll('[datetime], [data-start-time], [data-stream-start], [data-live-start], [data-broadcast-start], time[datetime], [class*="start-time"], [class*="live-start"]');
    for (const element of timeElements) {
      const datetime = element.getAttribute('datetime') || 
                      element.getAttribute('data-start-time') || 
                      element.getAttribute('data-stream-start') ||
                      element.getAttribute('data-live-start') ||
                      element.getAttribute('data-broadcast-start');
      if (datetime) {
        try {
          const startTime = new Date(datetime);
          const hoursSinceStart = (now - startTime) / (1000 * 60 * 60);
          // Validate: for historical mode, skip pageLoadTime check; otherwise must be after page load
          const isValid = historicalMode
            ? (!isNaN(startTime.getTime()) && startTime <= now && hoursSinceStart >= 0 && hoursSinceStart <= maxHoursAgo)
            : (!isNaN(startTime.getTime()) && startTime <= now && startTime >= pageLoadTime && hoursSinceStart >= 0 && hoursSinceStart <= maxHoursAgo);
          if (isValid) {
            console.log('[Whatnot Pulse] Found stream start time via datetime attribute:', startTime.toISOString(), `(historicalMode: ${historicalMode})`);
            return startTime.toISOString();
          } else {
            console.warn('[Whatnot Pulse] Rejected stream start time from datetime attribute - outside validation window');
          }
        } catch (e) {
          // Invalid date, continue
        }
      }
    }
    
    // Strategy 4: Check video player metadata
    const videoElements = document.querySelectorAll('video, [class*="video-player"], [class*="stream-player"]');
    for (const videoEl of videoElements) {
      // Check for data attributes on video element
      const startTimeAttr = videoEl.getAttribute('data-start-time') || 
                           videoEl.getAttribute('data-stream-start') ||
                           videoEl.closest('[class*="player"], [class*="stream"]')?.getAttribute('data-start-time');
      if (startTimeAttr) {
        try {
          const startTime = new Date(startTimeAttr);
          const hoursSinceStart = (now - startTime) / (1000 * 60 * 60);
          // Validate: for historical mode, skip pageLoadTime check; otherwise must be after page load
          const isValid = historicalMode
            ? (!isNaN(startTime.getTime()) && startTime <= now && hoursSinceStart >= 0 && hoursSinceStart <= maxHoursAgo)
            : (!isNaN(startTime.getTime()) && startTime <= now && startTime >= pageLoadTime && hoursSinceStart >= 0 && hoursSinceStart <= maxHoursAgo);
          if (isValid) {
            console.log('[Whatnot Pulse] Found stream start time via video metadata:', startTime.toISOString(), `(historicalMode: ${historicalMode})`);
            return startTime.toISOString();
          } else {
            console.warn('[Whatnot Pulse] Rejected stream start time from video metadata - outside validation window');
          }
        } catch (e) {
          // Invalid date, continue
        }
      }
    }
    
    // Strategy 5: Look for elements with "started", "live for", "duration" text (in video area only)
    const videoArea = document.querySelector('[class*="video"], [class*="player"], [class*="stream"], video, [class*="live-content"]');
    const searchContainer = videoArea || document.body;
    const allElements = searchContainer.querySelectorAll('*');
    for (const element of allElements) {
      const text = element.textContent || '';
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      
      // Look for time patterns in visible elements
      for (const pattern of timePatterns) {
        const match = text.match(pattern);
        if (match) {
          const hours = parseInt(match[1] || '0', 10);
          const minutes = parseInt(match[2] || '0', 10);
          const seconds = parseInt(match[3] || '0', 10);
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;
          if (totalSeconds > 0 && totalSeconds < (maxHoursAgo * 3600)) {
            const startTime = new Date(now.getTime() - totalSeconds * 1000);
            // Validate: for historical mode, skip pageLoadTime check; otherwise must be after page load
            const isValid = historicalMode 
              ? (startTime <= now && (now - startTime) / (1000 * 60 * 60) <= maxHoursAgo)
              : (startTime >= pageLoadTime && (now - startTime) / (1000 * 60 * 60) <= maxHoursAgo);
            if (isValid) {
              console.log('[Whatnot Pulse] Found stream start time via element text:', startTime.toISOString(), `(historicalMode: ${historicalMode})`);
              return startTime.toISOString();
            } else {
              console.warn('[Whatnot Pulse] Rejected stream start time - outside validation window');
            }
          }
        }
      }
      
      // Also check for "HH:MM:SS" format in timer-like elements
      const timeMatch = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (timeMatch) {
        const hours = parseInt(timeMatch[1] || '0', 10);
        const minutes = parseInt(timeMatch[2] || '0', 10);
        const seconds = parseInt(timeMatch[3] || '0', 10);
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;
          if (totalSeconds > 0 && totalSeconds < (maxHoursAgo * 3600)) {
            const startTime = new Date(now.getTime() - totalSeconds * 1000);
            // Validate: for historical mode, skip pageLoadTime check; otherwise must be after page load
            const isValid = historicalMode 
              ? (startTime <= now && (now - startTime) / (1000 * 60 * 60) <= maxHoursAgo)
              : (startTime >= pageLoadTime && (now - startTime) / (1000 * 60 * 60) <= maxHoursAgo);
            if (isValid) {
              console.log('[Whatnot Pulse] Found stream start time via timer format:', startTime.toISOString(), `(historicalMode: ${historicalMode})`);
              return startTime.toISOString();
            } else {
              console.warn('[Whatnot Pulse] Rejected stream start time - outside validation window');
            }
          }
      }
    }
    
    // Don't log warning - extraction failures are expected sometimes
    return null;
  }

  /**
   * Extract viewer count from DOM
   * Handles various formats: "353", "1.2K", "1.5K watching", etc.
   * Improved to find the most prominent/accurate viewer count
   */
  function getViewerCount() {
    console.log('[Whatnot Pulse] Extracting viewer count...');
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:720',message:'getViewerCount called',data:{timestamp:Date.now()},timestamp:Date.now(),sessionId:'debug-session',runId:'run10',hypothesisId:'VIEWER_MISMATCH'})}).catch(()=>{});
    // #endregion
    
    // Helper function to parse number with K/M suffixes
    const parseNumber = (text) => {
      if (!text) return null;
      
      // Remove commas and whitespace
      const clean = text.replace(/,/g, '').trim();
      
      // Handle K suffix (thousands)
      const kMatch = clean.match(/([\d.]+)\s*[kK]/);
      if (kMatch) {
        return Math.round(parseFloat(kMatch[1]) * 1000);
      }
      
      // Handle M suffix (millions)
      const mMatch = clean.match(/([\d.]+)\s*[mM]/);
      if (mMatch) {
        return Math.round(parseFloat(mMatch[1]) * 1000000);
      }
      
      // Plain number
      const numMatch = clean.match(/(\d+)/);
      if (numMatch) {
        return parseInt(numMatch[1], 10);
      }
      
      return null;
    };
    
    // Helper to score viewer count candidates by prominence
    const scoreElement = (element, count) => {
      let score = 0;
      const scoringDetails = { count, baseScore: 0, adjustments: {} };
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      
      // Must be visible
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) {
        return -1; // Invalid
      }
      
      // HEAVILY penalize chat/sidebar areas - these are NOT the main viewer count
      const isInChat = element.closest('[class*="chat"], [class*="sidebar"], [class*="message"], [id*="chat"], [id*="sidebar"], [class*="Chat"], [class*="Sidebar"]');
      if (isInChat) {
        // Check if it's the "Watching" header in chat (usually shows 2-5 viewers)
        const isChatWatching = element.closest('[class*="watching"], [class*="Watching"]') && 
                               element.closest('[class*="chat"], [id*="chat"]');
        if (isChatWatching) {
          scoringDetails.adjustments.chatWatching = -100;
          return -100; // Completely exclude chat watching counts
        }
        score -= 50; // Heavy penalty for any chat area
        scoringDetails.adjustments.inChat = -50;
      }
      
      // Prefer elements in video/stream area (not chat)
      const isInVideo = element.closest('[class*="video"], [class*="player"], [class*="stream"], [class*="live"], video, [class*="VideoPlayer"], [class*="StreamPlayer"]');
      const isNearLiveBadge = element.closest('[class*="live-badge"], [class*="live-indicator"], [class*="LiveBadge"]');
      
      if (isInVideo && !isInChat) score += 50; // High priority for video area
      if (isNearLiveBadge) score += 40; // Even higher if near live badge
      
      // Prefer elements that are siblings or children of live indicators
      const parent = element.parentElement;
      const siblings = parent ? Array.from(parent.children) : [];
      const hasLiveSibling = siblings.some(sib => {
        const sibText = sib.textContent || '';
        const sibClass = sib.className || '';
        return /live/i.test(sibText) || /live/i.test(sibClass) || sib.querySelector('[class*="live"], [class*="LIVE"]');
      });
      if (hasLiveSibling) score += 30;
      
      // Prefer larger font sizes (more prominent)
      const fontSize = parseFloat(style.fontSize);
      if (fontSize >= 16) score += 20;
      if (fontSize >= 20) score += 10;
      if (fontSize >= 24) score += 15; // Extra for very large text
      
      // Prefer elements near top-right of viewport (main viewer count location)
      if (rect.top < 200) score += 15;
      if (rect.top < 100) score += 10; // Extra for very top
      if (rect.right > window.innerWidth - 200) score += 20; // Top-right area (increased weight)
      if (rect.right > window.innerWidth - 100) score += 15; // Extra for very right
      
      // Check if element is positioned absolutely/fixed in top-right (common for viewer counts)
      if (style.position === 'absolute' || style.position === 'fixed') {
        if (rect.top < 150 && rect.right > window.innerWidth - 150) {
          score += 25; // High confidence this is the main viewer count
        }
      }
      
      // Prefer elements with "live" indicator nearby
      const hasLiveIndicator = element.closest('[class*="live"], [class*="stream"], [class*="LiveIndicator"]');
      if (hasLiveIndicator && !isInChat) score += 25;
      
      // Prefer data-testid attributes (more reliable)
      if (element.getAttribute('data-testid')) score += 15;
      
      // STRONGLY prefer higher numbers (main count is usually higher than chat count, which is often 2-5)
      if (count > 50) {
        score += 30; // Strong preference for higher counts
        scoringDetails.adjustments.veryHighCount = 30;
      }
      if (count > 20) {
        score += 20; // Increased weight
        scoringDetails.adjustments.highCount = 20;
      }
      if (count > 10) {
        score += 10; // Bonus for counts above typical chat range
        scoringDetails.adjustments.mediumCount = 10;
      }
      // HEAVILY penalize very low counts (2-5 is typical chat participant count)
      if (count <= 5) {
        score -= 50; // Strong penalty for very low counts (likely chat)
        scoringDetails.adjustments.lowCount = -50;
        // If it's specifically 2, it's almost certainly a chat count
        if (count === 2) {
          score -= 30; // Additional penalty for exactly 2
          scoringDetails.adjustments.chatCount = -30;
        }
      }
      if (count > 5 && count <= 10) {
        score -= 20; // Penalty for low counts that might be chat
        scoringDetails.adjustments.lowMediumCount = -20;
      }
      
      // Check background color - viewer counts often have red/dark backgrounds
      const bgColor = style.backgroundColor;
      if (bgColor && (bgColor.includes('rgb(220') || bgColor.includes('rgb(239') || bgColor.includes('rgba(220') || bgColor.includes('rgba(239'))) {
        score += 10; // Red/dark background suggests main viewer count badge
        scoringDetails.adjustments.redBackground = 10;
      }
      
      scoringDetails.finalScore = score;
      scoringDetails.elementInfo = {
        tagName: element.tagName,
        className: element.className?.substring(0, 100),
        textContent: element.textContent?.substring(0, 50),
        position: { top: rect.top, right: rect.right, width: rect.width, height: rect.height },
        fontSize: style.fontSize,
        positionType: style.position
      };
      
      return score;
    };
    
    const candidates = [];
    
    // Strategy 0: Anchor-Based Extraction (highest priority - find "Live" badge or eye icon, then traverse to number)
    // Find "Live" badge or eye icon (using text content or aria-label)
    const liveIndicators = document.querySelectorAll('*');
    for (const indicator of liveIndicators) {
      const text = indicator.textContent || '';
      const ariaLabel = indicator.getAttribute('aria-label') || '';
      const isLiveIndicator = /^LIVE$/i.test(text.trim()) || 
                             /live/i.test(ariaLabel) ||
                             indicator.querySelector('svg[aria-label*="eye"], svg[aria-label*="view"], [class*="eye-icon"]');
      
      if (isLiveIndicator || indicator.classList.contains('live') || ariaLabel.toLowerCase().includes('live')) {
        // Navigate to nearest sibling/parent containing a number
        // Check next sibling
        let sibling = indicator.nextElementSibling;
        if (sibling) {
          const siblingText = sibling.textContent?.trim() || '';
          const count = parseNumber(siblingText);
          if (count !== null && count > 0 && count < 10000000) {
            // Validate: must be in top-right area and not in chat
            const rect = sibling.getBoundingClientRect();
            const isInChat = sibling.closest('[class*="chat"], [class*="Chat"], [id*="chat"]');
            if (!isInChat && rect.top < 300 && rect.right > window.innerWidth - 300) {
              console.log('[Whatnot Pulse] Found viewer count via anchor-based (Live badge nextSibling):', count);
              return count;
            }
          }
        }
        
        // Check parent for number
        const parent = indicator.parentElement;
        if (parent) {
          const parentText = parent.textContent || '';
          const parentCount = parseNumber(parentText);
          if (parentCount !== null && parentCount > 0 && parentCount < 10000000) {
            const rect = parent.getBoundingClientRect();
            const isInChat = parent.closest('[class*="chat"], [class*="Chat"], [id*="chat"]');
            if (!isInChat && rect.top < 300 && rect.right > window.innerWidth - 300) {
              console.log('[Whatnot Pulse] Found viewer count via anchor-based (Live badge parent):', parentCount);
              return parentCount;
            }
          }
          
          // Check parent's children for number elements
          const numberElements = parent.querySelectorAll('strong, span, div');
          for (const numEl of numberElements) {
            const numText = numEl.textContent?.trim() || '';
            const count = parseNumber(numText);
            if (count !== null && count > 10 && count < 10000000) {
              const rect = numEl.getBoundingClientRect();
              const isInChat = numEl.closest('[class*="chat"], [class*="Chat"], [id*="chat"]');
              if (!isInChat && rect.top < 300 && rect.right > window.innerWidth - 300) {
                console.log('[Whatnot Pulse] Found viewer count via anchor-based (Live badge parent child):', count);
                return count;
              }
            }
          }
        }
        
        // Check previous sibling
        let prevSibling = indicator.previousElementSibling;
        if (prevSibling) {
          const prevText = prevSibling.textContent?.trim() || '';
          const count = parseNumber(prevText);
          if (count !== null && count > 0 && count < 10000000) {
            const rect = prevSibling.getBoundingClientRect();
            const isInChat = prevSibling.closest('[class*="chat"], [class*="Chat"], [id*="chat"]');
            if (!isInChat && rect.top < 300 && rect.right > window.innerWidth - 300) {
              console.log('[Whatnot Pulse] Found viewer count via anchor-based (Live badge prevSibling):', count);
              return count;
            }
          }
        }
      }
    }
    
    // Strategy 1: Whatnot-specific viewer count selector (class-based fallback)
    // The viewer count is in a <strong> tag with specific classes in the live player header
    const livePlayerHeader = document.querySelector('[class*="LivePlayer_livePlayerHeader"]');
    if (livePlayerHeader) {
      // Look for the viewer count: <strong> with tabular-nums and text-neutrals-opaque-50
      const viewerCountEl = livePlayerHeader.querySelector('strong.text-neutrals-opaque-50.tabular-nums, strong.tabular-nums.text-neutrals-opaque-50');
      if (viewerCountEl) {
        const text = viewerCountEl.textContent?.trim() || '';
        const count = parseNumber(text);
        if (count !== null && count > 0 && count < 10000000) {
          console.log('[Whatnot Pulse] Found viewer count via LivePlayer header:', count);
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:733',message:'Viewer count found via LivePlayer header',data:{count,text,strategy:'LivePlayer-header'},timestamp:Date.now(),sessionId:'debug-session',runId:'run10',hypothesisId:'VIEWER_MISMATCH'})}).catch(()=>{});
          // #endregion
          return count;
        }
      }
      
      // Fallback: Look for any number in the header that's not in chat
      const allNumbers = livePlayerHeader.querySelectorAll('strong, span, div');
      for (const el of allNumbers) {
        const text = el.textContent?.trim() || '';
        const count = parseNumber(text);
        if (count !== null && count > 10 && count < 10000000) {
          // Check if it's not in a chat area
          const isInChat = el.closest('[class*="chat"], [class*="Chat"], [id*="chat"]');
          if (!isInChat) {
            // Check if it has the right styling (tabular-nums is a strong indicator)
            const hasTabularNums = el.classList.contains('tabular-nums');
            const hasNeutralsOpaque = el.classList.contains('text-neutrals-opaque-50') || 
                                      el.classList.contains('text-neutrals-opaque-900');
            if (hasTabularNums || hasNeutralsOpaque) {
              console.log('[Whatnot Pulse] Found viewer count via LivePlayer header fallback:', count);
              // #region agent log
              fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:751',message:'Viewer count found via LivePlayer header fallback',data:{count,text,hasTabularNums,hasNeutralsOpaque,strategy:'LivePlayer-header-fallback'},timestamp:Date.now(),sessionId:'debug-session',runId:'run10',hypothesisId:'VIEWER_MISMATCH'})}).catch(()=>{});
              // #endregion
              return count;
            }
          }
        }
      }
    }
    
    // Strategy 1: Data testid attributes (most reliable)
    const dataTestIdSelectors = [
      '[data-testid="viewer-count"]',
      '[data-testid="watching-count"]',
      '[data-testid="live-viewers"]',
      '[data-testid*="viewer"]',
      '[data-testid*="watching"]'
    ];
    
    for (const selector of dataTestIdSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        const text = element.textContent || '';
        const count = parseNumber(text);
        if (count !== null && count > 0 && count < 10000000) {
          const score = scoreElement(element, count);
          if (score >= 0) {
            candidates.push({ element, count, score, strategy: 'data-testid', selector, text: text.substring(0, 50) });
          }
        }
      }
    }
    
    // Strategy 2: Class-based selectors
    const classSelectors = [
      '.viewer-count',
      '.watching-count',
      '.live-viewers',
      '[class*="viewer-count"]',
      '[class*="watching-count"]',
      '[class*="live-viewers"]',
      '[class*="ViewerCount"]',
      '[class*="WatchingCount"]'
    ];
    
    for (const selector of classSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        const text = element.textContent || '';
        const count = parseNumber(text);
        if (count !== null && count > 0 && count < 10000000) {
          const score = scoreElement(element, count);
          if (score >= 0) {
            candidates.push({ element, count, score, strategy: 'class', selector, text: text.substring(0, 50) });
          }
        }
      }
    }
    
    // Strategy 3: Look for elements containing "watching" or "viewers" text
    const allElements = document.querySelectorAll('*');
    for (const element of allElements) {
      const text = element.textContent || '';
      // Look for patterns like "353 watching", "1.2K viewers", etc.
      const watchingMatch = text.match(/([\d.,]+\s*[kKmM]?)\s*(?:watching|viewers?|live)/i);
      if (watchingMatch) {
        const count = parseNumber(watchingMatch[1]);
        if (count !== null && count > 0 && count < 10000000) {
          const score = scoreElement(element, count);
          if (score >= 0) {
            candidates.push({ element, count, score, strategy: 'text-pattern', text: text.substring(0, 50) });
          }
        }
      }
    }
    
    // Strategy 4: Look specifically for red "LIVE" badge area (top-right of video)
    // This is usually where the main viewer count is displayed
    const liveBadgeArea = document.querySelector('[class*="live-badge"], [class*="live-indicator"], [class*="LiveBadge"], [class*="viewer-count"]');
    if (liveBadgeArea) {
      // Look for numbers near the live badge
      const liveBadgeContainer = liveBadgeArea.closest('[class*="live"], [class*="stream"], [class*="player"]') || liveBadgeArea.parentElement;
      if (liveBadgeContainer) {
        // Find all number elements in this container
        const numbers = liveBadgeContainer.querySelectorAll('*');
        for (const numEl of numbers) {
          const text = numEl.textContent || '';
          const count = parseNumber(text);
          if (count !== null && count > 0 && count < 10000000) {
            const style = window.getComputedStyle(numEl);
            const rect = numEl.getBoundingClientRect();
            // Must be visible and in top-right area
            if (style.display !== 'none' && style.visibility !== 'hidden' && 
                rect.top < 200 && rect.right > window.innerWidth - 300) {
              const score = scoreElement(numEl, count);
              if (score >= 0) {
                candidates.push({ element: numEl, count, score: score + 30, strategy: 'live-badge-area', text: text.substring(0, 50) }); // Bonus score
              }
            }
          }
        }
      }
    }
    
    // Sort candidates by score (highest first)
    candidates.sort((a, b) => b.score - a.score);
    
    // Log all candidates for debugging
    console.log('[Whatnot Pulse] Viewer count candidates:', candidates.map(c => `${c.count} (score: ${c.score}, strategy: ${c.strategy})`));
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:796',message:'Viewer count candidates found',data:{candidates:candidates.map(c=>({count:c.count,score:c.score,strategy:c.strategy,text:c.text}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run8',hypothesisId:'H1'})}).catch(()=>{});
    // #endregion
    
    // CRITICAL: If we have multiple candidates, NEVER select a count <= 5 if there's a higher count available
    // This prevents selecting chat participant counts (typically 2-5) when the real viewer count exists
    if (candidates.length > 1) {
      const highestCount = Math.max(...candidates.map(c => c.count));
      const bestCandidate = candidates[0];
      
      // If the best candidate has a low count (<= 5) but there's a much higher count available,
      // prefer the higher count even if it has a slightly lower score
      if (bestCandidate.count <= 5 && highestCount > bestCandidate.count * 5) {
        // Find the candidate with the highest count that has a reasonable score
        const highCountCandidate = candidates.find(c => c.count === highestCount && c.score > 0);
        if (highCountCandidate) {
          console.log('[Whatnot Pulse] Rejecting low count candidate', bestCandidate.count, 'in favor of higher count', highCountCandidate.count, 'to avoid chat participant count');
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:960',message:'Rejecting low count in favor of higher count',data:{rejectedCount:bestCandidate.count,rejectedScore:bestCandidate.score,selectedCount:highCountCandidate.count,selectedScore:highCountCandidate.score,highestCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run8',hypothesisId:'H1'})}).catch(()=>{});
          // #endregion
          candidates[0] = highCountCandidate;
          // Re-sort to ensure the selected candidate is first
          candidates.sort((a, b) => b.score - a.score);
        }
      }
    }
    
    // Return the highest scoring candidate (must have positive score)
    if (candidates.length > 0 && candidates[0].score > 0) {
      const best = candidates[0];
      console.log('[Whatnot Pulse] Selected viewer count:', best.count, 'from', best.strategy, '(score:', best.score + ')');
      
      // Log top 3 candidates with detailed scoring for debugging
      const topCandidates = candidates.slice(0, 3).map(c => ({
        count: c.count,
        score: c.score,
        strategy: c.strategy,
        text: c.text?.substring(0, 50)
      }));
      
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:976',message:'Viewer count selected',data:{selectedCount:best.count,selectedScore:best.score,selectedStrategy:best.strategy,selectedText:best.text,topCandidates,allCandidatesCount:candidates.length,allCandidates:candidates.map(c=>({count:c.count,score:c.score,strategy:c.strategy}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run8',hypothesisId:'H1'})}).catch(()=>{});
      // #endregion
      return best.count;
    }
    
    // Fallback: Search page text for common patterns (but exclude chat area)
    const pageText = document.body.innerText || document.body.textContent || '';
    const patterns = [
      /([\d.,]+\s*[kKmM]?)\s*watching/i,
      /([\d.,]+\s*[kKmM]?)\s*viewers?/i,
      /watching[:\s]+([\d.,]+\s*[kKmM]?)/i,
      /viewers?[:\s]+([\d.,]+\s*[kKmM]?)/i
    ];
    
    // Try to find numbers in video area only (not chat)
    const videoArea = document.querySelector('[class*="video"], [class*="player"], [class*="stream"], video');
    const searchText = videoArea ? (videoArea.innerText || videoArea.textContent || '') : pageText;
    
    for (const pattern of patterns) {
      const match = searchText.match(pattern);
      if (match) {
        const count = parseNumber(match[1]);
        // Prefer higher counts (main count vs chat count)
        if (count !== null && count > 10 && count < 10000000) {
          console.log('[Whatnot Pulse] Found viewer count via page text fallback →', count);
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:824',message:'Viewer count found via page text fallback',data:{count,pattern:pattern.toString()},timestamp:Date.now(),sessionId:'debug-session',runId:'run4',hypothesisId:'VIEWER_MISMATCH'})}).catch(()=>{});
          // #endregion
          return count;
        }
      }
    }
    
    // Final fallback: Look for any number in the top-right area of the video player
    // This is a last resort when all other methods fail
    if (candidates.length === 0) {
      const videoPlayer = document.querySelector('video, [class*="video-player"], [class*="stream-player"]');
      if (videoPlayer) {
        const videoRect = videoPlayer.getBoundingClientRect();
        // Look for numbers in top-right quadrant of video
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          
          // Check if element is in top-right area of video player
          if (rect.top >= videoRect.top && rect.top <= videoRect.top + 200 &&
              rect.right >= videoRect.right - 300 && rect.right <= videoRect.right + 50) {
            const text = el.textContent?.trim() || '';
            const count = parseNumber(text);
            if (count !== null && count > 10 && count < 10000000) {
              // Exclude chat area
              const isInChat = el.closest('[class*="chat"], [id*="chat"]');
              if (!isInChat) {
                console.log('[Whatnot Pulse] Found viewer count via final fallback (top-right video area):', count);
    // #region agent log
                fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1000',message:'Viewer count found via final fallback',data:{count,text:text.substring(0,50)},timestamp:Date.now(),sessionId:'debug-session',runId:'run6',hypothesisId:'H1'})}).catch(()=>{});
    // #endregion
                return count;
              }
            }
          }
        }
      }
    }
    
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1020',message:'Viewer count extraction FAILED',data:{candidatesCount:candidates.length,url:window.location.href},timestamp:Date.now(),sessionId:'debug-session',runId:'run6',hypothesisId:'H1'})}).catch(()=>{});
    // #endregion
    // Don't log warning - extraction failures are expected sometimes, just return null
    return null; // Return null instead of 0 to indicate "not found" vs "zero viewers"
  }

  /**
   * Check if we're on a live stream page
   */
  function isLiveStreamPage() {
    const pathname = window.location.pathname;
    const isLive = pathname.startsWith('/live/');
    console.log('[Whatnot Pulse] isLiveStreamPage check - pathname:', pathname, 'result:', isLive);
    return isLive;
  }

  /**
   * Check if we're on a user profile page
   */
  function isProfilePage() {
    const pathname = window.location.pathname;
    // Profile pages: /user/username or /user/username/about, etc.
    const isProfile = pathname.match(/^\/user\/[^\/]+/);
    return !!isProfile && !pathname.startsWith('/live/');
  }

  /**
   * Extract profile data from a user profile page
   */
  function extractProfileData() {
    if (!isProfilePage()) {
      return null;
    }

    try {
      const username = extractStreamerUsername(); // Reuse streamer extraction logic
      if (!username) {
        return null;
      }

      // Extract followers count using anchor-based approach (text-first, then traverse DOM)
      let followers = null;
      console.log('[Whatnot Pulse] Extracting followers count using anchor-based approach...');
      
      // Strategy 0: Anchor-Based Extraction (highest priority)
      // Step 1: Find element containing exact text "Followers" (case-insensitive)
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const text = el.textContent || '';
        const trimmedText = text.trim();
        
        // Check if this element contains "Followers" text
        if (!/\bFollowers?\b/i.test(trimmedText)) {
          continue;
        }
        
        // Step 2: Traverse DOM from this element to find the number
        // Check previousElementSibling for number
        let sibling = el.previousElementSibling;
        if (sibling) {
          const siblingText = sibling.textContent?.trim() || '';
          const numMatch = siblingText.match(/^([\d.,]+[kKmM]?)$/i);
          if (numMatch) {
            const countStr = numMatch[1].replace(/,/g, '').trim();
            let count = parseFollowerCount(countStr);
            if (count !== null && count > 0 && count < 100000000) {
              followers = count;
              console.log('[Whatnot Pulse] Found followers via anchor-based (previousSibling):', followers);
              break;
            }
          }
        }
        
        // Check parentElement for strong tag with number
        const parent = el.parentElement;
        if (parent) {
          const strongInParent = parent.querySelector('strong');
          if (strongInParent) {
            const strongText = strongInParent.textContent?.trim() || '';
            const numMatch = strongText.match(/^([\d.,]+[kKmM]?)$/i);
            if (numMatch) {
              const countStr = numMatch[1].replace(/,/g, '').trim();
              let count = parseFollowerCount(countStr);
              if (count !== null && count > 0 && count < 100000000) {
                followers = count;
                console.log('[Whatnot Pulse] Found followers via anchor-based (parent strong):', followers);
                break;
              }
            }
          }
          
          // Check parent's previous sibling
          const parentSibling = parent.previousElementSibling;
          if (parentSibling) {
            const parentSiblingText = parentSibling.textContent?.trim() || '';
            const numMatch = parentSiblingText.match(/^([\d.,]+[kKmM]?)$/i);
            if (numMatch) {
              const countStr = numMatch[1].replace(/,/g, '').trim();
              let count = parseFollowerCount(countStr);
              if (count !== null && count > 0 && count < 100000000) {
                followers = count;
                console.log('[Whatnot Pulse] Found followers via anchor-based (parentSibling):', followers);
                break;
              }
            }
          }
        }
        
        // Check nextElementSibling for number
        let nextSibling = el.nextElementSibling;
        if (nextSibling) {
          const nextSiblingText = nextSibling.textContent?.trim() || '';
          const numMatch = nextSiblingText.match(/^([\d.,]+[kKmM]?)$/i);
          if (numMatch) {
            const countStr = numMatch[1].replace(/,/g, '').trim();
            let count = parseFollowerCount(countStr);
            if (count !== null && count > 0 && count < 100000000) {
              followers = count;
              console.log('[Whatnot Pulse] Found followers via anchor-based (nextSibling):', followers);
              break;
            }
          }
        }
        
        // Check parentElement.parentElement for nested structure
        const grandParent = parent?.parentElement;
        if (grandParent) {
          const strongInGrandParent = grandParent.querySelector('strong');
          if (strongInGrandParent && !strongInGrandParent.contains(el)) {
            const strongText = strongInGrandParent.textContent?.trim() || '';
            const numMatch = strongText.match(/^([\d.,]+[kKmM]?)$/i);
            if (numMatch) {
              const countStr = numMatch[1].replace(/,/g, '').trim();
              let count = parseFollowerCount(countStr);
              if (count !== null && count > 0 && count < 100000000) {
                followers = count;
                console.log('[Whatnot Pulse] Found followers via anchor-based (grandParent strong):', followers);
                break;
              }
            }
          }
        }
        
        // Also try extracting from the same element if it contains the number
        const sameElementMatch = trimmedText.match(/([\d.,]+[kKmM]?)\s*Followers?/i);
        if (sameElementMatch) {
          const countStr = sameElementMatch[1].replace(/,/g, '').trim();
          let count = parseFollowerCount(countStr);
          if (count !== null && count > 0 && count < 100000000) {
            followers = count;
            console.log('[Whatnot Pulse] Found followers via anchor-based (same element):', followers);
            break;
          }
        }
      }
      
      // Helper function to parse follower count with K/M suffixes
      function parseFollowerCount(countStr) {
        if (!countStr) return null;
        const clean = countStr.replace(/,/g, '').trim();
        if (clean.toLowerCase().endsWith('k')) {
          return Math.round(parseFloat(clean) * 1000);
        } else if (clean.toLowerCase().endsWith('m')) {
          return Math.round(parseFloat(clean) * 1000000);
        } else {
          const parsed = parseInt(clean, 10);
          return isNaN(parsed) ? null : parsed;
        }
      }
      
      // Strategy 1: Look for elements with follower count in text (including K/M suffixes)
      const followerTextPatterns = [
        /([\d,.]+[kKmM]?)\s*(followers?|follower)/i,
        /(followers?|follower)[:\s]+([\d,.]+[kKmM]?)/i,
        /([\d,.]+[kKmM]?)\s*(follower)/i
      ];
      
      // Try to find follower count in visible text elements
      const allTextElements = document.querySelectorAll('*');
      for (const el of allTextElements) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        
        const text = el.textContent || '';
        for (const pattern of followerTextPatterns) {
          const match = text.match(pattern);
          if (match) {
            const countStr = (match[1] || match[2] || '').replace(/,/g, '').trim();
            if (countStr) {
              // Handle K/M suffixes
              let count = 0;
              if (countStr.toLowerCase().endsWith('k')) {
                count = Math.round(parseFloat(countStr) * 1000);
              } else if (countStr.toLowerCase().endsWith('m')) {
                count = Math.round(parseFloat(countStr) * 1000000);
              } else {
                count = parseInt(countStr, 10);
              }
              if (!isNaN(count) && count > 0 && count < 100000000) {
                followers = count;
                console.log('[Whatnot Pulse] Found followers via text pattern:', followers, 'from:', text.substring(0, 100));
                break;
              }
            }
          }
        }
        if (followers) break;
      }
      
      // Strategy 2: Look for data-testid or class-based selectors
      if (!followers) {
      const followerSelectors = [
        '[data-testid*="follower"]',
        '[class*="follower"]',
          '[class*="Follower"]',
          '[aria-label*="follower"]'
      ];
      
      for (const selector of followerSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.textContent || '';
            const match = text.match(/([\d,.]+[kKmM]?)/);
          if (match) {
              const countStr = match[1].replace(/,/g, '').trim();
              let count = 0;
              if (countStr.toLowerCase().endsWith('k')) {
                count = Math.round(parseFloat(countStr) * 1000);
              } else if (countStr.toLowerCase().endsWith('m')) {
                count = Math.round(parseFloat(countStr) * 1000000);
              } else {
                count = parseInt(countStr, 10);
              }
              if (!isNaN(count) && count > 0 && count < 100000000) {
                followers = count;
                console.log('[Whatnot Pulse] Found followers via selector:', selector, '=', followers);
            break;
              }
          }
        }
        if (followers) break;
        }
      }
      
      // Strategy 3: Look in profile stats sections
      if (!followers) {
        const statsSections = document.querySelectorAll('[class*="stat"], [class*="Stat"], [class*="profile-stat"]');
        for (const section of statsSections) {
          const text = section.textContent || '';
          if (text.toLowerCase().includes('follower')) {
            const match = text.match(/([\d,.]+[kKmM]?)/);
            if (match) {
              const countStr = match[1].replace(/,/g, '').trim();
              let count = 0;
              if (countStr.toLowerCase().endsWith('k')) {
                count = Math.round(parseFloat(countStr) * 1000);
              } else if (countStr.toLowerCase().endsWith('m')) {
                count = Math.round(parseFloat(countStr) * 1000000);
              } else {
                count = parseInt(countStr, 10);
              }
              if (!isNaN(count) && count > 0) {
                followers = count;
                console.log('[Whatnot Pulse] Found followers in stats section:', followers);
                break;
              }
            }
          }
        }
      }
      
      if (followers === null) {
        console.warn('[Whatnot Pulse] Could not extract followers count - trying additional fallback strategies');
        // #region agent log
        const pageText = document.body.innerText || document.body.textContent || '';
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1227',message:'Followers extraction failed, trying fallback',data:{url:window.location.href,pageTextLength:pageText.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run9',hypothesisId:'H2'})}).catch(()=>{});
        // #endregion
        
        // Fallback: Look for any number followed by "followers" in the entire page text
        // This is less precise but should catch follower counts displayed in various ways
        const fallbackPatterns = [
          /(\d{1,3}(?:,\d{3})*(?:\.\d+)?[kKmM]?)\s*followers?/gi,
          /followers?[:\s]*(\d{1,3}(?:,\d{3})*(?:\.\d+)?[kKmM]?)/gi
        ];
        
        for (const pattern of fallbackPatterns) {
          const matches = pageText.matchAll(pattern);
          for (const match of matches) {
            const numText = match[1] || match[2];
            if (numText) {
              const countStr = numText.replace(/,/g, '').trim();
              let count = 0;
              if (countStr.toLowerCase().endsWith('k')) {
                count = Math.round(parseFloat(countStr) * 1000);
              } else if (countStr.toLowerCase().endsWith('m')) {
                count = Math.round(parseFloat(countStr) * 1000000);
              } else {
                count = parseInt(countStr, 10);
              }
              if (!isNaN(count) && count > 0 && count < 100000000) {
                followers = count;
                console.log('[Whatnot Pulse] Found followers via fallback pattern:', followers, 'from:', match[0].substring(0, 50));
                // #region agent log
                fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1252',message:'Followers found via fallback',data:{followers,match:match[0].substring(0,50)},timestamp:Date.now(),sessionId:'debug-session',runId:'run9',hypothesisId:'H2'})}).catch(()=>{});
                // #endregion
                break;
              }
            }
          }
          if (followers) break;
        }
      } else {
        console.log('[Whatnot Pulse] Successfully extracted followers:', followers);
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1263',message:'Followers extraction successful',data:{followers},timestamp:Date.now(),sessionId:'debug-session',runId:'run9',hypothesisId:'H2'})}).catch(()=>{});
        // #endregion
      }

      // Extract rating
      let rating = null;
      const ratingElements = document.querySelectorAll('[class*="star"], [class*="rating"], [aria-label*="star"]');
      for (const el of ratingElements) {
        const text = el.textContent || '';
        const match = text.match(/([\d.]+)/);
        if (match) {
          rating = parseFloat(match[1]);
          break;
        }
      }

      // Extract category
      let category = null;
      const categoryElements = document.querySelectorAll('[class*="category"], [data-testid*="category"]');
      for (const el of categoryElements) {
        const text = el.textContent?.trim();
        if (text && text.length < 50) {
          category = text;
          break;
        }
      }

      // Extract avatar URL
      let avatarUrl = null;
      const avatarSelectors = [
        'img[class*="avatar"]',
        'img[class*="profile"]',
        '[class*="avatar"] img',
        '[class*="profile-picture"] img',
        'img[src*="avatar"]',
        'img[src*="profile"]'
      ];
      
      for (const selector of avatarSelectors) {
        const avatarEl = document.querySelector(selector);
        if (avatarEl && avatarEl.src) {
          avatarUrl = avatarEl.src;
          // Prefer higher resolution if available
          if (avatarUrl && (avatarUrl.includes('large') || avatarUrl.includes('hq'))) {
            break; // Exit loop if we found a high-res avatar
          }
        }
      }
      
      // Fallback: look for any profile image
      if (!avatarUrl) {
        const profileImg = document.querySelector('img[alt*="profile"], img[alt*="avatar"]');
        if (profileImg && profileImg.src) {
          avatarUrl = profileImg.src;
        }
      }

      return {
        username,
        followers,
        rating,
        category,
        avatar_url: avatarUrl,
        profile_url: window.location.href,
        scraped_at: new Date().toISOString()
      };
    } catch (error) {
      console.error('[Whatnot Pulse] Error extracting profile data:', error);
      return null;
    }
  }

  /**
   * Extract scheduled live streams from profile page
   */
  function extractScheduledLives() {
    // Check if extension context is still valid before proceeding
    try {
      // Try to access chrome.runtime to check if context is valid
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        console.warn('[Whatnot Pulse] Extension context invalidated, skipping scheduled lives extraction');
        return [];
      }
    } catch (e) {
      console.warn('[Whatnot Pulse] Extension context check failed:', e);
      return [];
    }
    
    if (!isProfilePage()) {
      return [];
    }

    try {
      const scheduledLives = [];
      
      // Look for scheduled live stream elements
      // Common patterns: "Upcoming", "Scheduled", "Next Live", calendar/clock icons
      const scheduledSelectors = [
        '[class*="scheduled"]',
        '[class*="upcoming"]',
        '[class*="next-live"]',
        '[data-testid*="scheduled"]',
        '[data-testid*="upcoming"]',
        '[class*="event"]',
        '[class*="show"]'
      ];

      // First, try to find any links to /live/ pages (these could be scheduled)
      const allLiveLinks = document.querySelectorAll('a[href*="/live/"]');
      console.log('[Whatnot Pulse] Found', allLiveLinks.length, 'live links on profile page');
      
      for (const link of allLiveLinks) {
        try {
          const href = link.getAttribute('href');
          if (!href) continue; // Skip if no href
          
          // Extract streamId - look for TGl2ZVNob3dOb2RlOi... pattern first (base64 ID)
          let streamId = null;
          try {
            const base64Match = href.match(/TGl2ZVNob3dOb2RlOi?([A-Za-z0-9_-]+)/);
            if (base64Match) {
              streamId = base64Match[0]; // Full ID including prefix
            } else {
              // Fallback to extracting from /live/ path
              const match = href.match(/\/live\/([^\/\?]+)/);
              if (match && match[1]) {
                streamId = match[1];
              }
            }
          } catch (matchError) {
            console.warn('[Whatnot Pulse] Error matching regex in extractScheduledLives:', matchError);
            continue; // Skip this link if regex fails
          }
        
        if (streamId) {
          
          // Check if this link is in a scheduled/upcoming container
          const container = link.closest('[class*="scheduled"], [class*="upcoming"], [class*="event"], [class*="show"]');
          
          // Try to extract scheduled time
          let scheduledTime = null;
          let title = null;
          
          if (container) {
            const timeElement = container.querySelector('[class*="time"], [class*="date"], [datetime], time');
            if (timeElement) {
              const datetime = timeElement.getAttribute('datetime') || timeElement.getAttribute('dateTime') || timeElement.textContent;
              if (datetime) {
                scheduledTime = datetime;
              }
            }
            
            const titleElement = container.querySelector('[class*="title"], h3, h4, h5');
            if (titleElement) {
              title = titleElement.textContent?.trim();
            }
          } else {
            // If not in a container, check nearby elements
            const parent = link.parentElement;
            if (parent) {
              const timeElement = parent.querySelector('[class*="time"], [class*="date"], [datetime]');
              if (timeElement) {
                scheduledTime = timeElement.getAttribute('datetime') || timeElement.textContent;
              }
            }
          }

          scheduledLives.push({
            stream_id: streamId,
            stream_url: href.startsWith('http') ? href : `https://www.whatnot.com${href}`,
            scheduled_time: scheduledTime,
            title: title,
            scraped_at: new Date().toISOString()
          });
        }
        } catch (linkError) {
          // Skip this link if there's an error processing it
          console.warn('[Whatnot Pulse] Error processing scheduled live link:', linkError);
          continue;
        }
      }

      return scheduledLives;
    } catch (error) {
      console.error('[Whatnot Pulse] Error extracting scheduled lives:', error);
      return [];
    }
  }

  /**
   * Initialize profile scraping - extract profile data and scheduled lives
   */
  function initializeProfileScraping() {
    // Check if extension context is valid before proceeding
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        console.warn('[Whatnot Pulse] Extension context invalidated, skipping profile scraping');
        return;
      }
    } catch (e) {
      console.warn('[Whatnot Pulse] Extension context check failed:', e);
      return;
    }
    
    console.log('[Whatnot Pulse] Initializing profile scraping...');
    
    try {
      // Extract profile data
      const profileData = extractProfileData();
      if (profileData) {
        console.log('[Whatnot Pulse] Profile data extracted:', profileData);
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1436',message:'Profile data extracted',data:{username:profileData.username,followers:profileData.followers,category:profileData.category,hasAvatar:!!profileData.avatar_url},timestamp:Date.now(),sessionId:'debug-session',runId:'run9',hypothesisId:'H2'})}).catch(()=>{});
        // #endregion
        
        try {
          safeSendMessage({
            type: 'PROFILE_DATA',
            data: profileData
          }, (response) => {
            // #region agent log
            fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1444',message:'PROFILE_DATA message sent',data:{hasError:!!chrome.runtime.lastError,error:chrome.runtime.lastError?.message,hasResponse:!!response,username:profileData.username,followers:profileData.followers},timestamp:Date.now(),sessionId:'debug-session',runId:'run9',hypothesisId:'H2'})}).catch(()=>{});
            // #endregion
            
            try {
              if (chrome.runtime.lastError) {
                console.warn('[Whatnot Pulse] Could not send profile data:', chrome.runtime.lastError.message);
              } else {
                console.log('[Whatnot Pulse] Profile data sent successfully, response:', response);
              }
            } catch (e) {
              console.warn('[Whatnot Pulse] Extension context invalidated in PROFILE_DATA callback:', e);
            }
          });
        } catch (e) {
          console.warn('[Whatnot Pulse] Could not send PROFILE_DATA (context invalidated):', e);
        }
      } else {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1460',message:'Profile data extraction returned null',data:{url:window.location.href},timestamp:Date.now(),sessionId:'debug-session',runId:'run9',hypothesisId:'H2'})}).catch(()=>{});
        // #endregion
        console.warn('[Whatnot Pulse] Failed to extract profile data');
      }

      // Extract scheduled lives
      const scheduledLives = extractScheduledLives();
      if (scheduledLives.length > 0) {
        console.log('[Whatnot Pulse] Found scheduled lives:', scheduledLives);
        safeSendMessage({
          type: 'SCHEDULED_LIVES',
          data: scheduledLives
        }, (response) => {
          if (response && response.error) {
            console.warn('[Whatnot Pulse] Could not send scheduled lives:', response.error);
          }
        });
      }
    } catch (error) {
      console.warn('[Whatnot Pulse] Error in profile scraping:', error);
      // Don't rethrow - just log and continue
    }
  }

  /**
   * Initialize stream tracking - extract streamer username, title, viewer count
   */
  function initializeStreamTracking() {
    console.log('[Whatnot Pulse] initializeStreamTracking called');
    
    if (!isLiveStreamPage()) {
      console.log('[Whatnot Pulse] Not on live page, aborting stream tracking');
      return false;
    }

    console.log('[Whatnot Pulse] Extracting streamer username...');
    const username = extractStreamerUsername();
    console.log('[Whatnot Pulse] Extracted username:', username);
    // #region agent log
    const loggedInUser = detectLoggedInUser();
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:528',message:'extractStreamerUsername returned',data:{username:username||'null',loggedInUser:loggedInUser||'none',isWrongUser:username===loggedInUser},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
    // #endregion
    
    if (!username) {
      console.warn('[Whatnot Pulse] Could not detect streamer username, retrying in 2s...');
      setTimeout(initializeStreamTracking, 2000);
      return false;
    }

    streamerUsername = username;
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:536',message:'FINAL streamer username set',data:{streamerUsername:username,loggedInUser:loggedInUser||'none'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
    // #endregion
    
    console.log('[Whatnot Pulse] Extracting stream title...');
    const title = getStreamTitle();
    console.log('[Whatnot Pulse] Extracted title:', title);
    
    console.log('[Whatnot Pulse] Extracting viewer count...');
      const viewerCount = getViewerCount();
      const pendingItems = extractPendingItemsCount();
      const streamStartTime = getStreamStartTime();
      console.log('[Whatnot Pulse] Extracted viewer count:', viewerCount, '(type:', typeof viewerCount, ')', 'pending items:', pendingItems, 'stream start:', streamStartTime);
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1046',message:'Stream tracking - extracted values',data:{viewerCount,viewerCountType:typeof viewerCount,pendingItems,streamStartTime},timestamp:Date.now(),sessionId:'debug-session',runId:'run3',hypothesisId:'VIEWER_MISMATCH,STREAM_START'})}).catch(()=>{});
      // #endregion
    
    const streamUrl = window.location.href;

    console.log('[Whatnot Pulse] Stream detected - Full data:', {
      username: streamerUsername,
      title,
      viewerCount,
      pendingItems,
      url: streamUrl
    });

    // Store in chrome.storage
    chrome.storage.local.set({ 
      current_streamer_username: streamerUsername 
    });
    console.log('[Whatnot Pulse] Stored streamer username in chrome.storage');

    // Notify background script with full stream data
    console.log('[Whatnot Pulse] Sending STREAM_DETECTED message to background script...');
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1507',message:'About to send STREAM_DETECTED',data:{username:streamerUsername,viewerCount,title,streamUrl,streamStartTime},timestamp:Date.now(),sessionId:'debug-session',runId:'run7',hypothesisId:'H5'})}).catch(()=>{});
    // #endregion
    
    // Use safeSendMessage instead of direct check + sendMessage
    safeSendMessage({
      type: 'STREAM_DETECTED',
      data: {
        username: streamerUsername,
        title: title,
        viewerCount: viewerCount,
        pendingItems: pendingItems,
        url: streamUrl,
        stream_start_time: streamStartTime
      }
    }, (response) => {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1704',message:'STREAM_DETECTED callback',data:{hasError:!!(response && response.error),error:response?.error,hasResponse:!!response},timestamp:Date.now(),sessionId:'debug-session',runId:'run7',hypothesisId:'H5'})}).catch(()=>{});
        // #endregion
        
        if (response && response.error) {
          // Error already handled in safeSendMessage, just log if not context invalidated
          if (!response.error.includes('Extension context invalidated')) {
            console.error('[Whatnot Pulse] Error sending STREAM_DETECTED message:', response.error);
          }
        } else {
          console.log('[Whatnot Pulse] STREAM_DETECTED message sent successfully, response:', response);
        }
      });

    // Start periodic viewer count updates
    startViewerCountUpdates();
    console.log('[Whatnot Pulse] Started viewer count updates');
    
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1545',message:'initializeStreamTracking completed',data:{streamerUsername,viewerCount,title,streamUrl,streamStartTime},timestamp:Date.now(),sessionId:'debug-session',runId:'run7',hypothesisId:'H5'})}).catch(()=>{});
    // #endregion

    return true;
  }

  /**
   * Start periodic viewer count monitoring
   */
  // Helper to check if extension context is valid
  function isExtensionContextValid() {
    try {
      // Check if chrome.runtime exists and has an ID
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        return false;
      }
      // lastError might be set from previous operations, so we can't rely on it
      // Just check if we can access runtime.id which means context is valid
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Safe wrapper for chrome.runtime.sendMessage
   * Validates extension context before sending to prevent "Extension context invalidated" errors
   */
  function safeSendMessage(message, callback) {
    try {
      // Check if extension context is valid
      if (!chrome.runtime?.id) {
        console.warn('[Whatnot Pulse] Extension context invalid, cannot send message');
        if (callback) callback({ error: 'Context invalidated' });
        return;
      }
      
      chrome.runtime.sendMessage(message, (response) => {
        try {
          if (chrome.runtime.lastError) {
            // Only log if not context invalidated (expected on reload)
            if (!chrome.runtime.lastError.message.includes('Extension context invalidated')) {
              console.error('[Whatnot Pulse] Error sending message:', chrome.runtime.lastError);
            }
            if (callback) callback({ error: chrome.runtime.lastError.message });
          } else {
            if (callback) callback(response);
          }
        } catch (e) {
          // Silently handle context invalidated
          if (!e.message || !e.message.includes('Extension context invalidated')) {
            console.warn('[Whatnot Pulse] Error in message callback:', e);
          }
          if (callback) callback({ error: e.message });
        }
      });
    } catch (e) {
      // Silently handle context invalidated (expected on reload)
      if (!e.message || !e.message.includes('Extension context invalidated')) {
        console.warn('[Whatnot Pulse] Could not send message:', e);
      }
      if (callback) callback({ error: e.message });
    }
  }

  function startViewerCountUpdates() {
    // Clear existing interval
    if (viewerCountUpdateInterval) {
      clearInterval(viewerCountUpdateInterval);
    }

    // Update viewer count every 30 seconds
    viewerCountUpdateInterval = setInterval(() => {
      if (!isLiveStreamPage() || !streamerUsername) {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1551',message:'Viewer count update skipped - not on live page or no streamer',data:{isLivePage:isLiveStreamPage(),streamerUsername},timestamp:Date.now(),sessionId:'debug-session',runId:'run7',hypothesisId:'H5'})}).catch(()=>{});
        // #endregion
        stopViewerCountUpdates();
        return;
      }

      // Check if extension context is still valid before proceeding
      if (!isExtensionContextValid()) {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1557',message:'Viewer count update skipped - extension context invalid',data:{streamerUsername},timestamp:Date.now(),sessionId:'debug-session',runId:'run7',hypothesisId:'H5'})}).catch(()=>{});
        // #endregion
        stopViewerCountUpdates();
        return;
      }

      const viewerCount = getViewerCount();
      const pendingItems = extractPendingItemsCount();
      const streamStartTime = getStreamStartTime();
      
      // Log extraction results
      console.log('[Whatnot Pulse] Extracted viewer count:', viewerCount, 'pending:', pendingItems, 'stream start:', streamStartTime);
      
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1557',message:'Sending VIEWER_COUNT_UPDATE',data:{viewerCount,viewerCountType:typeof viewerCount,pendingItems,streamStartTime},timestamp:Date.now(),sessionId:'debug-session',runId:'run6',hypothesisId:'H1,H4'})}).catch(()=>{});
      // #endregion
      
      // Double-check context before sending
      if (!isExtensionContextValid()) {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1590',message:'Extension context invalid, stopping viewer count updates',data:{viewerCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run7',hypothesisId:'H5'})}).catch(()=>{});
        // #endregion
        stopViewerCountUpdates();
        return;
      }
      
      try {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1595',message:'About to send VIEWER_COUNT_UPDATE message',data:{viewerCount,viewerCountType:typeof viewerCount,pendingItems,streamStartTime,streamerUsername},timestamp:Date.now(),sessionId:'debug-session',runId:'run7',hypothesisId:'H5'})}).catch(()=>{});
        // #endregion
        
        safeSendMessage({
          type: 'VIEWER_COUNT_UPDATE',
          viewerCount: viewerCount, // Can be null if not found
          pendingItems: pendingItems,
          stream_start_time: streamStartTime
        }, (response) => {
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1865',message:'VIEWER_COUNT_UPDATE callback',data:{hasError:!!(response && response.error),error:response?.error,hasResponse:!!response},timestamp:Date.now(),sessionId:'debug-session',runId:'run7',hypothesisId:'H5'})}).catch(()=>{});
          // #endregion
          
          // Handle errors
          if (response && response.error) {
            if (response.error.includes('Extension context invalidated')) {
              stopViewerCountUpdates();
              return; // Don't log - this is expected
            }
            // Only log non-context errors
            console.warn('[Whatnot Pulse] Could not send viewer count update:', response.error);
            stopViewerCountUpdates();
          }
        });
      } catch (e) {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1880',message:'Error sending VIEWER_COUNT_UPDATE',data:{error:e.message,viewerCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run7',hypothesisId:'H5'})}).catch(()=>{});
        // #endregion
        
        // Silently handle context invalidated (expected)
        if (e.message && e.message.includes('Extension context invalidated')) {
          stopViewerCountUpdates();
          return;
        }
        console.warn('[Whatnot Pulse] Error sending viewer count update:', e);
        stopViewerCountUpdates();
      }
    }, 30000);
  }

  /**
   * Stop viewer count updates
   */
  function stopViewerCountUpdates() {
    if (viewerCountUpdateInterval) {
      clearInterval(viewerCountUpdateInterval);
      viewerCountUpdateInterval = null;
    }
  }

  /**
   * Start periodic polling for sales (backup to MutationObserver)
   */
  function startSalesPolling(container) {
    // Clear existing polling interval
    if (salesPollingInterval) {
      clearInterval(salesPollingInterval);
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:889',message:'Cleared existing polling interval',data:{hadInterval:true},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
    }

    console.log('[Whatnot Pulse] Starting periodic sales polling (every', CONFIG.POLLING_INTERVAL / 1000, 'seconds)');
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:889',message:'startSalesPolling called',data:{pollingInterval:CONFIG.POLLING_INTERVAL,intervalSeconds:CONFIG.POLLING_INTERVAL/1000,hasContainer:!!container,containerTag:container?.tagName||'null'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
    // #endregion
    
    // Run first poll immediately, then set interval
    const runPoll = async () => {
      if (!isLiveStreamPage() || !streamerUsername) {
        console.log('[Whatnot Pulse] Stopping polling - not on live page or no streamer');
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:889',message:'Polling stopped - conditions not met',data:{isLivePage:isLiveStreamPage(),hasStreamer:!!streamerUsername},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        stopSalesPolling();
        return;
      }

      // Ensure Sold filter is still active (in case user changed it) - every 3rd poll
      const pollCount = (runPoll.count || 0) + 1;
      runPoll.count = pollCount;
      if (pollCount % 3 === 0) { // Check filter every 3 polls (every 15 seconds)
        await ensureSoldFilterActive();
        await new Promise(resolve => setTimeout(resolve, 500)); // Wait for filter to apply
      }
      
      // Re-find container in case DOM changed
      let currentContainer = container || findSalesContainer();
      
      // If still not found, ensure filter is active and wait a bit
      if (!currentContainer) {
        await ensureSoldFilterActive();
        await new Promise(resolve => setTimeout(resolve, 500));
        currentContainer = findSalesContainer();
      }
      
      if (!currentContainer) {
        // Sales container not found - this is expected sometimes, continue without it
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:897',message:'Sales container NOT found during polling',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        return;
      }

      // Find all sale cards with buyer details
      const buyerDetailElements = currentContainer.querySelectorAll('[data-testid="show-buyer-details"]');
      const currentSalesCount = buyerDetailElements.length;
      
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:861',message:'Periodic sales polling check',data:{currentSalesCount,lastSalesCount,newSalesDetected:currentSalesCount>lastSalesCount,containerFound:!!currentContainer},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion

      // If we detected new sales, process them
      if (currentSalesCount > lastSalesCount) {
        const newCount = currentSalesCount - lastSalesCount;
        console.log(`[Whatnot Pulse] Polling detected ${newCount} new sale(s)`);
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:868',message:'NEW SALES DETECTED via polling',data:{newCount,currentSalesCount,lastSalesCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        
        // Get all sale elements
        const saleElements = [];
        for (const buyerEl of buyerDetailElements) {
          const saleContainer = buyerEl.closest('div.py-4, section, div[class*="py"]');
          if (saleContainer && !saleElements.includes(saleContainer)) {
            saleElements.push(saleContainer);
          }
        }
        
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:877',message:'Processing new sales from polling',data:{saleElementCount:saleElements.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        
        // Process all elements (deduplication will handle duplicates)
        processNewSales(saleElements);
        lastSalesCount = currentSalesCount;
      } else if (currentSalesCount < lastSalesCount) {
        // Sales count decreased (page might have refreshed or filtered)
        console.log(`[Whatnot Pulse] Sales count changed from ${lastSalesCount} to ${currentSalesCount}`);
        lastSalesCount = currentSalesCount;
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:888',message:'Sales count decreased - updating baseline',data:{currentSalesCount,lastSalesCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
      }
    };
    
    // Run immediately, then set interval
    runPoll().catch(err => console.error('[Whatnot Pulse] Error in initial poll:', err));
    salesPollingInterval = setInterval(() => {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:981',message:'Polling interval tick',data:{intervalId:!!salesPollingInterval,isLivePage:isLiveStreamPage(),hasStreamer:!!streamerUsername},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      runPoll().catch(err => console.error('[Whatnot Pulse] Error in polling:', err));
    }, CONFIG.POLLING_INTERVAL);
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:984',message:'Polling interval SET',data:{intervalId:!!salesPollingInterval,intervalMs:CONFIG.POLLING_INTERVAL},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
    // #endregion
  }

  /**
   * Stop periodic sales polling
   */
  function stopSalesPolling() {
    if (salesPollingInterval) {
      clearInterval(salesPollingInterval);
      salesPollingInterval = null;
      console.log('[Whatnot Pulse] Stopped periodic sales polling');
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:989',message:'stopSalesPolling called - interval cleared',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
    }
  }

  /**
   * Harvest full sales history with aggressive auto-scroll
   * Uses setInterval to continuously scroll until no new items load
   * More aggressive than loadAllSalesByScrolling - uses interval-based scrolling
   * @param {HTMLElement} container - The sales container element
   * @returns {Promise<void>}
   */
  async function harvestFullHistory(container) {
    console.log('[Whatnot Pulse] Starting aggressive history harvest...');
    
    if (!container) {
      console.warn('[Whatnot Pulse] No container provided for harvestFullHistory');
      return;
    }
    
    return new Promise((resolve) => {
      // Find scrollable element (container or its scrollable parent)
      let scrollableElement = container;
      const computedStyle = window.getComputedStyle(container);
      if (computedStyle.overflow === 'visible' || computedStyle.overflowY === 'visible') {
        let parent = container?.parentElement;
        while (parent && parent !== document.body) {
          const parentStyle = window.getComputedStyle(parent);
          if (parentStyle.overflow === 'auto' || parentStyle.overflow === 'scroll' ||
              parentStyle.overflowY === 'auto' || parentStyle.overflowY === 'scroll') {
            scrollableElement = parent;
            break;
          }
          parent = parent?.parentElement;
        }
      }
      
      let previousHeight = scrollableElement.scrollHeight || document.documentElement.scrollHeight;
      let previousSalesCount = document.querySelectorAll('[data-testid="show-buyer-details"]').length;
      let noChangeCount = 0;
      const maxNoChangeCount = 3; // Stop after 3 consecutive no-changes
      const scrollInterval = 500; // Scroll every 500ms as requested
      
      const scrollIntervalId = setInterval(() => {
        // Scroll to bottom
        if (scrollableElement && scrollableElement !== document.body) {
          scrollableElement.scrollTop = scrollableElement.scrollHeight;
        } else {
          window.scrollTo({
            top: document.documentElement.scrollHeight,
            behavior: 'auto'
          });
        }
        
        // Check if new content loaded after a brief delay
        setTimeout(() => {
          const currentHeight = scrollableElement?.scrollHeight || document.documentElement.scrollHeight;
          const currentSalesCount = document.querySelectorAll('[data-testid="show-buyer-details"]').length;
          
          if (currentHeight === previousHeight && currentSalesCount === previousSalesCount) {
            noChangeCount++;
            if (noChangeCount >= maxNoChangeCount) {
              // Stop scrolling - no more content
              clearInterval(scrollIntervalId);
              console.log(`[Whatnot Pulse] History harvest complete. Loaded ${currentSalesCount} sales after ${noChangeCount} no-change iterations`);
              resolve();
            }
          } else {
            // Reset counter if something changed
            noChangeCount = 0;
          }
          
          previousHeight = currentHeight;
          previousSalesCount = currentSalesCount;
        }, 100); // Brief delay to check if content loaded
      }, scrollInterval);
      
      // Safety timeout - stop after 5 minutes max
      setTimeout(() => {
        clearInterval(scrollIntervalId);
        console.log('[Whatnot Pulse] History harvest timeout (5 minutes)');
        resolve();
      }, 300000); // 5 minutes
    });
  }

  /**
   * Scroll through sales container to load all lazy-loaded sales
   * Uses multiple scroll strategies to ensure all items are loaded
   * Enhanced version: stops after 3 consecutive "no change" iterations
   * @param {HTMLElement} container - The sales container element
   * @returns {Promise<void>}
   */
  async function loadFullSalesHistory(container) {
    // Use the more aggressive harvestFullHistory for backward compatibility
    return harvestFullHistory(container);
  }

  /**
   * Scroll through sales container to load all lazy-loaded sales
   * Uses multiple scroll strategies to ensure all items are loaded
   * @param {HTMLElement} container - The sales container element
   * @returns {Promise<void>}
   */
  async function loadAllSalesByScrolling(container) {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1001',message:'loadAllSalesByScrolling called',data:{hasContainer:!!container,containerTag:container?.tagName||'null'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    console.log('[Whatnot Pulse] Scrolling to load all historical sales...');
    
    try {
      // Track unique sale signatures to ensure we're getting all of them
      const seenSaleSignatures = new Set();
      const getSaleSignature = (element) => {
        const buyerEl = element.querySelector('[data-testid="show-buyer-details"]');
        const itemEl = element.querySelector('strong[title], a[target="_blank"] strong');
        const priceEl = element.querySelector('strong[title*="$"]');
        
        const buyer = buyerEl?.textContent?.trim() || '';
        const item = itemEl?.textContent?.trim() || itemEl?.getAttribute('title') || '';
        const price = priceEl?.textContent?.trim() || priceEl?.getAttribute('title') || '';
        
        return `${buyer}|${item}|${price}`.toLowerCase();
      };
      
      // Strategy 1: Try scrolling the container itself
      let scrollableElement = container;
      let scrollStrategy = 'container';
      
      // Check if container has overflow or find scrollable parent
      const computedStyle = window.getComputedStyle(container);
      if (computedStyle.overflow === 'visible' || computedStyle.overflowY === 'visible') {
        // Find scrollable parent (with optional chaining)
        let parent = container?.parentElement;
        while (parent && parent !== document.body) {
          const parentStyle = window.getComputedStyle(parent);
          if (parentStyle.overflow === 'auto' || parentStyle.overflow === 'scroll' ||
              parentStyle.overflowY === 'auto' || parentStyle.overflowY === 'scroll') {
            scrollableElement = parent;
            break;
          }
          parent = parent?.parentElement;
        }
      }
      
      // Strategy 2: If container scroll didn't work, try window scroll
      const tryWindowScroll = async () => {
        let previousHeight = document.documentElement.scrollHeight;
        let previousSalesCount = document.querySelectorAll('[data-testid="show-buyer-details"]').length;
        let attempts = 0;
        const maxAttempts = 30;
        
        while (attempts < maxAttempts) {
          // Scroll window to bottom
          window.scrollTo({
            top: document.documentElement.scrollHeight,
            behavior: 'smooth'
          });
          
          await new Promise(resolve => setTimeout(resolve, 400));
          
          const currentHeight = document.documentElement.scrollHeight;
          const currentSalesCount = document.querySelectorAll('[data-testid="show-buyer-details"]').length;
          
          if (currentHeight === previousHeight && currentSalesCount === previousSalesCount) {
            break;
          }
          
          previousHeight = currentHeight;
          previousSalesCount = currentSalesCount;
          attempts++;
        }
        
        // Scroll back to top
        window.scrollTo({ top: 0, behavior: 'smooth' });
        await new Promise(resolve => setTimeout(resolve, 500));
        
        return previousSalesCount;
      };
      
      // Use IntersectionObserver to detect when new items appear
      let newItemsDetected = false;
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            newItemsDetected = true;
          }
        }
      }, { threshold: 0.1 });
      
      // Observe the bottom of the container
      const sentinel = document.createElement('div');
      sentinel.style.height = '10px';
      if (scrollableElement && scrollableElement !== document.body) {
        scrollableElement.appendChild(sentinel);
        observer.observe(sentinel);
      }

      let previousHeight = scrollableElement.scrollHeight || document.documentElement.scrollHeight;
      let previousSalesCount = document.querySelectorAll('[data-testid="show-buyer-details"]').length;
      let scrollAttempts = 0;
      const maxScrollAttempts = 100; // Increased for very long lists
      const scrollDelay = 400; // Increased delay for slower connections
      let noChangeCount = 0; // Count consecutive "no change" iterations - stop after 3

      // Scroll to bottom repeatedly until no more content loads
      while (scrollAttempts < maxScrollAttempts && noChangeCount < 3) {
        newItemsDetected = false;
        
        // Scroll the element
        if (scrollableElement && scrollableElement !== document.body) {
          scrollableElement.scrollTop = scrollableElement.scrollHeight;
        } else {
          // Fallback to window scroll
          window.scrollTo({
            top: document.documentElement.scrollHeight,
            behavior: 'auto'
          });
        }
        
        // Wait for lazy loading with requestAnimationFrame for smoother detection
        await new Promise(resolve => {
          requestAnimationFrame(() => {
            setTimeout(resolve, scrollDelay);
          });
        });
        
        // Check if new content loaded
        const currentHeight = scrollableElement?.scrollHeight || document.documentElement.scrollHeight;
        const currentSalesCount = document.querySelectorAll('[data-testid="show-buyer-details"]').length;
        
        // Count unique sales
        const allSales = document.querySelectorAll('[data-testid="show-buyer-details"]');
        let uniqueCount = 0;
        for (const sale of allSales) {
          const saleContainer = sale.closest('div.py-4, section, div[class*="py"]');
          if (saleContainer) {
            const sig = getSaleSignature(saleContainer);
            if (!seenSaleSignatures.has(sig)) {
              seenSaleSignatures.add(sig);
              uniqueCount++;
            }
          }
        }
        
        // #region agent log
        if (scrollAttempts % 10 === 0) fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1020',message:'Scrolling to load sales',data:{attempt:scrollAttempts,previousHeight,currentHeight,previousSalesCount,currentSalesCount,uniqueSales:seenSaleSignatures.size,newSalesLoaded:currentSalesCount>previousSalesCount,noChangeCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        
        // If height didn't change, sales count didn't increase, and no new items detected, increment no-change counter
        if (currentHeight === previousHeight && currentSalesCount === previousSalesCount && !newItemsDetected) {
          noChangeCount++;
          if (noChangeCount >= 3) {
            console.log(`[Whatnot Pulse] Reached end of sales list after ${scrollAttempts} scroll attempts (3 consecutive no-changes). Total sales found: ${currentSalesCount} (${seenSaleSignatures.size} unique)`);
            break;
          }
        } else {
          noChangeCount = 0; // Reset counter if something changed
        }
        
        previousHeight = currentHeight;
        previousSalesCount = currentSalesCount;
        scrollAttempts++;
      }
      
      // Cleanup observer
      if (sentinel.parentNode) {
        observer.disconnect();
        sentinel.parentNode.removeChild(sentinel);
      }
      
      // If container scroll didn't get many items, try window scroll as backup
      if (seenSaleSignatures.size < 10 && scrollAttempts < 5) {
        console.log('[Whatnot Pulse] Trying window scroll strategy as backup...');
        await tryWindowScroll();
        
        // Re-count after window scroll
        const allSalesAfterWindowScroll = document.querySelectorAll('[data-testid="show-buyer-details"]');
        for (const sale of allSalesAfterWindowScroll) {
          const saleContainer = sale.closest('div.py-4, section, div[class*="py"]');
          if (saleContainer) {
            const sig = getSaleSignature(saleContainer);
            seenSaleSignatures.add(sig);
          }
        }
      }
      
      // Scroll back to top to be less intrusive
      if (scrollableElement && scrollableElement !== document.body) {
        scrollableElement.scrollTop = 0;
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const finalCount = document.querySelectorAll('[data-testid="show-buyer-details"]').length;
      console.log(`[Whatnot Pulse] Finished scrolling. Loaded ${finalCount} total sales (${seenSaleSignatures.size} unique).`);
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1080',message:'Finished scrolling - all sales loaded',data:{totalSales:finalCount,uniqueSales:seenSaleSignatures.size,scrollAttempts},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      
    } catch (error) {
      console.error('[Whatnot Pulse] Error scrolling to load sales:', error);
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1085',message:'ERROR scrolling to load sales',data:{error:error.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
    }
  }

  /**
   * Ensure the "Sold" filter is active
   * Returns true if filter was activated or already active, false if failed
   */
  async function ensureSoldFilterActive(retryCount = 0) {
    const maxRetries = 3;
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1201',message:'ensureSoldFilterActive called',data:{retryCount,maxRetries},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    
    try {
      // First, check if filter is already active by looking for "Sold (XXX)" heading
      // Note: :has-text() is not a valid CSS selector, so we'll search using textContent instead
      const headingText = document.body.textContent || '';
      const hasSoldHeading = /Sold\s*\(\d+\)/i.test(headingText);
      
      // Try to find heading elements that might contain "Sold" using valid CSS and JavaScript
      const soldHeading = document.querySelector('strong[title="Sold"], h2[title*="Sold"]') || 
                         Array.from(document.querySelectorAll('h2, strong')).find(el => 
                           el.textContent && /Sold\s*\(\d+\)/i.test(el.textContent)
                         );
      
      if (hasSoldHeading) {
        // Verify by checking if we can find sold items
        const soldItems = document.querySelectorAll('[data-testid="show-buyer-details"]');
        if (soldItems.length > 0) {
          console.log('[Whatnot Pulse] Sold filter appears to be active (found', soldItems.length, 'sold items)');
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1214',message:'Sold filter already active',data:{soldItemsCount:soldItems.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
          // #endregion
          return true;
        }
      }
      
      // Strategy 1: XPath (most reliable method for finding button by text)
      let soldButton = null;
      try {
        const xpathResult = document.evaluate(
          "//button[contains(text(), 'Sold') and not(contains(text(), 'Unsold'))]",
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        
        const xpathButton = xpathResult.singleNodeValue;
        if (xpathButton) {
          soldButton = xpathButton;
          console.log('[Whatnot Pulse] Found "Sold" button via XPath');
        }
      } catch (xpathError) {
        console.warn('[Whatnot Pulse] XPath search failed, falling back to text-based search:', xpathError);
      }
      
      // Strategy 2: Fallback to text-based search if XPath didn't find it
      if (!soldButton) {
        const allButtons = document.querySelectorAll('button, [role="button"], [class*="button"]');
        
        for (const btn of allButtons) {
        const text = (btn.textContent?.trim() || '').toLowerCase();
        const classes = btn.className || '';
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        
        // Check if this is the Sold button
        if ((text === 'sold' || text.includes('sold')) && !text.includes('unsold')) {
          // Check if already selected (look for visual indicators)
          let isDarkBg = false;
          let isWhiteText = false;
          
          try {
            // getComputedStyle can throw DOMException if element is from different origin
            if (btn.isConnected) {
              const computedStyle = window.getComputedStyle(btn);
              const bgColor = computedStyle.backgroundColor;
              const color = computedStyle.color;
              isDarkBg = bgColor && (bgColor.includes('rgb(55') || bgColor.includes('rgb(75') || 
                                      bgColor.includes('rgb(31') || bgColor.includes('rgb(17'));
              isWhiteText = color && (color.includes('rgb(255') || color.includes('rgb(250'));
            }
          } catch (styleError) {
            // If we can't get computed style, just use class/aria checks
            console.warn('[Whatnot Pulse] Could not get computed style for button:', styleError);
          }
          
          const isSelectedByClass = classes.includes('active') || classes.includes('selected') ||
                                    btn.classList.contains('bg-gray-900') || btn.classList.contains('bg-gray-800');
          const isSelectedByAria = btn.getAttribute('aria-selected') === 'true';
          
          // If button is already selected, we're done
          if (isSelectedByClass || isSelectedByAria || (isDarkBg && isWhiteText)) {
            console.log('[Whatnot Pulse] Sold filter is already active');
            // #region agent log
            fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1243',message:'Sold filter button already selected',data:{isSelectedByClass,isSelectedByAria,isDarkBg,isWhiteText},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
            // #endregion
            return true;
          }
          
          // Found the Sold button and it's not selected
          soldButton = btn;
          break;
        }
      }
      } // End of fallback text-based search
      
      // If found, click it
      if (soldButton) {
        console.log('[Whatnot Pulse] Clicking "Sold" filter button to activate it (attempt', retryCount + 1, ')');
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1517',message:'Clicking Sold filter button',data:{retryCount,buttonText:soldButton.textContent?.trim()?.substring(0,50)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        
        // Check if button is actually clickable before attempting click
        try {
          const isConnected = soldButton.isConnected;
          const isVisible = soldButton.offsetParent !== null;
          const isDisabled = soldButton.disabled || soldButton.getAttribute('disabled') !== null;
          
          if (!isConnected) {
            console.warn('[Whatnot Pulse] Button is not connected to DOM');
            throw new Error('Button not connected to DOM');
          }
          
          if (!isVisible) {
            console.warn('[Whatnot Pulse] Button is not visible');
            // Try scrolling it into view
            soldButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          
          if (isDisabled) {
            console.warn('[Whatnot Pulse] Button is disabled');
            throw new Error('Button is disabled');
          }
          
          // Attempt click
          soldButton.click();
        } catch (clickError) {
          console.warn('[Whatnot Pulse] Error clicking button, trying alternative method:', clickError);
          // Fallback: try dispatching a mouse event
          try {
            const clickEvent = new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window
            });
            soldButton.dispatchEvent(clickEvent);
          } catch (dispatchError) {
            throw new Error(`Could not click button: ${clickError.message || clickError}, dispatch also failed: ${dispatchError.message || dispatchError}`);
          }
        }
        
        // Wait for filter to apply
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Verify it worked by checking for sold items or heading
        await new Promise(resolve => setTimeout(resolve, 500));
        const verifySoldItems = document.querySelectorAll('[data-testid="show-buyer-details"]');
        const verifyHeading = /Sold\s*\(\d+\)/i.test(document.body.textContent || '');
        
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1287',message:'Verifying filter activation',data:{verifySoldItemsCount:verifySoldItems.length,verifyHeading,retryCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        
        if (verifySoldItems.length > 0 || verifyHeading) {
          console.log('[Whatnot Pulse] Sold filter activated successfully (found', verifySoldItems.length, 'items)');
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1292',message:'Filter activation SUCCESS',data:{verifySoldItemsCount:verifySoldItems.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
          // #endregion
          return true;
        } else if (retryCount < maxRetries) {
          // Retry if verification failed
          console.log('[Whatnot Pulse] Filter activation verification failed, retrying...');
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1295',message:'Filter activation FAILED - retrying',data:{retryCount,maxRetries},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
          // #endregion
          return ensureSoldFilterActive(retryCount + 1);
        } else {
          // Don't log warning - filter activation failures are expected sometimes
          // Just return false and continue without filter
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1299',message:'Filter activation FAILED after max retries',data:{maxRetries},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
          // #endregion
          return false;
        }
      }
      
      // Fallback: Try finding by data attributes or specific selectors
      const soldFilter = document.querySelector('[data-testid*="sold"]:not([data-testid*="buyer"]), button[aria-label*="Sold" i]');
      if (soldFilter) {
        const isSelected = soldFilter.classList.contains('active') || 
                          soldFilter.getAttribute('aria-selected') === 'true';
        if (!isSelected) {
          console.log('[Whatnot Pulse] Clicking "Sold" filter via selector');
          try {
            // Check if element is clickable
            if (soldFilter.isConnected && soldFilter.offsetParent !== null && !soldFilter.disabled) {
              soldFilter.click();
            } else {
              // Try scrolling into view first
              soldFilter.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await new Promise(resolve => setTimeout(resolve, 500));
              soldFilter.click();
            }
          } catch (clickError) {
            console.warn('[Whatnot Pulse] Error clicking filter via selector, trying dispatch:', clickError);
            // Fallback: dispatch event
            try {
              const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
              soldFilter.dispatchEvent(clickEvent);
            } catch (dispatchError) {
              throw new Error(`Could not click filter: ${clickError.message || clickError}`);
            }
          }
          await new Promise(resolve => setTimeout(resolve, 1500));
          
          // Verify
          const verifyItems = document.querySelectorAll('[data-testid="show-buyer-details"]');
          if (verifyItems.length > 0) {
            return true;
          }
        } else {
          return true; // Already selected
        }
      }
      
      // Don't log warning - filter button not found is expected sometimes
      return false;
    } catch (error) {
      // Better error logging - show actual error message
      const errorMessage = error instanceof DOMException 
        ? `DOMException: ${error.name} - ${error.message} (code: ${error.code})`
        : error?.message || error?.toString() || String(error);
      console.warn('[Whatnot Pulse] Error trying to activate Sold filter:', errorMessage);
      console.warn('[Whatnot Pulse] Error details:', {
        name: error?.name,
        message: error?.message,
        code: error?.code,
        stack: error?.stack?.substring(0, 200)
      });
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1579',message:'ensureSoldFilterActive ERROR',data:{errorMessage,errorName:error?.name,errorCode:error?.code,retryCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
      // #endregion
      
      if (retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return ensureSoldFilterActive(retryCount + 1);
      }
      return false;
    }
  }

  /**
   * Find sales elements without needing the filter to be active
   * Searches the entire page for completed sales
   */
  function findSalesWithoutFilter() {
    console.log('[Whatnot Pulse] Attempting to find sales without filter active...');
    
    // Find all elements with buyer details (completed sales indicator)
    const allBuyerDetails = document.querySelectorAll('[data-testid="show-buyer-details"]');
    
    if (allBuyerDetails.length === 0) {
      console.log('[Whatnot Pulse] No buyer details found - filter may need to be active');
      return { container: null, saleElements: [], count: 0 };
    }
    
    // Get unique sale containers
    const saleElements = [];
    const seenContainers = new Set();
    
    for (const buyerEl of allBuyerDetails) {
      // Find the sale container (parent with py-4 or similar)
      const container = buyerEl.closest('div.py-4, section, div[class*="py"], div[class*="item"], div[class*="card"]');
      if (container && !seenContainers.has(container)) {
        // Include ALL sales (completed and pending payments)
        // We'll mark them with is_pending flag in extractSaleData
        saleElements.push(container);
        seenContainers.add(container);
      }
    }
    
    console.log('[Whatnot Pulse] Found', saleElements.length, 'sales without filter active');
    
    // Try to find a common parent container
    let commonContainer = null;
    if (saleElements.length > 0) {
      // Find the closest common ancestor (with optional chaining)
      let currentParent = saleElements[0]?.parentElement;
      while (currentParent && currentParent !== document.body) {
        let allInContainer = true;
        for (const sale of saleElements.slice(0, 5)) { // Check first 5
          if (!currentParent.contains(sale)) {
            allInContainer = false;
            break;
          }
        }
        if (allInContainer) {
          commonContainer = currentParent;
          break;
        }
        currentParent = currentParent?.parentElement;
      }
    }
    
    return {
      container: commonContainer || document.body, // Fallback to body if no common container
      saleElements: saleElements,
      count: saleElements.length
    };
  }

  /**
   * Find the sales container element using adaptive selectors
   * Tries to find sales without filter first, then falls back to filter-based search
   */
  function findSalesContainer() {
    // Strategy A: Try to find sales without filter active
    const salesWithoutFilter = findSalesWithoutFilter();
    if (salesWithoutFilter.count > 0 && salesWithoutFilter.container) {
      console.log('[Whatnot Pulse] Found sales container without filter (', salesWithoutFilter.count, 'sales)');
      return salesWithoutFilter.container;
    }
    
    // Strategy B: Look for the Sold tab's content container (requires filter active)
    const soldTabContainer = document.querySelector('[data-overlayscrollbars-contents]');
    if (soldTabContainer) {
      // Verify it contains "Sold" heading
      const soldHeading = soldTabContainer.querySelector('strong[title="Sold"]');
      const soldHeadingText = soldTabContainer.textContent || '';
      const hasSoldHeading = /Sold\s*\(\d+\)/i.test(soldHeadingText);
      
      if (soldHeading || hasSoldHeading) {
        console.log('[Whatnot Pulse] Found sales container via Sold tab (filter active)');
        return soldTabContainer;
      }
    }

    // Fallback: Try other selectors
    for (const selector of CONFIG.SALES_CONTAINER_SELECTORS) {
      const container = document.querySelector(selector);
      if (container) {
        const buyerDetails = container.querySelectorAll('[data-testid="show-buyer-details"]');
        if (buyerDetails.length > 0) {
          console.log('[Whatnot Pulse] Found sales container:', selector);
          return container;
        }
      }
    }
    
    // Last fallback: search for elements containing sale-related keywords
    const allElements = document.querySelectorAll('div, section, ul, ol');
    for (const element of allElements) {
      const text = element.textContent?.toLowerCase() || '';
      const classList = element.className?.toLowerCase() || '';
      const id = element.id?.toLowerCase() || '';
      
      // Check if element contains buyer details (actual sales)
      const hasBuyerDetails = element.querySelectorAll('[data-testid="show-buyer-details"]').length > 0;
      
      if (hasBuyerDetails && 
          (text.includes('sold') || text.includes('sale') || classList.includes('sold') || 
           classList.includes('sale') || classList.includes('transaction') || id.includes('sold'))) {
        console.log('[Whatnot Pulse] Found sales container by content with buyer details:', element);
        return element;
      }
    }
    
    return null;
  }

  /**
   * Extract pending items count from the page
   * Looks for queue/pending section showing number of items waiting to be sold
   * Uses multiple strategies to find the count accurately
   */
  function extractPendingItemsCount() {
    try {
      console.log('[Whatnot Pulse] Extracting pending items count...');
      
      // Strategy 1: Data testid attributes (most reliable)
      const dataTestIdSelectors = [
        '[data-testid="pending-count"]',
        '[data-testid="queue-count"]',
        '[data-testid="pending-items"]',
        '[data-testid*="pending"]',
        '[data-testid*="queue"]'
      ];
      
      for (const selector of dataTestIdSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
          const text = element.textContent || '';
          const countMatch = text.match(/(\d+)/);
          if (countMatch && countMatch[1]) {
            const count = parseInt(countMatch[1], 10);
            if (!isNaN(count) && count >= 0 && count < 10000) {
              console.log('[Whatnot Pulse] Found pending count via data-testid:', selector, '→', count);
              return count;
            }
          }
        }
      }
      
      // Strategy 2: Class-based selectors
      const classSelectors = [
        '.pending-count',
        '.queue-count',
        '.pending-items',
        '[class*="pending-count"]',
        '[class*="queue-count"]',
        '[class*="pending-items"]',
        '[class*="PendingCount"]',
        '[class*="QueueCount"]'
      ];
      
      for (const selector of classSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
          const text = element.textContent || '';
          const countMatch = text.match(/(\d+)/);
          if (countMatch && countMatch[1]) {
            const count = parseInt(countMatch[1], 10);
            if (!isNaN(count) && count >= 0 && count < 10000) {
              console.log('[Whatnot Pulse] Found pending count via class:', selector, '→', count);
              return count;
            }
          }
        }
      }
      
      // Strategy 3: Text pattern matching in page content
      const pageText = document.body.textContent || document.body.innerText || '';
      const textPatterns = [
        /Pending\s*[\(:]?\s*(\d+)/i,
        /Queue[:\s]+(\d+)/i,
        /(\d+)\s*items?\s*pending/i,
        /(\d+)\s*in\s*queue/i,
        /(\d+)\s*pending\s*payments?/i
      ];
      
      for (const pattern of textPatterns) {
        const match = pageText.match(pattern);
        if (match && match[1]) {
          const count = parseInt(match[1], 10);
          if (!isNaN(count) && count >= 0 && count < 10000) {
            console.log('[Whatnot Pulse] Found pending count via text pattern →', count);
            return count;
          }
        }
      }
      
      // Strategy 4: Look for elements containing "pending" or "queue" text with numbers
      const allElements = document.querySelectorAll('*');
      for (const element of allElements) {
        const text = element.textContent || '';
        // Look for patterns like "Pending (5)", "Queue: 3", etc.
        if ((text.toLowerCase().includes('pending') || text.toLowerCase().includes('queue')) &&
            !element.closest('nav, header, footer')) { // Exclude navigation
          const match = text.match(/(\d+)/);
          if (match && match[1]) {
            const count = parseInt(match[1], 10);
            if (!isNaN(count) && count >= 0 && count < 10000) {
              // Make sure element is visible
              const style = window.getComputedStyle(element);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                console.log('[Whatnot Pulse] Found pending count in element text →', count);
                return count;
              }
            }
          }
        }
      }
      
      // Strategy 5: Count actual payment pending items in the sales feed
      const paymentPendingItems = document.querySelectorAll('[data-testid="show-buyer-details"]');
      let pendingCount = 0;
      for (const item of paymentPendingItems) {
        const parentText = item.parentElement?.textContent || item.textContent || '';
        if (parentText.includes('Payment Pending') || parentText.includes('payment pending')) {
          pendingCount++;
        }
      }
      
      if (pendingCount > 0) {
        console.log('[Whatnot Pulse] Found pending count by counting payment pending items →', pendingCount);
        return pendingCount;
      }
      
      console.log('[Whatnot Pulse] Could not extract pending items count - returning null');
      return null;
    } catch (error) {
      console.warn('[Whatnot Pulse] Error extracting pending items count:', error);
      return null;
    }
  }

  /**
   * Extract listing ID from href attribute
   * Looks for href containing "TGlzdGluZ05vZGU6..." (base64 encoded listing ID)
   */
  function extractListingId(element) {
    try {
      // Look for links with listing ID in href
      const links = element.querySelectorAll('a[href*="TGlzdGluZ05vZGU6"]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/TGlzdGluZ05vZGU6([A-Za-z0-9_-]+)/);
        if (match && match[0]) {
          return match[0];
        }
      }
      
      // Also check the element itself if it's a link
      if (element.tagName === 'A') {
        const href = element.getAttribute('href') || '';
        const match = href.match(/TGlzdGluZ05vZGU6([A-Za-z0-9_-]+)/);
        if (match && match[0]) {
          return match[0];
        }
      }
      
      return null;
    } catch (error) {
      console.warn('[Whatnot Pulse] Error extracting listing ID:', error);
      return null;
    }
  }

  /**
   * Extract sales data from a DOM element
   * Optimized for Whatnot's actual DOM structure
   */
  function extractSaleData(element) {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:683',message:'extractSaleData called',data:{elementTag:element.tagName,elementTextPreview:element.textContent?.substring(0,200)||'empty'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    
    try {
      // STEP 1: Check filter states first (needed for giveaway detection)
      // Check if giveaway filter is active (items with no price might be giveaways)
      let giveawayFilterActive = false;
      try {
        const giveawayButtons = document.querySelectorAll('button, [role="button"]');
        for (const btn of giveawayButtons) {
          const text = (btn.textContent?.trim() || '').toLowerCase();
          if (text === 'giveaway' || text.includes('giveaway')) {
            const classes = btn.className?.toString() || '';
            const ariaSelected = btn.getAttribute('aria-selected');
            const computedStyle = window.getComputedStyle(btn);
            const bgColor = computedStyle.backgroundColor;
            const isDarkBg = bgColor && (bgColor.includes('rgb(55') || bgColor.includes('rgb(75') || 
                                        bgColor.includes('rgb(31') || bgColor.includes('rgb(17'));
            
            if (classes.includes('active') || ariaSelected === 'true' || isDarkBg) {
              giveawayFilterActive = true;
              break;
            }
          }
        }
      } catch (e) {
        // Ignore errors checking filter state
      }
      
      // STEP 2: Check if this is a "Payment Pending" item - TRACK IT with is_pending flag
      // Payment Pending items have orange text with "Payment Pending: $XX"
      const elementText = element.textContent || '';
      const hasPaymentPending = elementText.includes('Payment Pending');
      
      // Check for orange text class (payment pending indicator)
      const paymentPendingElements = element.querySelectorAll('.text-system-orange-opaque-default');
      let isPaymentPending = false;
      
      for (const pendingEl of paymentPendingElements) {
        const pendingText = pendingEl.textContent?.trim() || '';
        if (pendingText.includes('Payment Pending')) {
          isPaymentPending = true;
          break;
        }
      }
      
      // Also check if any price element contains "Payment Pending"
      if (!isPaymentPending && hasPaymentPending) {
        // Check all text nodes and strong elements for "Payment Pending: $XX" pattern
        const allText = element.innerText || element.textContent || '';
        if (allText.match(/Payment Pending:\s*\$[\d,]+/i)) {
          isPaymentPending = true;
        }
      }
      
      // Store this flag to use later when creating the sale object
      // We'll continue processing to extract all data from pending items

      // STEP 2: Extract item name
      // Look for strong tag with title attribute or text content
      let itemName = null;
      const itemNameSelectors = [
        'a[target="_blank"] strong[title]', // Most specific - item links with title
        'a[target="_blank"] strong', // Item links
        'strong[title]', // Item name often has title attribute
        'strong.text-body2',
        'strong.font-bold'
      ];

      for (const selector of itemNameSelectors) {
        const nameElements = element.querySelectorAll(selector);
        // #region agent log
        if (nameElements.length > 0) fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:709',message:'Trying item name selector',data:{selector,found:nameElements.length,firstText:nameElements[0]?.textContent?.substring(0,50)||'null'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
        // #endregion
        
        for (const nameEl of nameElements) {
          const text = nameEl.textContent?.trim() || '';
          const title = nameEl.getAttribute('title') || '';
          
          // Skip if it's a price (contains $), buyer info, or payment pending
          if (text && !text.includes('$') && !text.includes('Buyer:') && 
              !text.includes('Payment Pending') && text.length > 0 && text.length < 200) {
            // Use title attribute if available, otherwise use text
            itemName = (title && title.trim() && !title.includes('$')) ? title.trim() : text;
            if (itemName && itemName !== 'Sold' && itemName !== 'Buyer') {
              // #region agent log
              fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:722',message:'Found item name',data:{itemName},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
              // #endregion
              break;
            }
          }
        }
        if (itemName && itemName !== 'Sold' && itemName !== 'Buyer') {
          break;
        }
      }

      // STEP 3: Extract price (from completed sales OR payment pending items)
      let soldPrice = null;
      let isGiveaway = false;
      
      // If it's a payment pending item, extract price from "Payment Pending: $XX" format
      if (isPaymentPending) {
        const pendingPriceMatch = elementText.match(/Payment Pending:\s*\$([\d,]+\.?\d*)/i);
        if (pendingPriceMatch && pendingPriceMatch[1]) {
          soldPrice = parseFloat(pendingPriceMatch[1].replace(/,/g, ''));
          console.log('[Whatnot Pulse] Extracted price from Payment Pending:', soldPrice);
        }
        
        // Also check orange text elements for the price
        if (soldPrice === null) {
          for (const pendingEl of paymentPendingElements) {
            const pendingText = pendingEl.textContent?.trim() || '';
            const priceMatch = pendingText.match(/\$([\d,]+\.?\d*)/);
            if (priceMatch && priceMatch[1]) {
              soldPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
              console.log('[Whatnot Pulse] Extracted price from pending element:', soldPrice);
              break;
            }
          }
        }
      }
      
      // For completed sales, look for price in strong tags
      if (soldPrice === null && !isPaymentPending) {
        // Look for price in strong tags - check for title attribute first (most reliable)
        const priceElements = element.querySelectorAll('strong');
        for (const priceEl of priceElements) {
          const title = priceEl.getAttribute('title') || '';
          const text = priceEl.textContent?.trim() || '';
          
          // Skip if this element contains "Payment Pending" (for completed sales only)
          if (text.includes('Payment Pending') || title.includes('Payment Pending')) {
            continue; // Skip this price element
          }
          
          // Check title attribute for price (format: "$88" or "$88.00")
          if (title && title.startsWith('$')) {
            const priceMatch = title.match(/\$([\d,]+\.?\d*)/);
            if (priceMatch && !title.includes('Payment Pending')) {
              soldPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
              console.log('[Whatnot Pulse] Extracted price from title:', soldPrice);
              break;
            }
          }
          
          // Check text content for price (format: "$88" - NOT "Payment Pending: $88")
          if (text && text.startsWith('$') && !text.includes('Payment Pending')) {
            // Make sure it's just a price, not "Payment Pending: $XX"
            if (!text.match(/Payment Pending/i)) {
              const priceMatch = text.match(/\$([\d,]+\.?\d*)/);
              if (priceMatch) {
                soldPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
                console.log('[Whatnot Pulse] Extracted price from text:', soldPrice);
                break;
              }
            }
          }
        }
      }
      
      // Also check in section elements that might contain the price
      if (soldPrice === null) {
        const priceSections = element.querySelectorAll('section, div');
        for (const section of priceSections) {
          const sectionText = section.textContent?.trim() || '';
          // Only extract if it's a simple price, not payment pending
          if (sectionText.match(/^\$[\d,]+\.?\d*$/) && !sectionText.includes('Payment Pending')) {
            const priceMatch = sectionText.match(/\$([\d,]+\.?\d*)/);
            if (priceMatch) {
              soldPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
              console.log('[Whatnot Pulse] Extracted price from section:', soldPrice);
              break;
            }
          }
        }
      }

      // STEP 4: If no price found, check if it's a giveaway
      if (soldPrice === null && !isPaymentPending) {
        // Improved giveaway detection using case-insensitive regex patterns
        // Match: (.*)GIVVY(.*), (.*)GIVEAWAY(.*), (.*)MYSTERY G(.*)
        const giveawayPatterns = [
          /(.*)givvy(.*)/i,
          /(.*)giveaway(.*)/i,
          /(.*)mystery\s*g(.*)/i,
          /(.*)mystery\s*givvy(.*)/i
        ];
        
        // Check item name for giveaway patterns
        for (const pattern of giveawayPatterns) {
          if (pattern.test(elementText)) {
            isGiveaway = true;
            console.log('[Whatnot Pulse] ✅ Detected giveaway via regex pattern:', pattern);
            break;
          }
        }
        
        // Also check if price is 0 OR item name matches pattern
        if (!isGiveaway && soldPrice === 0) {
          isGiveaway = true;
          console.log('[Whatnot Pulse] ✅ Detected giveaway (price is 0)');
        }
        
        // 2. Verify giveaway filter state more thoroughly
        if (!isGiveaway) {
          const giveawayButtons = document.querySelectorAll('button, [role="button"], [class*="filter"], [class*="tab"]');
          for (const btn of giveawayButtons) {
            const text = (btn.textContent?.trim() || '').toLowerCase();
            if (text === 'giveaway' || text.includes('giveaway')) {
              const classes = btn.className?.toString() || '';
              const ariaSelected = btn.getAttribute('aria-selected');
              const computedStyle = window.getComputedStyle(btn);
              const bgColor = computedStyle.backgroundColor;
              const fontWeight = computedStyle.fontWeight;
              
              // More thorough check for active state
              const isActive = classes.includes('active') || 
                              classes.includes('selected') ||
                              ariaSelected === 'true' ||
                              bgColor.includes('rgb(55') || 
                              bgColor.includes('rgb(75') || 
                              bgColor.includes('rgb(31') || 
                              bgColor.includes('rgb(17') ||
                              fontWeight === '600' ||
                              fontWeight === '700' ||
                              fontWeight === 'bold';
              
              if (isActive) {
                giveawayFilterActive = true;
                console.log('[Whatnot Pulse] Giveaway filter confirmed active via button check');
                break;
              }
            }
          }
        }
        
        // 3. If giveaway filter is active AND item has a buyer but no price, it's likely a giveaway
        if (!isGiveaway && giveawayFilterActive) {
          // Check if item has buyer details (means it was "sold" even if no price)
          const hasBuyer = element.querySelector('[data-testid="show-buyer-details"]') !== null ||
                          elementText.match(/Buyer:\s*[a-zA-Z0-9_-]+/i) !== null;
          if (hasBuyer) {
            isGiveaway = true;
            console.log('[Whatnot Pulse] ✅ Detected giveaway (giveaway filter active + buyer present + no price)');
          }
        }
        
        // 4. If item appears in sold feed but has buyer and no price, likely a giveaway
        if (!isGiveaway) {
          // Check if we're in the "Sold" filter view (more robust check)
          const soldFilterButtons = document.querySelectorAll('button, [role="button"]');
          let soldFilterActive = false;
          for (const btn of soldFilterButtons) {
            const text = (btn.textContent?.trim() || '').toLowerCase();
            if (text.includes('sold') && !text.includes('giveaway')) {
              const classes = btn.className?.toString() || '';
              const ariaSelected = btn.getAttribute('aria-selected');
              const computedStyle = window.getComputedStyle(btn);
              const isActive = classes.includes('active') || 
                              classes.includes('selected') ||
                              ariaSelected === 'true' ||
                              computedStyle.fontWeight === '600' ||
                              computedStyle.fontWeight === '700';
              if (isActive) {
                soldFilterActive = true;
                break;
              }
            }
          }
          
          // Fallback: check page text
          if (!soldFilterActive) {
          const pageText = document.body.textContent || '';
            soldFilterActive = pageText.match(/Sold\s*\(\d+\)/i) !== null;
          }
          
          const hasBuyer = element.querySelector('[data-testid="show-buyer-details"]') !== null ||
                          elementText.match(/Buyer:\s*[a-zA-Z0-9_-]+/i) !== null;
          
          // If in sold filter, has buyer, but no price found - likely a giveaway
          if (soldFilterActive && hasBuyer && soldPrice === null) {
            // Check if NO price elements exist in the item
            const priceElements = element.querySelectorAll('strong[title*="$"], strong, [class*="price"]');
            let hasPriceElement = false;
            for (const el of priceElements) {
              const text = el.textContent?.trim() || '';
              const title = el.getAttribute('title') || '';
              if ((text.includes('$') || title.includes('$')) && !text.includes('Payment Pending')) {
                hasPriceElement = true;
                break;
              }
            }
            
            // If no price element found at all, and it has a buyer in sold filter, it's a giveaway
            if (!hasPriceElement && !elementText.match(/\$\d+/)) {
              isGiveaway = true;
              console.log('[Whatnot Pulse] ✅ Detected giveaway (sold filter + buyer + NO price element found)');
              // #region agent log
              fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2515',message:'Giveaway detected via sold filter check',data:{soldFilterActive,hasBuyer,elementTextPreview:elementText.substring(0,100)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'GIVEAWAY'})}).catch(()=>{});
              // #endregion
            } else {
              // Check item name for giveaway patterns using case-insensitive regex
              const giveawayPatterns = [
                /(.*)givvy(.*)/i,
                /(.*)giveaway(.*)/i,
                /(.*)mystery\s*g(.*)/i,
                /(.*)mystery\s*givvy(.*)/i
              ];
              
              for (const pattern of giveawayPatterns) {
                if (pattern.test(elementText)) {
                  isGiveaway = true;
                  console.log('[Whatnot Pulse] ✅ Detected giveaway via regex pattern:', pattern);
                  break;
                }
              }
              
              if (isGiveaway) {
                console.log('[Whatnot Pulse] ✅ Detected giveaway (sold filter + giveaway text found)');
              }
            }
          }
        }
        
        if (isGiveaway) {
          soldPrice = 0;
          console.log('[Whatnot Pulse] ✅ Detected giveaway - setting price to $0');
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1675',message:'Giveaway detected',data:{giveawayFilterActive,elementTextPreview:elementText.substring(0,100)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'F'})}).catch(()=>{});
          // #endregion
        } else {
          // No price found and not a giveaway or pending - skip it
          console.warn('[Whatnot Pulse] No price found for item, skipping:', elementText.substring(0, 100));
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1680',message:'No price found - skipping',data:{giveawayFilterActive,elementTextPreview:elementText.substring(0,100)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'F'})}).catch(()=>{});
          // #endregion
          return null;
        }
      }
      
      // If still no price but it's payment pending, we can't process it
      if (soldPrice === null && isPaymentPending) {
        console.warn('[Whatnot Pulse] Payment Pending item but no price found, skipping:', elementText.substring(0, 100));
        return null;
      }

      // STEP 4.5: Additional giveaway check AFTER price extraction but BEFORE buyer extraction
      // If we have a buyer but no price, and we're in sold filter, it's likely a giveaway
      if (!isGiveaway && soldPrice === null && !isPaymentPending) {
        const pageText = document.body.textContent || '';
        const soldFilterActive = pageText.match(/Sold\s*\(\d+\)/i) !== null;
        const hasBuyerDetails = element.querySelector('[data-testid="show-buyer-details"]') !== null ||
                                elementText.match(/Buyer:\s*[a-zA-Z0-9_-]+/i) !== null;
        
        // If in sold filter, has buyer details, but no price found - almost certainly a giveaway
        if (soldFilterActive && hasBuyerDetails) {
          isGiveaway = true;
          soldPrice = 0;
          console.log('[Whatnot Pulse] ✅ Detected giveaway (has buyer + sold filter + no price = giveaway)');
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1757',message:'Giveaway detected via buyer+no price check',data:{soldFilterActive,hasBuyerDetails},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'F'})}).catch(()=>{});
          // #endregion
        }
      }

      // STEP 5: Extract buyer username
      let buyerUsername = null;
      
      // Try data-testid="show-buyer-details" first (most reliable)
      const buyerDetailsEl = element.querySelector('[data-testid="show-buyer-details"]');
      if (buyerDetailsEl) {
        // Look for link with /user/ pattern
        const buyerLink = buyerDetailsEl.querySelector('a[href^="/user/"], a[href*="/user/"]');
        if (buyerLink) {
          const href = buyerLink.getAttribute('href');
          const match = href.match(/\/user\/([^\/\?]+)/);
          if (match && match[1]) {
            buyerUsername = match[1].toLowerCase().trim();
          } else {
            // Fallback to link text
            const linkText = buyerLink.textContent?.trim();
            if (linkText && !linkText.includes('$') && !linkText.includes('Payment Pending')) {
              buyerUsername = linkText.toLowerCase();
            }
          }
        } else {
          // Fallback: extract from text like "Buyer: username"
          const buyerText = buyerDetailsEl.textContent || '';
          const buyerMatch = buyerText.match(/Buyer:\s*([a-zA-Z0-9_-]+)/i);
          if (buyerMatch && buyerMatch[1]) {
            buyerUsername = buyerMatch[1].toLowerCase().trim();
          }
        }
      }
      
      // Fallback: Look for any user link in the element
      if (!buyerUsername) {
        const allUserLinks = element.querySelectorAll('a[href*="/user/"]');
        for (const link of allUserLinks) {
          const href = link.getAttribute('href');
          const match = href.match(/\/user\/([^\/\?]+)/);
          if (match && match[1]) {
            // Make sure it's not the streamer's own link
            const potentialBuyer = match[1].toLowerCase().trim();
            if (potentialBuyer !== streamerUsername) {
              buyerUsername = potentialBuyer;
              break;
            }
          }
        }
      }
      
      // Last fallback: extract from "Buyer: username" text pattern anywhere in element
      if (!buyerUsername) {
        const elementText = element.textContent || '';
        const buyerMatch = elementText.match(/Buyer:\s*([a-zA-Z0-9_-]+)/i);
        if (buyerMatch && buyerMatch[1]) {
          buyerUsername = buyerMatch[1].toLowerCase().trim();
        }
      }

      // STEP 6: Validate we have minimum required data
      if (!streamerUsername) {
        console.warn('[Whatnot Pulse] No streamer username, cannot process sale');
        return null;
      }

      // VALIDATION: Do not mark payment pending items as confirmed sales
      // If item shows "Payment Pending" text, mark as pending but don't process as completed sale
      if (isPaymentPending) {
        console.log('[Whatnot Pulse] Payment pending item detected - will be tracked but not marked as confirmed sale:', itemName);
        // Continue processing to extract data, but is_pending flag will prevent it from being sent as completed
      }
      
      // Final validation: if no price and not giveaway/pending, skip it
      // (But at this point, if isGiveaway is true, soldPrice should be 0)
      if (soldPrice === null && !isGiveaway && !isPaymentPending) {
        console.warn('[Whatnot Pulse] No price detected and not a giveaway or pending, skipping');
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1823',message:'Skipping - no price and not giveaway/pending',data:{hasBuyer:!!buyerUsername},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'F'})}).catch(()=>{});
        // #endregion
        return null;
      }
      
      // Ensure giveaways have price set to 0
      if (isGiveaway && soldPrice === null) {
        soldPrice = 0;
        console.log('[Whatnot Pulse] Ensuring giveaway has price = 0');
      }

      if (!itemName || itemName.trim() === '') {
        console.warn('[Whatnot Pulse] Could not extract item name');
        // Still try to process if we have price and buyer
        if (soldPrice === null && !isGiveaway) {
          return null;
        }
        itemName = 'Unknown Item';
      }

      if (!buyerUsername) {
        console.warn('[Whatnot Pulse] Could not extract buyer username, using "unknown"');
        buyerUsername = 'unknown';
      }

      const timestamp = new Date().toISOString();
      
      // Extract additional metadata
      const listingId = extractListingId(element);
      const pendingItems = extractPendingItemsCount();
      
      // Giveaway filter check was moved earlier in the function (STEP 1)
      // Additional check: If price was already set to 0 or is null and giveaway filter is active, ensure it's marked as giveaway
      if ((soldPrice === 0 || soldPrice === null) && giveawayFilterActive && !isPaymentPending) {
        isGiveaway = true;
        soldPrice = 0;
        console.log('[Whatnot Pulse] Marking as giveaway (giveaway filter active + no price)');
      }

      // Final giveaway check: Ensure giveaways are properly marked
      // If price is 0 and it's not a payment pending, it must be a giveaway
      if ((soldPrice === 0 || soldPrice === null) && !isPaymentPending && !isGiveaway) {
        // Double-check: If we have a buyer but no price, it's likely a giveaway
        if (buyerUsername && buyerUsername !== 'unknown') {
          isGiveaway = true;
          console.log('[Whatnot Pulse] Marking as giveaway (price=0/null, has buyer, not pending)');
        }
      }
      
      // Ensure giveaways always have price = 0
      if (isGiveaway) {
        soldPrice = 0;
      }
      
      // Extract payment status string
      let payment_status = null;
      if (isPaymentPending) {
        payment_status = "Payment Pending";
      } else if (soldPrice !== null && !isGiveaway) {
        payment_status = "Completed";
      }
      
      // VALIDATION: Payment pending items should NOT be sent as completed sales
      // They should be tracked separately and only sent once payment clears
      // Skip creating sale object if this is a payment pending item in batch extraction
      if (isPaymentPending && payment_status === 'Payment Pending') {
        console.log('[Whatnot Pulse] Skipping payment pending item - will not create sale object:', itemName);
        // Return null to skip this item in batch extraction
        // In live monitoring, we track it but don't send as completed
        return null;
      }
      
      // Create sale object - matching Lovable API format
      const sale = {
        streamer_username: streamerUsername,
        item_name: itemName.trim(),
        sold_price: isGiveaway ? 0 : (soldPrice || 0), // Ensure giveaways are always 0
        buyer_username: buyerUsername,
        is_giveaway: isGiveaway || (soldPrice === 0 && !isPaymentPending), // More aggressive giveaway detection
        is_pending: isPaymentPending, // NEW: Track pending payments
        payment_status: payment_status, // NEW: Payment status string ("Payment Pending", "Completed", or null)
        pending_items: pendingItems || undefined, // Only include if we found a count
        raw_data: {
          timestamp: timestamp,
          listingId: listingId || undefined,
          href: element.querySelector('a')?.getAttribute('href') || undefined,
          imageUrl: element.querySelector('img')?.getAttribute('src') || undefined,
          element_html: element.outerHTML.substring(0, 500) // Store snippet for debugging
        }
      };
      
      // Log giveaway status for debugging
      if (sale.is_giveaway) {
        console.log('[Whatnot Pulse] 🎁 SALE IS A GIVEAWAY:', {
          item: sale.item_name,
          price: sale.sold_price,
          is_giveaway: sale.is_giveaway,
          buyer: sale.buyer_username
        });
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2251',message:'GIVEAWAY SALE CREATED',data:{itemName:sale.item_name,price:sale.sold_price,buyer:sale.buyer_username,is_giveaway:sale.is_giveaway},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'GIVEAWAY'})}).catch(()=>{});
        // #endregion
      }
      
      // Remove undefined fields from raw_data
      Object.keys(sale.raw_data).forEach(key => {
        if (sale.raw_data[key] === undefined) {
          delete sale.raw_data[key];
        }
      });
      
      // Remove undefined pending_items
      if (sale.pending_items === undefined) {
        delete sale.pending_items;
      }

      // Log giveaway status for debugging
      if (sale.is_giveaway) {
        console.log('[Whatnot Pulse] 🎁 SALE IS A GIVEAWAY:', {
          item: sale.item_name,
          price: sale.sold_price,
          is_giveaway: sale.is_giveaway,
          buyer: sale.buyer_username
        });
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2244',message:'GIVEAWAY SALE CREATED',data:{itemName:sale.item_name,price:sale.sold_price,buyer:sale.buyer_username,is_giveaway:sale.is_giveaway},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'GIVEAWAY'})}).catch(()=>{});
        // #endregion
      }
      
      console.log('[Whatnot Pulse] Successfully extracted sale:', {
        item: sale.item_name,
        price: sale.sold_price,
        buyer: sale.buyer_username,
        isGiveaway: sale.is_giveaway,
        isPending: sale.is_pending
      });

      return sale;
    } catch (error) {
      console.error('[Whatnot Pulse] Error extracting sale data:', error);
      return null;
    }
  }

  /**
   * Extract full sales history for current stream
   * Activates filter, scrolls to load all items, and extracts all sales in batch
   * @returns {Promise<Array>} Array of sale objects
   */
  /**
   * Sync all sales from full history (batch extraction)
   * Uses aggressive scrolling and sends as batch to background
   * @returns {Promise<Array>} Array of sale objects
   */
  async function syncAllSales() {
    console.log('[Whatnot Pulse] Starting full history sync (syncAllSales)...');
    
    try {
      // 1. Activate "Sold" filter using text-based matching (XPath + fallback)
      const filterActivated = await ensureSoldFilterActive();
      if (!filterActivated) {
        console.warn('[Whatnot Pulse] Could not activate Sold filter, continuing anyway...');
      }
      
      // Wait a moment for filter to apply
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 2. Find sales container
      const container = findSalesContainer();
      if (!container) {
        console.warn('[Whatnot Pulse] Could not find sales container');
        return [];
      }
      
      console.log('[Whatnot Pulse] Found sales container, harvesting full history...');
      
      // 3. Harvest all sales with aggressive auto-scroll (interval-based)
      await harvestFullHistory(container);
      
      // Wait for DOM to stabilize after scrolling
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 4. Extract all sales in batch
      const allSales = [];
      const saleElements = document.querySelectorAll('[data-testid="show-buyer-details"]');
      
      console.log(`[Whatnot Pulse] Extracting ${saleElements.length} sales...`);
      
      // Track seen signatures for deduplication
      const seenSignatures = new Set();
      
      for (const buyerEl of saleElements) {
        const saleContainer = buyerEl.closest('div.py-4, section, div[class*="py"], div[class*="item"], div[class*="card"]');
        if (saleContainer) {
          const saleData = extractSaleData(saleContainer);
          if (saleData) {
            // Skip if marked as payment pending (don't mark as confirmed sale yet)
            if (saleData.is_pending && saleData.payment_status === 'Payment Pending') {
              console.log('[Whatnot Pulse] Skipping payment pending item (not confirmed):', saleData.item_name);
              continue;
            }
            
            // Deduplication: Use unique signature (Price + Timestamp + Item Name)
            const signature = `${saleData.sold_price}_${saleData.item_name}_${saleData.buyer_username}`.toLowerCase();
            if (!seenSignatures.has(signature)) {
              seenSignatures.add(signature);
              allSales.push(saleData);
            } else {
              console.log('[Whatnot Pulse] Skipping duplicate sale:', saleData.item_name);
            }
          }
        }
      }
      
      console.log(`[Whatnot Pulse] Extracted ${allSales.length} unique sales from full history (${seenSignatures.size} total, ${saleElements.length - allSales.length} duplicates/pending skipped)`);
      
      return allSales;
    } catch (error) {
      console.error('[Whatnot Pulse] Error syncing full history:', error);
      return [];
    }
  }

  /**
   * Extract full history for current stream
   * Alias for syncAllSales for backward compatibility
   * @returns {Promise<Array>} Array of sale objects
   */
  async function extractFullHistory() {
    return syncAllSales();
  }

  /**
   * Create transaction signature for deduplication
   * Uses streamer, item, buyer, price, and listingId/timestamp to create unique signature
   * For same-item same-buyer scenarios, includes timestamp rounded to minute to allow multiple sales
   */
  function createTransactionSignature(sale, element = null) {
    const price = sale.sold_price || 0;
    const itemName = (sale.item_name || '').trim().toLowerCase();
    const buyer = (sale.buyer_username || '').trim().toLowerCase();
    const streamer = (sale.streamer_username || '').trim().toLowerCase();
    
    // Use listingId if available (most reliable for uniqueness - same listing = same sale)
    // Otherwise, use timestamp rounded to minute + element position to allow same-item same-buyer sales at different times
    // This prevents duplicates while allowing legitimate multiple sales
    let uniqueId = '';
    if (sale.raw_data && sale.raw_data.listingId) {
      uniqueId = sale.raw_data.listingId;
    } else {
      // Round timestamp to minute to prevent re-extraction duplicates but allow time-based uniqueness
      const now = new Date();
      const minuteTimestamp = Math.floor(now.getTime() / 60000); // Round to minute
      // Also include element position if available for additional uniqueness within same minute
      let elementPos = '';
      if (element) {
        try {
          const parent = element.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children);
            const index = siblings.indexOf(element);
            elementPos = `p${index}`;
          }
        } catch (e) {
          // Ignore errors getting position
        }
      }
      uniqueId = `t${minuteTimestamp}${elementPos}`;
    }
    
    // Create signature with unique identifier to handle same-item same-buyer scenarios
    const signature = `${streamer}|${itemName}|${buyer}|${price}|${uniqueId}`;
    
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2831',message:'Creating transaction signature',data:{signature,streamer,itemName:itemName.substring(0,50),buyer,price,uniqueId,isDuplicate:processedTransactions.has(signature)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'DUPLICATE'})}).catch(()=>{});
    // #endregion
    
    return signature;
  }

  // Track processed DOM elements to avoid processing same element twice in same batch
  let processedElements = new WeakSet();

  /**
   * Process newly detected sales
   * @param {Array|NodeList} addedNodes - Array of DOM nodes or elements to process
   * @param {boolean} forceProcess - If true, process even if element was seen before (for initial scan)
   */
  function processNewSales(addedNodes, forceProcess = false) {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1697',message:'processNewSales called',data:{nodeCount:addedNodes.length,processedSetSize:processedTransactions.size},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    
    const newSales = [];
    let saleElementsFound = 0;
    let salesExtracted = 0;
    let salesSkipped = 0;
    let duplicatesSkipped = 0;
    const elementsInThisBatch = new Set(); // Track elements processed in this batch
    
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1711',message:'processNewSales started',data:{nodeCount:addedNodes.length,forceProcess,processedSetSize:processedTransactions.size},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion

    for (const node of addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      // Look for sold item cards - each sale is in a div.py-4 container
      // Check if this node or its parent matches the sold item structure
      let saleElement = null;
      
      // Check if node itself is a sold item card
      if (node.classList && node.classList.contains('py-4')) {
        saleElement = node;
        saleElementsFound++;
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1150',message:'Found sale element - node has py-4 class',data:{nodeTag:node.tagName,nodeText:node.textContent?.substring(0,100)||'empty'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
      }
      
      // Check if node contains sold item cards
      if (!saleElement && node.querySelector) {
        // Look for div.py-4 containers or sections with grid classes
        saleElement = node.querySelector('div.py-4, div.py-4 section[class*="grid"], section[class*="grid"]');
        if (saleElement) {
          saleElementsFound++;
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1156',message:'Found sale element via querySelector',data:{saleElementTag:saleElement.tagName},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
          // #endregion
        }
      }
      
      // Check if node is inside a sold item card
      if (!saleElement) {
        const parentCard = node.closest('div.py-4, section[class*="grid"], section[class*="container"]');
        if (parentCard) {
          // If we found a grid section, try to get the py-4 parent
          saleElement = parentCard.closest('div.py-4') || parentCard;
          if (saleElement) {
            saleElementsFound++;
            // #region agent log
            fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1164',message:'Found sale element via closest',data:{saleElementTag:saleElement.tagName},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
            // #endregion
          }
        }
      }

      if (saleElement) {
        // Skip if we've already processed this element in this batch
        if (elementsInThisBatch.has(saleElement)) {
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1755',message:'Skipping - element already processed in this batch',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
          // #endregion
          continue;
        }
        
        // Check if this looks like a sale item (has buyer details)
        const hasBuyerDetails = saleElement.querySelector('[data-testid="show-buyer-details"]');
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1762',message:'Checking sale element for buyer details',data:{hasBuyerDetails:!!hasBuyerDetails,elementText:saleElement.textContent?.substring(0,150)||'empty'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
        // #endregion
        
        if (hasBuyerDetails) {
          // Mark this element as processed in this batch
          elementsInThisBatch.add(saleElement);
          
          const sale = extractSaleData(saleElement);
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1175',message:'Sale extraction result',data:{saleExtracted:!!sale,hasItemName:!!sale?.item_name,hasPrice:sale?.sold_price!==undefined,hasBuyer:!!sale?.buyer_username},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          
          if (sale) {
            salesExtracted++;
            const signature = createTransactionSignature(sale, saleElement);
            
            // #region agent log
            fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1763',message:'Checking deduplication',data:{signature,isDuplicate:processedTransactions.has(signature),setSize:processedTransactions.size,itemName:sale.item_name?.substring(0,50),buyer:sale.buyer_username,price:sale.sold_price},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
            // #endregion
            
            // Deduplication check (skip if forceProcess is true for historical sales)
            const isDuplicate = processedTransactions.has(signature);
            if (!isDuplicate || forceProcess) {
              if (!isDuplicate) {
                processedTransactions.add(signature);
              }
              
              // Log giveaway detection for debugging
              if (sale.is_giveaway) {
                console.log('[Whatnot Pulse] ✅ GIVEAWAY DETECTED:', sale.item_name, 'Price:', sale.sold_price, 'is_giveaway:', sale.is_giveaway);
                // #region agent log
                fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2379',message:'GIVEAWAY ADDED',data:{itemName:sale.item_name,price:sale.sold_price,buyer:sale.buyer_username,is_giveaway:sale.is_giveaway},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'GIVEAWAY'})}).catch(()=>{});
                // #endregion
              }
              
              newSales.push(sale);
              // #region agent log
              fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2383',message:'NEW SALE ADDED to queue',data:{signature,itemName:sale.item_name?.substring(0,50),price:sale.sold_price,buyer:sale.buyer_username,is_giveaway:sale.is_giveaway,forceProcess,setSize:processedTransactions.size},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
              // #endregion
              console.log(`[Whatnot Pulse] New sale detected${forceProcess ? ' (forced - historical)' : ''}:`, sale);
            } else {
              salesSkipped++;
              duplicatesSkipped++;
              // #region agent log
              fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1783',message:'Sale SKIPPED - duplicate',data:{signature,itemName:sale.item_name?.substring(0,50),buyer:sale.buyer_username,price:sale.sold_price},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
              // #endregion
              console.log('[Whatnot Pulse] Duplicate sale skipped:', signature);
            }
          }
        }
      } else {
        // Fallback: check if element has sale indicators (older method)
        const elementText = node.textContent || '';
        const hasBuyerDetails = node.querySelector && node.querySelector('[data-testid="show-buyer-details"]');
        
        if (hasBuyerDetails || (/\$?\s*\d+/.test(elementText) && /Buyer:/i.test(elementText))) {
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1198',message:'Trying fallback extraction',data:{hasBuyerDetails:!!hasBuyerDetails,hasPricePattern:/\$?\s*\d+/.test(elementText),hasBuyerPattern:/Buyer:/i.test(elementText)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
          // #endregion
          
          const sale = extractSaleData(node);
          if (sale) {
            salesExtracted++;
            const signature = createTransactionSignature(sale, node);
            
            // #region agent log
            fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1796',message:'Checking deduplication (fallback)',data:{signature,isDuplicate:processedTransactions.has(signature),setSize:processedTransactions.size,itemName:sale.item_name?.substring(0,50)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
            // #endregion
            
            if (!processedTransactions.has(signature)) {
              processedTransactions.add(signature);
              newSales.push(sale);
              // #region agent log
              fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1803',message:'NEW SALE ADDED (fallback)',data:{signature,itemName:sale.item_name?.substring(0,50),price:sale.sold_price,buyer:sale.buyer_username},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
              // #endregion
              console.log('[Whatnot Pulse] New sale detected (fallback):', sale);
            } else {
              salesSkipped++;
              // #region agent log
              fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1810',message:'Sale SKIPPED - duplicate (fallback)',data:{signature,itemName:sale.item_name?.substring(0,50)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
              // #endregion
              console.log('[Whatnot Pulse] Duplicate sale skipped (fallback):', signature);
            }
          }
        }
      }
    }

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2000',message:'processNewSales summary',data:{totalNodes:addedNodes.length,saleElementsFound,salesExtracted,salesSkipped,duplicatesSkipped,newSalesCount:newSales.length,forceProcess,processedSetSize:processedTransactions.size},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
    
    console.log(`[Whatnot Pulse] processNewSales complete: ${newSales.length} new sales, ${salesSkipped} skipped (${duplicatesSkipped} duplicates), ${saleElementsFound} elements found`);

    // Send sales to background script
    if (newSales.length > 0) {
      console.log('[Whatnot Pulse] Sending', newSales.length, 'sales to background script:', newSales);
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1404',message:'Sending sales to background',data:{salesCount:newSales.length,sales:newSales.map(s=>({item:s.item_name,price:s.sold_price,buyer:s.buyer_username}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
      
      safeSendMessage({
        type: 'NEW_SALE',
        sales: newSales
      }, (response) => {
        if (response && response.error) {
          // Error already logged in safeSendMessage
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:3502',message:'ERROR sending sales - runtime error',data:{error:response.error},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
          // #endregion
        } else {
          console.log('[Whatnot Pulse] Sales sent successfully, response:', response);
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:3506',message:'Sales sent successfully',data:{response,salesCount:newSales.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
          // #endregion
        }
      });
    } else {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1427',message:'No new sales to send',data:{processedCount:processedTransactions.size},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
    }
  }

  /**
   * Debounced mutation observer callback
   */
  function handleMutations(mutationsList) {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1221',message:'Mutation detected',data:{mutationCount:mutationsList.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
    // #endregion
    
    clearTimeout(debounceTimer);
    
    debounceTimer = setTimeout(() => {
      const addedNodes = [];
      
      for (const mutation of mutationsList) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              addedNodes.push(node);
            }
          });
        }
      }

      // #region agent log
      if (addedNodes.length > 0) fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1237',message:'Processing added nodes',data:{nodeCount:addedNodes.length,firstNodeTag:addedNodes[0]?.tagName||'null',firstNodeClass:addedNodes[0]?.className?.substring(0,30)||'null'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion

      if (addedNodes.length > 0) {
        processNewSales(addedNodes);
      }
    }, CONFIG.DEBOUNCE_DELAY);
  }

  /**
   * Initialize the sales monitoring system
   */
  async function initializeSalesMonitoring() {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1480',message:'initializeSalesMonitoring called',data:{isLivePage:isLiveStreamPage(),hasStreamer:!!streamerUsername},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    
    // First, ensure we have a streamer username and we're on a live page
    if (!isLiveStreamPage()) {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1485',message:'Sales monitoring aborted - not on live page',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      return;
    }

    if (!streamerUsername) {
      if (!initializeStreamTracking()) {
        // Retry stream tracking, then initialize monitoring
        setTimeout(initializeSalesMonitoring, 2000);
        return;
      }
    }

    if (!isMonitoringLive) {
      isMonitoringLive = true;
    }

    // Strategy A: Try to find sales WITHOUT activating filter first
    console.log('[Whatnot Pulse] Strategy A: Attempting to find sales without filter...');
    const salesWithoutFilter = findSalesWithoutFilter();
    let salesContainer = null;
    let shouldUseFilter = false;
    
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1690',message:'Strategy A result',data:{salesFound:salesWithoutFilter.count,hasContainer:!!salesWithoutFilter.container},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    
    if (salesWithoutFilter.count > 10) {
      // Found enough sales without filter, use this strategy
      console.log('[Whatnot Pulse] Strategy A successful: Found', salesWithoutFilter.count, 'sales without filter');
      salesContainer = salesWithoutFilter.container;
    } else {
      // Strategy B: Not enough sales found, activate filter and try again
      console.log('[Whatnot Pulse] Strategy A found insufficient sales (', salesWithoutFilter.count, '), trying Strategy B with filter...');
      shouldUseFilter = true;
      
      // Store preference
      sessionStorage.setItem('whatnot-pulse-sold-filter', 'true');
      
      // Activate filter
      const filterActivated = await ensureSoldFilterActive();
      
      if (filterActivated) {
        // Wait for filter to apply
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Try finding container again with filter active
        salesContainer = findSalesContainer();
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1708',message:'Strategy B result',data:{found:!!salesContainer,containerClass:salesContainer?.className?.substring(0,50)||'null'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
      } else {
        // Filter activation failed, use what we found without filter (this is expected sometimes)
        salesContainer = salesWithoutFilter.container || findSalesContainer();
      }
    }
    
    if (salesContainer) {
      // Create mutation observer
      const observerConfig = {
        childList: true,
        subtree: true,
        characterData: false,
        attributes: false
      };

      observer = new MutationObserver(handleMutations);
      observer.observe(salesContainer, observerConfig);
      
      console.log('[Whatnot Pulse] Sales monitoring initialized on container:', salesContainer);
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1277',message:'MutationObserver created and observing',data:{containerTag:salesContainer.tagName,containerId:salesContainer.id||'none'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      
      // Also observe document body as fallback for dynamic content
      const bodyObserver = new MutationObserver(handleMutations);
      bodyObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1283',message:'Also observing document.body',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion

      // Initial comprehensive scan for ALL existing sales (with scrolling to load all)
      if (CONFIG.SCAN_ALL_ON_INIT) {
        console.log('[Whatnot Pulse] Performing comprehensive initial scan - loading all historical sales...');
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1680',message:'Starting comprehensive sales scan with dual strategy',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        
        // Strategy A: Try finding sales WITHOUT filter first
        const withoutFilterResult = findSalesWithoutFilter();
        let saleElementsWithBuyers = withoutFilterResult.sales || [];
        let workingContainer = withoutFilterResult.container || salesContainer;
        
        console.log(`[Whatnot Pulse] Strategy A (no filter): Found ${saleElementsWithBuyers.length} sales`);
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:1688',message:'Strategy A result',data:{salesFound:saleElementsWithBuyers.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        
        // Strategy B: If Strategy A found few/no sales, activate filter and try again
        if (saleElementsWithBuyers.length < 10) {
          console.log('[Whatnot Pulse] Strategy A found few sales, trying Strategy B (with filter)...');
          const filterActivated = await ensureSoldFilterActive();
          
          if (filterActivated) {
            // Wait for filter to apply and DOM to update
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Re-find container with filter active
            const filteredContainer = findSalesContainer();
            if (filteredContainer) {
              workingContainer = filteredContainer;
              
              // Scroll to load all items with filter active
              await loadAllSalesByScrolling(filteredContainer);
              await new Promise(resolve => setTimeout(resolve, 1500));
            }
          }
        } else {
          // Strategy A worked! Scroll to load all items
          await loadAllSalesByScrolling(workingContainer);
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
        
        // Final scan: Find all sales after scrolling
        console.log('[Whatnot Pulse] Performing final comprehensive scan for all sales...');
        const allBuyerDetails = document.querySelectorAll('[data-testid="show-buyer-details"]');
        console.log(`[Whatnot Pulse] Found ${allBuyerDetails.length} buyer detail elements in DOM`);
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2211',message:'Final scan - buyer details found',data:{buyerDetailsCount:allBuyerDetails.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        
        saleElementsWithBuyers = [];
        let pendingSkipped = 0;
        
        for (const buyerEl of allBuyerDetails) {
          // Include ALL items (completed sales AND pending payments)
          // Don't skip payment pending items - we want to track them
          const container = buyerEl.closest('div.py-4, section, div[class*="py"]');
          if (container && !saleElementsWithBuyers.includes(container)) {
            saleElementsWithBuyers.push(container);
          }
          
          // Count pending items for logging
          const parentText = buyerEl.parentElement?.textContent || buyerEl.textContent || '';
          if (parentText.includes('Payment Pending')) {
            pendingSkipped++; // Count for logging, but don't skip
          }
        }
        
        console.log(`[Whatnot Pulse] Final scan results: ${saleElementsWithBuyers.length} sales found, ${pendingSkipped} pending items skipped`);
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2227',message:'Final sales count after scrolling',data:{totalSales:saleElementsWithBuyers.length,pendingSkipped,buyerDetailsFound:allBuyerDetails.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        
        if (saleElementsWithBuyers.length > 0) {
          console.log(`[Whatnot Pulse] ⚡ Found ${saleElementsWithBuyers.length} existing sales after comprehensive scan, processing NOW...`);
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2233',message:'About to process historical sales',data:{salesToProcess:saleElementsWithBuyers.length,processedTransactionsSize:processedTransactions.size},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
          // #endregion
          
          // Process all historical sales - force process to ensure they're all sent
          // Note: forceProcess=true means we'll send even if signature exists (for historical sync)
          processNewSales(saleElementsWithBuyers, true);
          lastSalesCount = saleElementsWithBuyers.length;
          
          console.log(`[Whatnot Pulse] ✅ Historical sales processing complete. Processed ${saleElementsWithBuyers.length} sales.`);
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2241',message:'Processed all historical sales',data:{totalSales:saleElementsWithBuyers.length,processedTransactionsSize:processedTransactions.size},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
          // #endregion
        } else {
          console.warn(`[Whatnot Pulse] ⚠️ No existing sales found in comprehensive scan. Found ${allBuyerDetails.length} buyer details but ${pendingSkipped} were pending.`);
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2246',message:'WARNING: No sales found after scan',data:{buyerDetailsFound:allBuyerDetails.length,pendingSkipped,hasWorkingContainer:!!workingContainer},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
          // #endregion
        }
      }

      // Start periodic polling as backup to catch any missed sales
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2392',message:'About to start sales polling',data:{hasContainer:!!salesContainer,containerTag:salesContainer?.tagName||'null'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      startSalesPolling(salesContainer);
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2394',message:'Sales polling started',data:{pollingIntervalActive:!!salesPollingInterval},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
    } else {
      // Sales container not found, retrying... (this is expected sometimes)
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2396',message:'Sales container NOT found - will retry',data:{url:window.location.href},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      // Retry after delay
      setTimeout(initializeSalesMonitoring, 3000);
    }
  }

  /**
   * Handle URL changes (SPA navigation)
   */
  function handleUrlChange() {
    const currentUrl = window.location.href;
    
    if (currentUrl === lastUrl) {
      return; // No change
    }

    console.log('[Whatnot Pulse] URL changed from:', lastUrl, 'to:', currentUrl);
    const wasOnLive = lastUrl.includes('/live/');
    const isOnLive = currentUrl.includes('/live/');

    // ACCURACY FIRST: Check if livestream ID changed (primary key for session)
    if (wasOnLive && isOnLive) {
      const previousStreamId = extractStreamIdFromUrl(lastUrl);
      const currentStreamId = extractStreamIdFromUrl(currentUrl);
      
      if (previousStreamId && currentStreamId && previousStreamId !== currentStreamId) {
        console.log('[Whatnot Pulse] Livestream ID changed - resetting all local state (Accuracy First)');
        console.log('[Whatnot Pulse] Previous stream ID:', previousStreamId, 'New stream ID:', currentStreamId);
        
        // Clear all local state - duration, viewer count, sales cache
        streamerUsername = null;
        processedTransactions.clear();
        lastSalesCount = 0;
        isMonitoringLive = false;
        stopViewerCountUpdates();
        stopSalesPolling();
        
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        
        // Notify background script to reset session
        safeSendMessage({
          type: 'STREAM_ID_CHANGED',
          data: {
            previous_stream_id: previousStreamId,
            new_stream_id: currentStreamId,
            previous_url: lastUrl,
            new_url: currentUrl
          }
        });
      }
    }

    lastUrl = currentUrl;

    // If we left a live stream
    if (wasOnLive && !isOnLive) {
      console.log('[Whatnot Pulse] Left live stream page');
      isMonitoringLive = false;
      stopViewerCountUpdates();
      stopSalesPolling();
      
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      
      // Stop sales polling
      stopSalesPolling();
    
    processedTransactions.clear();
    streamerUsername = null;
      
      // Notify background script
      safeSendMessage({ type: 'STREAM_LEFT' }, (response) => {
        if (response && response.error) {
          // Error already logged in safeSendMessage
          console.error('[Whatnot Pulse] Error sending STREAM_LEFT:', response.error);
        } else {
          console.log('[Whatnot Pulse] STREAM_LEFT sent successfully');
        }
      });
    }
    // If we entered a live stream
    else if (!wasOnLive && isOnLive) {
      console.log('[Whatnot Pulse] Entered live stream page');
      // Reset state
      processedTransactions.clear();
      streamerUsername = null;
      
      // Wait a bit for page to load, then initialize
      // Re-activate Sold filter if preference is set
      if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('wnpulse_sold_filter_active') === 'true') {
        setTimeout(async () => {
          console.log('[Whatnot Pulse] Initializing after entering live stream with filter reactivation...');
          await ensureSoldFilterActive();
          initializeStreamTracking();
          initializeSalesMonitoring();
        }, 2000);
      } else {
        setTimeout(() => {
          console.log('[Whatnot Pulse] Initializing after entering live stream...');
          initializeStreamTracking();
          initializeSalesMonitoring();
        }, 2000);
      }
    } 
    // If we entered a profile page
    const wasOnProfile = lastUrl.match(/^https?:\/\/[^\/]+\/user\/[^\/]+/);
    const isOnProfile = currentUrl.match(/^https?:\/\/[^\/]+\/user\/[^\/]+/);
    if (!wasOnProfile && isOnProfile) {
      console.log('[Whatnot Pulse] Entered profile page');
      setTimeout(() => {
        initializeProfileScraping();
      }, 2000);
    }
    else if (isOnLive) {
      // We're still on a live stream but URL might have changed (page refresh or SPA navigation)
      // Re-activate filter if needed to persist across refreshes
      if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('wnpulse_sold_filter_active') === 'true') {
        setTimeout(async () => {
          console.log('[Whatnot Pulse] Re-activating Sold filter after URL change...');
          await ensureSoldFilterActive();
        }, 2000);
      }
    }
    // If we're navigating between live streams
    else if (wasOnLive && isOnLive) {
      console.log('[Whatnot Pulse] Navigated to different live stream');
      // Reset and reinitialize
      processedTransactions.clear();
      streamerUsername = null;
      stopViewerCountUpdates();
      
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      
      setTimeout(() => {
        console.log('[Whatnot Pulse] Re-initializing for new stream...');
        initializeStreamTracking();
        initializeSalesMonitoring();
      }, 2000);
    }
  }

  /**
   * Main initialization
   */
  function init() {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:2502',message:'init() called',data:{url:window.location.href,pathname:window.location.pathname,isLivePage:isLiveStreamPage(),readyState:document.readyState},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    console.log('[Whatnot Pulse] Content script loaded on:', window.location.href);
    console.log('[Whatnot Pulse] Pathname:', window.location.pathname);
    console.log('[Whatnot Pulse] Is live page:', isLiveStreamPage());
    
    // Debug: Log all user links found on page with their context
    const userLinks = document.querySelectorAll('a[href*="/user/"]');
    console.log('[Whatnot Pulse] Found', userLinks.length, 'user links on page');
    userLinks.forEach((el, idx) => {
      if (idx < 10) { // Log first 10 to help debugging
        const href = el.href;
        const match = href.match(/\/user\/([^\/\?]+)/);
        const username = match ? match[1] : 'unknown';
        const isInNav = el.closest('nav, header, [role="navigation"], [class*="nav"], [class*="user-menu"]');
        const isInVideo = el.closest('[class*="video"], [class*="player"], [class*="stream"], [class*="live"]');
        const context = isInNav ? 'NAV' : isInVideo ? 'VIDEO' : 'OTHER';
        console.log(`[Whatnot Pulse] User link ${idx + 1}: ${username} | Context: ${context} | Text: ${el.textContent?.trim()?.substring(0, 30)}`);
      }
    });
    
    // Store preference for Sold filter in sessionStorage
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('wnpulse_sold_filter_active', 'true');
    }

    // Initialize if on live stream page
    if (isLiveStreamPage()) {
      console.log('[Whatnot Pulse] On live stream page, initializing tracking...');
      
      // Wait for DOM to be ready
      if (document.readyState === 'loading') {
        console.log('[Whatnot Pulse] DOM still loading, waiting...');
        document.addEventListener('DOMContentLoaded', () => {
          console.log('[Whatnot Pulse] DOM loaded, starting initialization in 2s...');
          setTimeout(() => {
            initializeStreamTracking();
            initializeSalesMonitoring();
          }, 2000);
        });
      } else {
        console.log('[Whatnot Pulse] DOM already ready, starting initialization in 2s...');
        setTimeout(() => {
          initializeStreamTracking();
          initializeSalesMonitoring();
        }, 2000);
      }
    } else if (isProfilePage()) {
      console.log('[Whatnot Pulse] On profile page, initializing profile scraping...');
      
      // Wait for DOM to be ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          setTimeout(() => {
            initializeProfileScraping();
          }, 2000);
        });
    } else {
        setTimeout(() => {
          initializeProfileScraping();
        }, 2000);
      }
    } else {
      console.log('[Whatnot Pulse] Not on live stream or profile page, skipping initialization');
    }

    // Monitor URL changes for SPA navigation
    setInterval(handleUrlChange, 1000);

    // Also listen for pushstate/popstate events (SPA navigation)
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function(...args) {
      originalPushState.apply(history, args);
      setTimeout(handleUrlChange, 100);
    };

    history.replaceState = function(...args) {
      originalReplaceState.apply(history, args);
      setTimeout(handleUrlChange, 100);
    };

    window.addEventListener('popstate', () => {
      setTimeout(handleUrlChange, 100);
    });

    // Listen for messages from popup/background
    try {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        try {
          // Check if extension context is still valid (this might throw if invalidated)
          if (chrome.runtime.lastError) {
            console.warn('[Whatnot Pulse] Extension context invalidated:', chrome.runtime.lastError.message);
            return false;
          }

          try {
        if (message.type === 'GET_VIEWER_COUNT') {
          const viewerCount = getViewerCount();
          const pendingItems = extractPendingItemsCount();
          const streamStartTime = getStreamStartTime();
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/0b10f26a-c3be-4a7b-8048-763c7bd44ca8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'content.js:3446',message:'GET_VIEWER_COUNT response',data:{viewerCount,viewerCountType:typeof viewerCount,pendingItems,streamStartTime},timestamp:Date.now(),sessionId:'debug-session',runId:'run5',hypothesisId:'H4,H5'})}).catch(()=>{});
          // #endregion
          try {
            sendResponse({ viewerCount: viewerCount, pendingItems: pendingItems, stream_start_time: streamStartTime });
          } catch (e) {
            console.warn('[Whatnot Pulse] Could not send GET_VIEWER_COUNT response:', e);
          }
        } else if (message.type === 'CHECK_STREAM_STATUS') {
          // Check if stream is actually live (not just tab open)
          const isLive = isLiveStreamPage();
          const viewerCount = isLive ? getViewerCount() : null;
          const streamStartTime = isLive ? getStreamStartTime() : null;
          // Additional check: look for live indicators
          const hasLiveIndicator = document.querySelector('[class*="live"], [class*="LIVE"], [data-testid*="live"]');
          const isActuallyLive = isLive && (hasLiveIndicator || viewerCount !== null);
          try {
            sendResponse({ 
              isLive: isActuallyLive, 
              viewerCount: viewerCount,
              stream_start_time: streamStartTime
            });
          } catch (e) {
            console.warn('[Whatnot Pulse] Could not send CHECK_STREAM_STATUS response:', e);
          }
        } else if (message.type === 'GET_PENDING_ITEMS') {
          // Handler to respond with pending items count when requested by background script
          const pendingItems = extractPendingItemsCount();
          try {
            sendResponse({ pendingItems: pendingItems });
          } catch (e) {
            console.warn('[Whatnot Pulse] Could not send GET_PENDING_ITEMS response:', e);
          }
        } else if (message.type === 'EXTRACT_FULL_HISTORY') {
          // Handle full history extraction request
          (async () => {
            try {
              const sales = await extractFullHistory();
              const streamId = extractStreamIdFromUrl();
              const streamStartTime = getStreamStartTime(true); // Use historical mode
              
              // Send response with full history data
              safeSendMessage({
                type: 'FULL_HISTORY_DATA',
                data: {
                  sales: sales,
                  stream_id: streamId,
                  stream_start_time: streamStartTime,
                  streamer_username: streamerUsername,
                  stream_url: window.location.href
                }
              });
              
              // Also send response to the immediate request
              try {
                sendResponse({ 
                  success: true, 
                  salesCount: sales.length,
                  streamId: streamId,
                  streamStartTime: streamStartTime
                });
              } catch (e) {
                console.warn('[Whatnot Pulse] Could not send EXTRACT_FULL_HISTORY response:', e);
              }
            } catch (error) {
              console.error('[Whatnot Pulse] Error in EXTRACT_FULL_HISTORY handler:', error);
              try {
                sendResponse({ success: false, error: error.message });
              } catch (e) {
                console.warn('[Whatnot Pulse] Could not send error response:', e);
              }
            }
          })();
          return true; // Keep channel open for async response
        } else if (message.type === 'GET_DOM_STRUCTURE') {
          // Diagnostic: Return DOM structure information for debugging
          const domInfo = {
            url: window.location.href,
            isLivePage: isLiveStreamPage(),
            title: {
              extracted: getStreamTitle(),
              pageTitle: document.title,
              metaOgTitle: document.querySelector('meta[property="og:title"]')?.getAttribute('content'),
              h1Elements: Array.from(document.querySelectorAll('h1')).map(h => ({
                text: h.textContent?.trim(),
                classes: h.className,
                html: h.outerHTML.substring(0, 200)
              })).filter(h => h.text && h.text.length > 0),
              titleElements: Array.from(document.querySelectorAll('[class*="title"]')).slice(0, 5).map(el => ({
                text: el.textContent?.trim()?.substring(0, 100),
                tag: el.tagName,
                classes: el.className?.substring(0, 100),
                dataTestId: el.getAttribute('data-testid')
              })).filter(el => el.text && el.text.length > 0)
            },
            viewerCount: {
              extracted: getViewerCount(),
              elements: Array.from(document.querySelectorAll('[class*="viewer"], [class*="watching"], [data-testid*="viewer"]')).slice(0, 5).map(el => ({
                text: el.textContent?.trim(),
                tag: el.tagName,
                classes: el.className?.substring(0, 100),
                dataTestId: el.getAttribute('data-testid'),
                html: el.outerHTML.substring(0, 200)
              }))
            },
            pendingItems: {
              extracted: extractPendingItemsCount(),
              elements: Array.from(document.querySelectorAll('[class*="pending"], [class*="queue"], [data-testid*="pending"]')).slice(0, 5).map(el => ({
                text: el.textContent?.trim(),
                tag: el.tagName,
                classes: el.className?.substring(0, 100),
                dataTestId: el.getAttribute('data-testid'),
                html: el.outerHTML.substring(0, 200)
              }))
            },
            streamerUsername: {
              extracted: streamerUsername,
              userLinks: Array.from(document.querySelectorAll('a[href*="/user/"]')).slice(0, 5).map(link => ({
                href: link.href,
                text: link.textContent?.trim()?.substring(0, 50),
                classes: link.className?.substring(0, 100),
                inNav: !!link.closest('nav, header')
              }))
            }
          };
          try {
            sendResponse({ domInfo: domInfo });
          } catch (e) {
            console.warn('[Whatnot Pulse] Could not send GET_DOM_STRUCTURE response:', e);
          }
        } else if (message.type === 'GET_STREAMER_USERNAME') {
          try {
            sendResponse({ streamer_username: streamerUsername });
          } catch (e) {
            console.warn('[Whatnot Pulse] Could not send GET_STREAMER_USERNAME response:', e);
          }
        } else if (message.type === 'EXTRACT_PROFILE_DATA') {
          // Trigger profile data extraction (for script injection from background)
          try {
            initializeProfileScraping();
            sendResponse({ success: true });
          } catch (e) {
            console.warn('[Whatnot Pulse] Could not extract profile data:', e);
            sendResponse({ success: false, error: e.message });
          }
        } else if (message.type === 'EXTRACT_SCHEDULED_LIVES') {
          // Trigger scheduled lives extraction (for script injection from background)
          try {
            const scheduledLives = extractScheduledLives();
            if (scheduledLives.length > 0) {
              safeSendMessage({
                type: 'SCHEDULED_LIVES',
                data: scheduledLives
              });
            }
            sendResponse({ success: true, count: scheduledLives.length });
          } catch (e) {
            console.warn('[Whatnot Pulse] Could not extract scheduled lives:', e);
            sendResponse({ success: false, error: e.message });
          }
        } else if (message.type === 'RESET_SESSION') {
          processedTransactions.clear();
          try {
            sendResponse({ success: true });
          } catch (e) {
            console.warn('[Whatnot Pulse] Could not send RESET_SESSION response:', e);
          }
        } else if (message.type === 'GET_DEBUG_INFO') {
          try {
            sendResponse({
              isLivePage: isLiveStreamPage(),
              streamerUsername: streamerUsername || null,
              url: window.location.href,
              pathname: window.location.pathname,
              userLinksFound: document.querySelectorAll('a[href*="/user/"]').length
            });
          } catch (e) {
            console.warn('[Whatnot Pulse] Could not send GET_DEBUG_INFO response:', e);
          }
        }
        return true; // Keep channel open for async response
        } catch (error) {
          console.error('[Whatnot Pulse] Error handling message:', error);
          try {
            sendResponse({ error: error.message });
          } catch (e) {
            // Extension context might be invalidated
            console.warn('[Whatnot Pulse] Could not send error response:', e);
          }
          return false;
        }
      } catch (e) {
        // Extension context completely invalidated - can't even check lastError
        console.warn('[Whatnot Pulse] Extension context invalidated in message listener:', e);
        return false;
      }
    });
    } catch (e) {
      console.warn('[Whatnot Pulse] Could not set up message listener (context invalidated):', e);
    }
  }

  // Start the extension
  init();
})();
