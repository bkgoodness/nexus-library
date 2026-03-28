// ─────────────────────────────────────────────────────────────
// BACKLOG ZERO — APPLICATION CORE
// Single-file architecture (V1)
// This file is organized into clearly defined systems:
//
// 1. CORE STATE / GLOBALS
// 2. STORAGE / DATA HELPERS
// 3. LIBRARY SYSTEM
// 4. STATS SYSTEM
// 5. IDENTITY SYSTEM
// 6. UI RENDERING
// 7. EVENT BINDINGS
// 8. UTILITIES
//
// NOTE:
// Do not insert new features randomly.
// Always place code inside the correct section.
// ─────────────────────────────────────────────────────────────

// app.js — Renderer process
// Communicates with main.js via window.nexus (defined in preload.js)

/* ═══════════════════════════════════════════
   NEXUS COLOR TOKENS — mirrors CSS token system
   Update here when changing themes. Never use
   raw hex elsewhere in this file.
═══════════════════════════════════════════ */

/* Read the active theme's CSS variables at runtime */
function getCSSToken(token) {
  return getComputedStyle(document.body)
    .getPropertyValue(token).trim();
}

/* Platform colors — references CSS vars so theme-switching works */
const PLAT_COLOR = {
  steam:    'var(--steam)',
  gog:      'var(--gog)',
  epic:     'var(--epic)',
  amazon:   'var(--amazon)',
  xbox:     'var(--xbox)',
  gamepass: 'var(--gamepass)',
};

/* Status colors */
const STATUS_COLOR = {
  exploring:    'var(--status-playing)',
  finished:     'var(--status-completed)',
  'not-for-me': 'var(--status-abandoned)',
  backlog:      'var(--status-backlog)',
};

/* Intent colors */
const INTENT_COLOR = {
  priority: 'var(--dupe)',
  queue:    'var(--status-playing)',
  playnext: 'var(--status-completed)',
};

/* Semantic one-offs used in inline styles throughout the file.
   Replace raw hex with COLOR.xxx at each call site. */
const COLOR = {
  success:   'var(--color-success)',
  warning:   'var(--color-warning)',
  error:     'var(--color-error)',
  pink:      'var(--color-pink)',
  star:      'var(--color-star)',
  mcGood:    'var(--color-mc-good)',
  mcMid:     'var(--color-mc-mid)',
  mcBad:     'var(--color-mc-bad)',
  muted:     'var(--text3)',
  accent:    'var(--accent)',
  steam:     'var(--steam)',
  dupe:      'var(--dupe)',
  backlog:   'var(--status-backlog)',
};
const STATUS_MIGRATE = { playing: 'exploring', completed: 'finished', abandoned: 'not-for-me', backlog: null, unplayed: null };

// Intent system
const INTENT_LABEL = { priority: '⭐ Focus List', queue: '📋 Queue', playnext: '▶ Play Next' };

const INTENT_ELIGIBLE = function(g) { return g.status !== 'finished' && g.status !== 'not-for-me'; };

// One-time fix: clear igdbNoArt flags that were incorrectly set because titles had " - Amazon Prime" etc. appended
var _igdbNoArtCleared = false;
async function clearWrongIgdbNoArt() {
  if (_igdbNoArtCleared) return;
  _igdbNoArtCleared = true;
  // Clear ALL igdbNoArt flags — the flag was set during sessions with buggy title cleaning
  // (platform suffixes not stripped, 429 failures mis-tagged as no-art). Can't trust any of them.
  // The flag will be re-set correctly going forward with the fixed cleaner.
  var toClear = games.filter(function(g) { return g.igdbNoArt; });
  if (!toClear.length) return;
  for (var i = 0; i < toClear.length; i++) {
    await window.nexus.games.update(toClear[i].id, { igdbNoArt: false });
    toClear[i].igdbNoArt = false;
  }
  console.log('[Nexus] Cleared igdbNoArt on', toClear.length, 'games — will retry cover fetch with fixed title cleaner');
}

// One-time migration: rename old status values to new ones
async function migrateStatusValues() {
  var toMigrate = games.filter(function(g) { return g.status in STATUS_MIGRATE; });
  if (!toMigrate.length) return;
  for (var i = 0; i < toMigrate.length; i++) {
    var g = toMigrate[i];
    var newStatus = STATUS_MIGRATE[g.status]; // may be null
    await window.nexus.games.update(g.id, { status: newStatus });
    g.status = newStatus;
  }
  console.log('[Nexus] Migrated ' + toMigrate.length + ' game statuses to new values');
}

// Set intent on a game
async function setGameIntent(gameId, intent) {
  var g = games.find(function(g) { return g.id === gameId; });
  if (!g || !INTENT_ELIGIBLE(g)) return;
  var newIntent = (g.intent === intent) ? null : intent; // toggle off if same
  await window.nexus.games.update(gameId, { intent: newIntent });
  g.intent = newIntent;
  if (currentDetailGame && currentDetailGame.id === gameId) currentDetailGame.intent = newIntent;
  renderIntentButtons(newIntent);
  renderLibrary();
}

function renderIntentButtons(activeIntent) {
  document.querySelectorAll('.intent-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.intent === activeIntent);
  });
}
const PLAT_LABEL = { steam: 'Steam', gog: 'GOG', epic: 'Epic', amazon: 'Amazon', xbox: 'Xbox', gamepass: 'Game Pass' };
const COVER_PALETTES = [
  ['#1a1a2e','#16213e'], ['#0d1b2a','#1b2838'],
  ['#1c0a00','#3d0c02'], ['#0a1628','#0d2137'],
  ['#1a0a1e','#2d1040'], ['#0a1a0a','#0d2a10'],
  ['#1e1200','#3d2800'], ['#1a001a','#280040'],
  ['#001a1a','#003d3d'], ['#1a1000','#382000'],
];

var BRAND_FOOTER_HTML = 
  '<div class="settings-brand-footer" style="margin-top:24px">' +
    '<img src="assets/bz_logo_circle_clean.svg" class="settings-brand-logo" alt="Backlog Zero">' +
    '<div class="settings-brand-text">' +
      '<div class="settings-brand-name">Backlog Zero</div>' +
      '<div class="settings-brand-tagline">B + Z = 0</div>' +
    '</div>' +
    '<div class="settings-brand-version" id="settingsVersion2"></div>' +
  '</div>';

// ── 1. CORE STATE / GLOBALS ───────────────────────────────────

let games = [];
let wishlist = [];
let ggdealsApiKey = '';
let rawgApiKey    = '';
let openxblApiKey = '';
let coverCache = {};       // game.id -> image URL
let wishCoverCache = {};   // wishlist item id -> image URL
let igdbClientId = '';
let igdbClientSecret = '';
let currentFilter = 'all';
let activePlatformSet = new Set(); // multi-selected platform chips
let currentView = 'grid';
var showHidden  = false; // when false, hidden games are excluded from grid/list
let wishSort = 'alpha'; // alpha | price | savings | owned
let wishFilterOwned = 'all'; // all | owned | unowned

// ── BULK SELECTION ──
var selectedGames = new Set(); // Set of game IDs
var bulkMode = false;

let currentPage = 'library';

// ── 2. STORAGE / DATA HELPERS ─────────────────────────────────
// ── INIT ──
// ── THEME ──
function initTheme() {
  var saved = localStorage.getItem('nexusTheme') || 'dark';
  applyTheme(saved);
}

function applyTheme(theme) {
  var fade = document.getElementById('themeFade');

  if (!fade) {
    document.body.classList.remove('light-mode');
    document.body.classList.remove('accessible-mode');

    if (theme === 'light') document.body.classList.add('light-mode');
    if (theme === 'accessible') document.body.classList.add('accessible-mode');

    localStorage.setItem('nexusTheme', theme);
    updateThemeIcons(theme);
    showThemeTooltip(theme);
    return;
  }

document.body.classList.add('theme-fading');

setTimeout(function() {
  document.body.classList.remove('light-mode');
  document.body.classList.remove('accessible-mode');

  if (theme === 'light') {
    document.body.classList.add('light-mode');
  }

  if (theme === 'accessible') {
    document.body.classList.add('accessible-mode');
  }

  localStorage.setItem('nexusTheme', theme);
  updateThemeIcons(theme);

  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      document.body.classList.remove('theme-fading');
    });
  });
}, 95);

showThemeTooltip(theme);
}

function showThemeTooltip(theme) {

  var label =
    theme === 'light' ? 'Light Mode' :
    theme === 'accessible' ? 'Accessible Mode' :
    'Dark Mode';

  var tip = document.createElement('div');

  tip.textContent = label;
  tip.style.position = 'fixed';
  tip.style.bottom = '18px';
  tip.style.left = '50%';
  tip.style.transform = 'translateX(-50%)';
  tip.style.padding = '6px 12px';
  tip.style.fontSize = '11px';
  tip.style.borderRadius = '20px';
  tip.style.background = 'var(--surface3)';
  tip.style.border = '1px solid var(--border2)';
  tip.style.color = 'var(--text)';
  tip.style.zIndex = '9999';
  tip.style.opacity = '0';
  tip.style.transition = 'opacity 180ms ease';

  document.body.appendChild(tip);

  requestAnimationFrame(function() {
    tip.style.opacity = '1';
  });

  setTimeout(function() {
    tip.style.opacity = '0';
    setTimeout(function() { tip.remove(); }, 180);
  }, 1400);

}

function toggleTheme() {

  var theme = localStorage.getItem('nexusTheme') || 'dark';

  if (theme === 'dark') theme = 'light';
  else if (theme === 'light') theme = 'accessible';
  else theme = 'dark';

  applyTheme(theme);

}

function updateThemeIcons(theme) {
  var moonIcon = document.querySelector('.icon-moon');
  var sunIcon = document.querySelector('.icon-sun');
  var accessIcon = document.querySelector('.icon-accessible');

  if (moonIcon) moonIcon.style.display = (theme === 'dark') ? '' : 'none';
  if (sunIcon) sunIcon.style.display = (theme === 'light') ? '' : 'none';
  if (accessIcon) accessIcon.style.display = (theme === 'accessible') ? '' : 'none';
}

async function init() {
  initTheme();
  games = await window.nexus.games.getAll();
  // Sanitize any negative playtimeHours that may have been stored from bad Steam data
  games.forEach(function(g) { if (g.playtimeHours < 0) g.playtimeHours = 0; });
  wishlist = await window.nexus.wishlist.getAll();
  await migrateStatusValues(); // one-time migration: old status values → new
  await clearWrongIgdbNoArt(); // one-time fix: clear igdbNoArt on games that had platform suffixes in title
  setupEventListeners();
  await loadSavedCredentials();
  updateSteamCacheStatusDisplay();
  renderAll();
  loadSteamStatus();
  loadPlatformSyncStatus();
  fetchCoversInBackground();
  setTimeout(function() { fetchSteamGenresInBackground(true); }, 5000);
  setTimeout(enrichRawgGamesInBackground,  35000); // RAWG background enrichment
  // Start auto session tracking (uses correct initAutoSessionTracking, not the old Steam-only one)
  setTimeout(initAutoSessionTracking, 5000);
  // Update deal badge once wishlist data is available
  window.nexus.wishlist.getAll().then(function(wl) {
    wishlist = wl || [];
    updateDealBadge();
  }).catch(function(){});
  // Start Steam auto-tracking if previously enabled (after a short delay)
  setTimeout(initSteamAutoTracking, 5000);
  // Check for first-launch onboarding (delay slightly so app renders first)
  setTimeout(function() { openOnboarding(true); }, 1000);
  // Check sync reminder (after credentials loaded so we know what's connected)
  setTimeout(checkSyncReminder, 3000);
}

// ── EVENT LISTENERS ──
function setupEventListeners() {
  // Helper: wire event safely — skips silently if element doesn't exist yet
  function wire(id, event, handler) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
    else console.warn('[Nexus] setupEventListeners: element not found:', id);
  }
  // Nav icons
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', () => showPage(el.dataset.page));
  });
  // Theme toggle
  var themeBtn = document.getElementById('themeToggleBtn');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  // Sidebar rows
  document.querySelectorAll('.sidebar-row[data-filter]').forEach(el => {
    el.addEventListener('click', () => {
      setFilter(el.dataset.filter);
      showPage('library');
    });
  });

  // Filter chips
  // Platform chips — multi-selectable; non-platform chips remain single-select
  var activePlatforms = new Set(); // tracks which platform chips are toggled on
  document.querySelectorAll('.filter-chip[data-p]').forEach(el => {
    el.addEventListener('click', () => {
      var p = el.dataset.p;
      if (el.classList.contains('platform-chip')) {
        // Multi-select logic for the 5 platform chips
        if (activePlatforms.has(p)) {
          activePlatforms.delete(p);
        } else {
          activePlatforms.add(p);
        }
        // Update chip states
        document.querySelectorAll('.platform-chip').forEach(c => {
          c.classList.toggle('active', activePlatforms.has(c.dataset.p));
        });
        // If no platforms selected, revert to 'all'
        if (activePlatforms.size === 0) {
          setFilter('all');
        } else {
          // Deactivate the 'All' chip and non-platform chips
          document.getElementById('chipAll').classList.remove('active');
          document.querySelectorAll('.filter-chip:not(.platform-chip)').forEach(c => c.classList.remove('active'));
          setMultiPlatformFilter([...activePlatforms]);
        }
      } else {
        // Single-select for non-platform chips — clears all platform selections
        activePlatforms.clear();
        document.querySelectorAll('.platform-chip').forEach(c => c.classList.remove('active'));
        setFilter(p);
      }
    });
  });

  // ── 3. LIBRARY SYSTEM ─────────────────────────────────────────
  // Search clear buttons
  var searchInput = document.getElementById('searchInput');
  var searchClear = document.getElementById('searchClear');
  searchInput.addEventListener('input', function() {
    searchClear.style.display = searchInput.value ? 'flex' : 'none';
    renderLibrary();
  });
  searchClear.addEventListener('click', function() {
    searchInput.value = '';
    searchClear.style.display = 'none';
    renderLibrary();
    searchInput.focus();
  });

  // Sort — was missing its listener
  wire('sortSelect', 'change', renderLibrary);

  // Genre filter dropdown
  wire('genreFilter', 'change', renderLibrary);
  wire('tagFilter',   'change', renderLibrary);

  // Status bar dismiss
  document.getElementById('statusBarDismiss').addEventListener('click', function() {
    hideStatus();
  });

  var wishSearchInput = document.getElementById('wishSearchInput');
  var wishSearchClear = document.getElementById('wishSearchClear');
  wishSearchInput.addEventListener('input', function() {
    wishSearchClear.style.display = wishSearchInput.value ? 'flex' : 'none';
    renderWishlist();
  });
  wishSearchClear.addEventListener('click', function() {
    wishSearchInput.value = '';
    wishSearchClear.style.display = 'none';
    renderWishlist();
    wishSearchInput.focus();
  });

  // View toggle
  document.getElementById('gridBtn').addEventListener('click', () => setView('grid'));
  document.getElementById('listBtn').addEventListener('click', () => setView('list'));

  // Add game modal
  wire('openAddModal', 'click', openAddModal);
  wire('closeAddModal', 'click', closeAddModal);
  wire('cancelAddModal', 'click', closeAddModal);
  document.getElementById('addOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('addOverlay')) closeAddModal();
  });
  wire('newTitle', 'input', checkDupe);
  wire('confirmAddGame', 'click', addGame);

  // Platform tiles
  document.querySelectorAll('.plat-tile').forEach(el => {
    el.addEventListener('click', () => togglePlatTile(el));
  });

  // Settings — Steam
  wire('steamConnectBtn', 'click', connectSteam);
  wire('steamResyncBtn', 'click', resyncSteam);
  // Steam sidebar cog → go to Settings
  var steamCog = document.getElementById('steam-sync-btn');
  if (steamCog) steamCog.addEventListener('click', function() { showPage('settings'); });
  // Xbox / Game Pass sidebar quick-action buttons
  var sbXboxSync = document.getElementById('sb-xbox-sync-btn');
  var sbGPSync   = document.getElementById('sb-gp-sync-btn');
  if (sbXboxSync) sbXboxSync.addEventListener('click', function(e) {
    e.stopPropagation(); // don't activate the sidebar row filter
    if (openxblApiKey) { showPage('library'); importXboxLibrary(); }
    else showPage('settings');
  });
  if (sbGPSync) sbGPSync.addEventListener('click', function(e) {
    e.stopPropagation();
    showPage('library'); importGamePassCatalog();
  });

  // Settings — Epic Heroic import
  wire('epicHeroicBtn', 'click', importEpicHeroic);

  // Settings — GOG direct import
  wire('gogImportBtn', 'click', importGOG);

  // Settings — Epic CSV import
  document.getElementById('epicCsvInput').addEventListener('change', function(e) {
    document.getElementById('epicImportBtn').disabled = !e.target.files.length;
  });
  wire('epicImportBtn', 'click', importEpicCSV);
  wire('epicTemplateBtn', 'click', downloadEpicTemplate);

  // Wishlist
  wire('openWishModal', 'click', openWishModal);
  wire('closeWishModal', 'click', closeWishModal);
  wire('cancelWishModal', 'click', closeWishModal);
  document.getElementById('wishOverlay').addEventListener('click', function(e) {
    if (e.target === document.getElementById('wishOverlay')) closeWishModal();
  });
  wire('wishGameTitle', 'input', checkWishOwned);
  wire('wishGameTitle', 'keydown', onWishTitleKeydown);
  wire('confirmWishGame', 'click', addToWishlist);
  wire('checkAllPricesBtn',   'click', checkAllPrices);
  wire('removeOwnedWishBtn',  'click', removeOwnedFromWishlist);

  // Settings — ITAD
  wire('ggdealsSaveBtn', 'click', saveGgdealsKey);
  wire('openxblSaveBtn',   'click', saveOpenXBLKey);
  wire('xboxImportBtn',    'click', importXboxLibrary);
  wire('gamepassImportBtn','click', importGamePassCatalog);
  // Search hint tooltip toggle
  var hintBtn = document.getElementById('searchHintBtn');
  var hintBox = document.getElementById('searchHintBox');
  if (hintBtn && hintBox) {
    hintBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      hintBox.style.display = hintBox.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', function() { if (hintBox) hintBox.style.display = 'none'; });

  // Global handler for .settings-link — routes through Electron's setWindowOpenHandler → shell.openExternal
  document.addEventListener('click', function(e) {
    var link = e.target.closest('.settings-link');
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    var url = link.dataset.href || (link.href && link.href !== window.location.href ? link.href : null);
    if (url) window.open(url, '_blank');
  });
  }
  wire('rawgSaveBtn',    'click', saveRawgKey);
  wire('igdbSaveBtn',    'click', saveIGDBAndFetch);
  wire('igdbRefreshBtn', 'click', function() { bulkFetchMissingArt(false); });
  wire('igdbRefetchAllBtn', 'click', function() {
    if (!confirm('Re-fetch All Art will re-download cover images for every game in your library. This can take several minutes and will use your IGDB API quota.\n\nContinue?')) return;
    bulkFetchMissingArt(true);
  });
  wire('helpMeDecideBtn', 'click', openHelpMeDecide);
  wire('replayPickerBtn',  'click', openReplayPicker);
  wire('fullResetBtn',    'click', openFullResetDialog);
  wire('resetSessionsBtn','click', openResetSessionsDialog);
  wire('openOnboardingBtn', 'click', function() { openOnboarding(false); });
  wire('resetConfirmInput', 'input', function() {
    document.getElementById('resetConfirmBtn').disabled = this.value !== 'RESET';
  });
  wire('refreshSteamCacheBtn', 'click', refreshSteamCache);
  // Show cache status when settings page opens
  document.querySelectorAll('.nav-item').forEach(function(icon) {
    if (icon.dataset.page === 'settings') {
      icon.addEventListener('click', updateSteamCacheStatusDisplay);
    }
  });

  // Game detail modal
  // Bulk toolbar
  // Bulk toolbar (only wire if elements exist)
  var bulkStatus = document.getElementById('bulkStatusSelect');
  if (bulkStatus) bulkStatus.addEventListener('change', function() {
    var val = this.value;
    if (val) { bulkSetStatus(val); this.value = ''; }
  });
  var bulkGenreSel = document.getElementById('bulkGenreSelect');
  if (bulkGenreSel) bulkGenreSel.addEventListener('change', function() {
    var genre = this.value;
    if (genre) { bulkSetGenre(genre); this.value = ''; }
  });
  var bulkTagBtn = document.getElementById('bulkTagBtn');
  if (bulkTagBtn) bulkTagBtn.addEventListener('click', function() {
    var tag = document.getElementById('bulkTagInput').value.trim();
    if (tag) { bulkAddTag(tag); document.getElementById('bulkTagInput').value = ''; }
  });
  var bulkTagInput = document.getElementById('bulkTagInput');
  if (bulkTagInput) bulkTagInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { var tag = this.value.trim(); if (tag) { bulkAddTag(tag); this.value = ''; } }
  });
  var bulkTagRemoveBtn = document.getElementById('bulkTagRemoveBtn');
  if (bulkTagRemoveBtn) bulkTagRemoveBtn.addEventListener('click', function() {
    var tag = document.getElementById('bulkTagRemoveInput').value.trim();
    if (tag) { bulkRemoveTag(tag); document.getElementById('bulkTagRemoveInput').value = ''; }
  });
  var bulkTagRemoveInput = document.getElementById('bulkTagRemoveInput');
  if (bulkTagRemoveInput) bulkTagRemoveInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { var tag = this.value.trim(); if (tag) { bulkRemoveTag(tag); this.value = ''; } }
  });
  wire('bulkDeleteBtn', 'click', bulkDelete);

  // Wishlist sort/filter
  var wishSortSel = document.getElementById('wishSortSelect');
  if (wishSortSel) wishSortSel.addEventListener('change', function() {
    wishSort = this.value; renderWishlist();
  });
  document.querySelectorAll('[data-wf]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('[data-wf]').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      wishFilterOwned = btn.dataset.wf;
      renderWishlist();
    });
  });

  wire('gameDetailClose', 'click', closeGameDetail);
  wire('gameDetailPrevBtn', 'click', function() { navigateDetail(-1); });
  wire('gameDetailNextBtn', 'click', function() { navigateDetail(1); });
  wire('sidebarHiddenRow', 'click', function() { setFilter('hidden'); showPage('library'); });
  document.getElementById('gameDetailOverlay').addEventListener('click', function(e) {
    if (e.target === document.getElementById('gameDetailOverlay')) closeGameDetail();
  });
  wire('gameDetailGenreSave', 'click', saveGameDetailGenre);
  document.getElementById('gameDetailGenreAdd').addEventListener('click', function() {
    var genre = document.getElementById('gameDetailGenre').value;
    addDetailGenre(genre);
  });
  wire('gameDetailSaveNotes', 'click', saveGameDetailNotes);
  wire('clearRatingBtn', 'click', clearRating);
  wire('sessionStartBtn', 'click', toggleSession);
  wire('gameDetailTagAdd', 'click', addGameDetailTag);
  document.getElementById('gameDetailTagInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') addGameDetailTag();
  });
  document.getElementById('gameDetailFindArt').addEventListener('click', function() {
    if (!currentDetailGame) return;
    var gameToReopen = currentDetailGame;
    coverSearchFromDetail = gameToReopen;
    closeGameDetail();
    openCoverSearch(gameToReopen.id);
  });
  wire('gameDetailClearArt', 'click', function() {
    if (!currentDetailGame) return;
    var id = currentDetailGame.id;
    delete coverCache[id];
    delete coverCache[String(id)];
    // Remove from persisted stores
    window.nexus.covers.saveCache(coverCache).catch(function(){});
    window.nexus.store.get('coverOverrides').then(function(overrides) {
      overrides = overrides || {};
      delete overrides[id];
      delete overrides[String(id)];
      window.nexus.store.set('coverOverrides', overrides);
    });
    // Refresh cover display and open search
    var coverDiv = document.getElementById('gameDetailCover');
    var pal = COVER_PALETTES[(currentDetailGame.pal||0)%COVER_PALETTES.length];
    coverDiv.innerHTML = '<div style="width:100%;height:100%;background:linear-gradient(145deg,' + pal.join(',') + ');display:flex;align-items:center;justify-content:center;font-size:11px;color:rgba(255,255,255,0.5);text-align:center;padding:8px;box-sizing:border-box">' + escHtml(currentDetailGame.title) + '</div>';
    // Re-render the card in library
    renderLibrary();
    closeGameDetail();
    openCoverSearch(id);
  });
  wire('gameDetailSteamStore', 'click', lookupSteamStore);
  wire('gameDetailHideBtn', 'click', toggleHideCurrentGame);
  document.getElementById('gameDetailOpenStore').addEventListener('click', function() {
    if (!currentDetailGame) return;
    var g = currentDetailGame;
    if (g.steamAppId) {
      window.open('steam://store/' + g.steamAppId, '_blank');
    } else if (g.platforms && g.platforms.includes('gog')) {
      var slug = g.title.toLowerCase().replace(/[:\-–—]/g,' ').replace(/[^a-z0-9 ]/g,'').trim().replace(/\s+/g,'_');
      window.open('https://www.gog.com/en/game/' + slug, '_blank');
    } else if (g.platforms && g.platforms.includes('epic')) {
      window.open('https://store.epicgames.com/en-US/browse?q=' + encodeURIComponent(g.title), '_blank');
    } else if (g.platforms && g.platforms.includes('amazon')) {
      window.open('https://gaming.amazon.com/home', '_blank');
    } else {
      window.open('https://www.google.com/search?q=' + encodeURIComponent(g.title + ' game buy'), '_blank');
    }
  });
  document.getElementById('gameDetailWishlistBtn').addEventListener('click', function() {
    if (!currentDetailGame) return;
    var alreadyWishlisted = wishlist.find(function(w) { return w.title.toLowerCase() === currentDetailGame.title.toLowerCase(); });
    if (alreadyWishlisted) {
      document.getElementById('gameDetailWishlistBtn').textContent = '✓ Already wishlisted';
      setTimeout(function() { document.getElementById('gameDetailWishlistBtn').textContent = '♡ Add to Wishlist'; }, 2000);
      return;
    }
    closeGameDetail();
    // Pre-fill wishlist modal and trigger search
    var wishInput = document.getElementById('wishGameTitle');
    wishInput.value = currentDetailGame.title;
    wishInput.dispatchEvent(new Event('input'));
    document.getElementById('wishOverlay').classList.add('open');
    setTimeout(function() { wishInput.focus(); }, 150);
  });
  document.querySelectorAll('.status-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { setGameStatus(btn.dataset.status); });
  });
  document.querySelectorAll('.intent-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { setGameIntent(currentDetailGame && currentDetailGame.id, btn.dataset.intent); });
  });

  // Cover art search modal
  wire('coverSearchClose', 'click', closeCoverSearch);
  wire('coverSearchCancel', 'click', closeCoverSearch);
  document.getElementById('coverSearchOverlay').addEventListener('click', function(e) {
    if (e.target === document.getElementById('coverSearchOverlay')) closeCoverSearch();
  });
  wire('coverSearchBtn', 'click', runCoverSearch);
  document.getElementById('coverSearchInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') runCoverSearch();
  });

  // Settings — danger zone
  wire('clearLibraryBtn', 'click', clearLibrary);

  // Settings — export
  wire('exportJsonBtn', 'click', exportJSON);
  wire('exportCsvBtn', 'click', exportCSV);
}

window.animateDiscoverRandom = function(card) {
  if (card) {
    card.classList.remove('rolling');
    void card.offsetWidth;
    card.classList.add('rolling');
  }

  setTimeout(function() {
    if (card) card.classList.remove('rolling');
    openRandomPicker();
  }, 650);
};

// ── 4. STATS SYSTEM ───────────────────────────────────────────
// ── NAVIGATION ──
function showPage(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-page]').forEach(i => i.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  const navEl = document.querySelector('.nav-item[data-page="' + page + '"]');
  if (navEl) navEl.classList.add('active');
  if (page === 'stats')     renderStats();
  if (page === 'discovery') renderDiscoveryPage();
  if (page === 'dupes') renderDupesPage();
  if (page === 'wishlist') { renderWishlist(); fetchWishlistCoversInBackground(); renderNotifHistory(); updateDealBadge(); autoRefreshWishlistPrices(); }
  if (page === 'settings') {
    renderPlatformSyncHealth();
    initAutoSessionTracking();
    // Wire settings-only buttons on first visit (they don't exist in DOM at startup)
    if (!window._settingsWired) {
      window._settingsWired = true;
      var wire2 = function(id, ev, fn) { var el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
      wire2('fillMetadataBtn', 'click', fillMissingMetadata);
    }
  }
  if (page === 'goals')   { populateGoalGameSelect(); loadGoals(); }
  if (page === 'habits')  { renderHabitsPage(); }
  if (page === 'wrapped') { renderWrappedPage(); }
  if (page === 'freegames') { renderFreeGamesPage(); }
  if (page === 'friends') { document.getElementById('friendError').textContent = ''; renderFriendHistory(); }
  // Dismiss any open hint when switching pages
  var existingHint = document.getElementById('pageHintPopup');
  if (existingHint) existingHint.remove();
  maybeShowPageHint(page);

  // Populate version number
  var verEl = document.getElementById('settingsVersion');
  if (verEl) {
    try {
      var pkg = window.require('../../package.json');
      verEl.textContent = 'v' + pkg.version;
    } catch(e) {
      verEl.textContent = '';
    }
  }
}

// ── FILTER / VIEW ──
const FILTER_TITLES = {
  all:              ['All Games',          'Your complete unified library'],
  steam:            ['Steam Library',      'Games from your Steam account'],
  gog:              ['GOG Galaxy Library', 'Games from your GOG account'],
  epic:             ['Epic Games Library', 'Games from your Epic account'],
  amazon:           ['Amazon Games Library','Games from your Amazon Games account'],
  xbox:             ['Xbox Library',       'Games from your Xbox achievement history'],
  gamepass:         ['PC Game Pass',       'Available on PC Game Pass — catalog view, not owned'],
  dupes:            ['Duplicate Games',    'Owned on multiple platforms — check before buying!'],
  noart:            ['Missing Cover Art',  'Games without a cover image — fetch via Fetch Game Info'],
  nometa:           ['Missing Metadata',   'Games without genre, tags or description — fetch via Fetch Game Info'],
  norating:         ['Not Rated',          'Games you have played but not yet given a personal rating'],
  hidden:           ['Hidden Games',       'Games excluded from library view — click 👁 to unhide'],
  recent:           ['Recently Added',     'Games added in the last 30 days'],
  'status:exploring':   ['Exploring',           'Games you are actively playing'],
  'status:finished':    ['Finished',            'Games you have finished'],
  'status:not-for-me': ['Not for Me',          'Games you have stopped playing'],
  'intent:playnext':   ['▶ Play Next',       'Games flagged to play next'],
  'intent:priority':   ['⭐ Focus List',      'Games you want to play soon — your personal focus list'],
  'intent:queue':      ['📋 Queue',           'Games added to your queue'],
};

function setMultiPlatformFilter(platforms) {
  activePlatformSet = new Set(platforms);
  currentFilter = platforms.length === 1 ? platforms[0] : 'multi-platform';
  // Update sidebar to show first selected (or clear if multiple)
  document.querySelectorAll('.sidebar-row[data-filter]').forEach(r => r.classList.remove('active'));
  if (platforms.length === 1) {
    var sideEl = document.querySelector('.sidebar-row[data-filter="' + platforms[0] + '"]');
    if (sideEl) sideEl.classList.add('active');
  }
  var names = platforms.map(function(p) { return PLAT_LABEL[p] || p; });
  document.getElementById('topTitle').textContent =
  platforms.length > 2 ? 'Selected Libraries' : names.join(' + ');

document.getElementById('topSub').textContent =
  platforms.length > 1
    ? names.join(', ')
    : (FILTER_TITLES[platforms[0]] || ['',''])[1];
    renderLibrary();
}

function setFilter(f) {
  // Clear multi-platform state whenever a non-platform filter is set
  activePlatformSet = new Set();
  document.querySelectorAll('.platform-chip').forEach(c => c.classList.remove('active'));

  // 'playtime' is a sort shortcut, not a real filter
  if (f === 'playtime') {
    document.getElementById('sortSelect').value = 'playtime';
    currentFilter = 'all';
    document.querySelectorAll('.filter-chip').forEach(function(el) {
      el.classList.toggle('active', el.dataset.p === 'all');
    });
    renderLibrary();
    return;
  }
  currentFilter = f;
  document.querySelectorAll('.sidebar-row[data-filter]').forEach(r => r.classList.remove('active'));
  const sideEl = document.querySelector('.sidebar-row[data-filter="' + f + '"]');
  if (sideEl) sideEl.classList.add('active');
  document.querySelectorAll('.filter-chip[data-p]').forEach(c => c.classList.remove('active'));
  const chipEl = document.querySelector('.filter-chip[data-p="' + f + '"]');
  if (chipEl) chipEl.classList.add('active');
  const titles = FILTER_TITLES[f] || ['All Games', ''];
  document.getElementById('topTitle').textContent = titles[0];
  document.getElementById('topSub').textContent = titles[1];
  renderLibrary();
}

function setView(v) {
  currentView = v;
  document.getElementById('gridBtn').classList.toggle('active', v === 'grid');
  document.getElementById('listBtn').classList.toggle('active', v === 'list');
  renderLibrary();
}



function toggleBulkSelect(gameId, el) {
  if (selectedGames.has(gameId)) {
    selectedGames.delete(gameId);
    el.classList.remove('bulk-selected');
  } else {
    selectedGames.add(gameId);
    el.classList.add('bulk-selected');
  }
  updateBulkToolbar();
}

function updateBulkToolbar() {
  var toolbar = document.getElementById('bulkToolbar');
  if (!toolbar) return;
  var count = selectedGames.size;
  if (count === 0) {
    toolbar.style.display = 'none';
    bulkMode = false;
  } else {
    toolbar.style.display = 'flex';
    bulkMode = true;
    document.getElementById('bulkCount').textContent = count + ' selected';
  }
}

function clearBulkSelection() {
  selectedGames.clear();
  bulkMode = false;
  document.querySelectorAll('.bulk-selected').forEach(function(el) { el.classList.remove('bulk-selected'); });
  updateBulkToolbar();
}

async function bulkSetStatus(status) {
  var ids = [...selectedGames];
  for (var id of ids) {
    await window.nexus.games.update(id, { status });
    var g = games.find(function(g) { return g.id === id; });
    if (g) g.status = status;
  }
  clearBulkSelection();
  renderLibrary();
}

async function bulkAddTag(tag) {
  if (!tag) return;
  tag = tag.toLowerCase().trim();
  var ids = [...selectedGames];
  for (var id of ids) {
    var g = games.find(function(g) { return g.id === id; });
    if (!g) continue;
    var tags = g.tags ? [...g.tags] : [];
    if (!tags.includes(tag)) tags.push(tag);
    await window.nexus.games.update(id, { tags });
    g.tags = tags;
  }
  clearBulkSelection();
  updateTagDropdown();
  renderLibrary();
}

async function bulkRemoveTag(tag) {
  if (!tag) return;
  tag = tag.toLowerCase().trim();
  var ids = [...selectedGames];
  for (var id of ids) {
    var g = games.find(function(g) { return g.id === id; });
    if (!g) continue;
    var tags = g.tags ? g.tags.filter(function(t) { return t !== tag; }) : [];
    await window.nexus.games.update(id, { tags });
    g.tags = tags;
  }
  clearBulkSelection();
  updateTagDropdown();
  renderLibrary();
}

async function bulkSetGenre(genre) {
  if (!genre) return;
  var ids = [...selectedGames];
  for (var id of ids) {
    var g = games.find(function(g) { return g.id === id; });
    if (!g) continue;
    var genres = g.genres ? [...g.genres] : [];
    if (!genres.includes(genre)) genres.unshift(genre);
    else { genres.splice(genres.indexOf(genre),1); genres.unshift(genre); }
    await window.nexus.games.update(id, { genre, genres });
    g.genre = genre; g.genres = genres;
  }
  clearBulkSelection();
  updateGenreDropdown(); updateTagDropdown(); renderLibrary();
}

async function bulkDelete() {
  var ids = [...selectedGames];
  if (!confirm('Delete ' + ids.length + ' selected game(s)? This cannot be undone.')) return;
  for (var id of ids) {
    await window.nexus.games.delete(id);
  }
  games = games.filter(function(g) { return !ids.includes(g.id); });
  clearBulkSelection();
  renderAll();
}


async function fetchIGDBGenresForOtherGames() {
  if (!igdbClientId || !igdbClientSecret) {
    alert('IGDB credentials required. Add them in Settings → Cover Art.');
    return;
  }
  var otherGames = games.filter(function(g) { return (!g.genre || g.genre === 'Other') && !g.platforms.includes('steam'); });
  // Also include steam games still at Other that have no steamAppId
  var steamOther = games.filter(function(g) { return g.platforms.includes('steam') && g.genre === 'Other' && (!g.steamAppId); });
  var targets = [...otherGames, ...steamOther];
  if (!targets.length) { showStatus('✓ No games with "Other" genre remaining', 100); setTimeout(hideStatus, 2000); return; }
  showStatus('Fetching IGDB genres for ' + targets.length + ' games…', 0);
  var updated = 0;
  for (var i = 0; i < targets.length; i++) {
    var game = targets[i];
    showStatus('IGDB genre fetch: ' + (i+1) + '/' + targets.length + ' — ' + game.title, Math.round((i/targets.length)*100));
    try {
      // Use IGDB covers endpoint which also returns genre data
      var url = await window.nexus.covers.fetchOne({ id: game.id, title: game.title, steamAppId: game.steamAppId || null }, igdbClientId, igdbClientSecret);
      // fetchOne only returns cover URL; we need genre separately
      // Use the igdb search endpoint via a workaround: check if IGDB returned a result
      if (url) { updated++; }
    } catch(e) { /* skip */ }
    await new Promise(function(r) { setTimeout(r, 250); });
  }
  showStatus('✓ IGDB pass complete', 100);
  setTimeout(hideStatus, 2500);
  renderAll();
}


// ── KEYBOARD NAVIGATION ──
var kbFocusIdx = -1;

function kbFocusCard(idx) {
  var cards = document.querySelectorAll('#libraryGrid .game-card, #libraryList .list-row');
  if (!cards.length) return;
  idx = Math.max(0, Math.min(idx, cards.length - 1));
  kbFocusIdx = idx;
  cards.forEach(function(c, i) { c.classList.toggle('kb-focused', i === idx); });
  cards[idx].scrollIntoView({ block: 'nearest' });
}


// ── FRIEND COMPARISON ──
var friendGames = [];
var friendName  = '';
var friendCurrentId = '';

async function loadFriendLibrary() {
  var friendId = document.getElementById('friendSteamId').value.trim();
  if (!friendId) return;
  var btn = document.getElementById('friendLoadBtn');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    var result = await window.nexus.steam.importFriend(friendId);
    friendGames = result.games;
    friendName  = result.personaName || ('Friend ' + friendId.slice(-4));
    friendCurrentId = friendId;
    renderFriendComparison();
    document.getElementById('friendResults').style.display = 'block';
    // Save to recent history
    await saveFriendToHistory(friendId, friendName);
    renderFriendHistory();
  } catch(e) {
    document.getElementById('friendError').textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Compare';
  }
}

async function saveFriendToHistory(id, name) {
  var history = await window.nexus.store.get('friendHistory') || [];
  // Remove if already exists, then prepend
  history = history.filter(function(f) { return f.id !== id; });
  history.unshift({ id: id, name: name, lastViewed: new Date().toISOString() });
  history = history.slice(0, 10); // keep last 10
  await window.nexus.store.set('friendHistory', history);
}

window.removeFriendHistory = async function(id) {
  var history = await window.nexus.store.get('friendHistory') || [];
  history = history.filter(function(f) { return f.id !== id; });
  await window.nexus.store.set('friendHistory', history);
  renderFriendHistory();
};

async function renderFriendHistory() {
  var el = document.getElementById('friendRecentList');
  if (!el) return;
  var history = await window.nexus.store.get('friendHistory') || [];
  if (!history.length) { el.innerHTML = ''; return; }
  el.innerHTML =
    '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Recent</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
    history.map(function(f) {
  return '<span style="display:inline-flex;align-items:center;gap:4px;background:var(--surface2);border:1px solid var(--border);border-radius:20px;padding:4px 12px;font-size:11px;">' +
    '<button onclick="loadFriendById(\'' + escHtml(f.id) + '\')" ' +
    'style="background:none;border:none;padding:0;font-size:11px;color:var(--text2);cursor:pointer;" ' +
    'onmouseenter="this.style.color=\'var(--accent)\'" ' +
    'onmouseleave="this.style.color=\'var(--text2)\'">' +
    escHtml(f.name) +
    '</button>' +
    '<button onclick="removeFriendHistory(\'' + escHtml(f.id) + '\')" ' +
    'style="background:none;border:none;padding:0;font-size:10px;color:var(--text3);cursor:pointer;line-height:1;" ' +
    'onmouseenter="this.style.color=\'var(--text)\'" ' +
    'onmouseleave="this.style.color=\'var(--text3)\'">×</button>' +
    '</span>';
}).join('') +
    '</div>';
}

window.loadFriendById = function(id) {
  document.getElementById('friendSteamId').value = id;
  loadFriendLibrary();
};

function renderFriendComparison() {
  var myTitles     = new Set(games.map(function(g) { return normalizeTitle(g.title); }));
  var friendTitles = new Set(friendGames.map(function(g) { return normalizeTitle(g.name || ''); }));

  var inCommon = friendGames
    .filter(function(g) { return myTitles.has(normalizeTitle(g.name || '')); })
    .sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });

  var theyHave = friendGames
    .filter(function(g) { return !myTitles.has(normalizeTitle(g.name || '')); })
    .sort(function(a, b) { return (b.playtime_forever || 0) - (a.playtime_forever || 0); });

  var iHave = games
    .filter(function(g) { return !friendTitles.has(normalizeTitle(g.title)); })
    .sort(function(a, b) { return a.title.localeCompare(b.title); });

  var el = document.getElementById('friendResults');
  var activeTab = 'theyHave';
  var shownCount = 150;

  function renderTabContent() {
    var contentEl = document.getElementById('friendTabContent');
    contentEl.innerHTML = '';

    // Update active stat card styles
    ['theyHave', 'inCommon', 'iHave'].forEach(function(tab) {
      var card = document.getElementById('friendStatCard-' + tab);
      if (!card) return;
      card.style.borderColor = tab === activeTab ? 'var(--accent)' : 'var(--border)';
      card.style.background  = tab === activeTab ? 'var(--surface2)' : 'var(--surface)';
    });

    if (activeTab === 'theyHave') {
      renderTheyHave(contentEl);
    } else if (activeTab === 'inCommon') {
      renderInCommon(contentEl);
    } else {
      renderIHave(contentEl);
    }

    // Footer
    var footerEl = document.createElement('div');
    footerEl.innerHTML = BRAND_FOOTER_HTML;
    contentEl.appendChild(footerEl.firstChild);
  }

  function renderTheyHave(contentEl) {
    var header = document.createElement('div');
    header.className = 'friend-section-header';
    header.innerHTML =
      '<div class="friend-section-title">🎮 ' + escHtml(friendName) + ' has — you don\'t</div>' +
      '<div class="friend-section-sub">Sorted by their playtime · ' + theyHave.length + ' games</div>';
    contentEl.appendChild(header);

    if (!theyHave.length) {
      contentEl.innerHTML += '<div class="friend-empty">You already own everything ' + escHtml(friendName) + ' has!</div>';
      return;
    }

    var grid = document.createElement('div');
    grid.className = 'friend-game-grid';
    contentEl.appendChild(grid);

    var loadMoreWrap = document.createElement('div');
    loadMoreWrap.style.cssText = 'text-align:center;margin:12px 0;display:none';
    loadMoreWrap.innerHTML =
      '<button class="settings-btn" style="padding:8px 24px" id="friendLoadMoreBtn">Load More Games</button>' +
      '<div style="font-size:11px;color:var(--text3);margin-top:6px" id="friendLoadMoreLabel"></div>';
    contentEl.appendChild(loadMoreWrap);

    function fillGrid(count) {
      grid.innerHTML = '';
      theyHave.slice(0, count).forEach(function(fg) {
        var title    = fg.name || '';
        var hrs      = fg.playtime_forever ? Math.max(0, Math.round(fg.playtime_forever / 60)) : 0;
        var inWish   = wishlist.find(function(w) { return normalizeTitle(w.title) === normalizeTitle(title); });
        var coverUrl = fg.appid ? 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + fg.appid + '/library_600x900.jpg' : null;
        var pal      = COVER_PALETTES[Math.abs(title.charCodeAt(0) || 0) % COVER_PALETTES.length];

        var row = document.createElement('div');
        row.className = 'friend-game-card';
        row.innerHTML =
          '<div class="friend-game-cover"' + (fg.appid ? ' onclick="window.open(\'https://store.steampowered.com/app/' + fg.appid + '\',\'_blank\')" style="cursor:pointer" title="Open in Steam"' : '') + '>' +
            (coverUrl ? '<img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display=\'none\'">' : '') +
            '<div class="friend-game-cover-bg" style="background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')"></div>' +
            (fg.appid ? '<div style="position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,0.7);border-radius:4px;padding:2px 5px;font-size:9px;color:#7fc8f8;opacity:0;transition:opacity 0.15s" class="steam-hover-hint">Steam ↗</div>' : '') +
          '</div>' +
          '<div class="friend-game-body">' +
            '<div class="friend-game-title">' + escHtml(title) + '</div>' +
            (hrs > 0 ? '<div class="friend-game-hrs">' + hrs + 'h played by ' + escHtml(friendName) + '</div>' : '<div class="friend-game-hrs">No playtime data</div>') +
            '<div class="friend-game-actions">' +
              '<button class="friend-wish-btn' + (inWish ? ' wishlisted' : '') + '">' + (inWish ? '♥ Wishlisted' : '♡ Add to Wishlist') + '</button>' +
            '</div>' +
          '</div>';

        var wishBtn = row.querySelector('.friend-wish-btn');
        if (wishBtn && !inWish) {
          (function(t, btn) {
            btn.addEventListener('click', function(e) {
              e.stopPropagation();
              var input = document.getElementById('wishGameTitle');
              input.value = t;
              input.dispatchEvent(new Event('input'));
              document.getElementById('wishOverlay').classList.add('open');
              btn.textContent = '♥ Wishlisted';
              btn.classList.add('wishlisted');
              btn.disabled = true;
            });
          })(title, wishBtn);
        }

        grid.appendChild(row);
      });

      if (theyHave.length > count) {
        loadMoreWrap.style.display = 'block';
        document.getElementById('friendLoadMoreLabel').textContent =
          'Showing ' + count + ' of ' + theyHave.length + ' · ' + (theyHave.length - count) + ' not yet shown';
        document.getElementById('friendLoadMoreBtn').onclick = function() {
          shownCount += 50;
          fillGrid(shownCount);
        };
      } else {
        loadMoreWrap.style.display = 'none';
      }
    }

    fillGrid(shownCount);
  }

  function renderCompactList(contentEl, items, titleFn, metaFn, coverFn, palFn, emptyMsg) {
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'friend-empty';
      empty.textContent = emptyMsg;
      contentEl.appendChild(empty);
      return;
    }
    items.forEach(function(item) {
      var coverUrl = coverFn(item);
      var pal      = palFn(item);
      var row      = document.createElement('div');
      row.className = 'friend-compact-row';
      row.innerHTML =
        '<div class="friend-compact-cover">' +
          (coverUrl ? '<img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover;border-radius:3px" onerror="this.style.display=\'none\'">' : '') +
          '<div class="friend-compact-cover-bg" style="background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ');border-radius:3px;position:absolute;inset:0"></div>' +
        '</div>' +
        '<div class="friend-compact-title">' + escHtml(titleFn(item)) + '</div>' +
        '<div class="friend-compact-meta">' + escHtml(metaFn(item)) + '</div>';
      contentEl.appendChild(row);
    });
  }

  function renderInCommon(contentEl) {
    var header = document.createElement('div');
    header.className = 'friend-section-header';
    header.innerHTML =
      '<div class="friend-section-title">🤝 Games you both own</div>' +
      '<div class="friend-section-sub">Sorted A–Z · ' + inCommon.length + ' games</div>';
    contentEl.appendChild(header);

    renderCompactList(
      contentEl, inCommon,
      function(fg) { return fg.name || ''; },
      function(fg) {
        var myGame  = games.find(function(g) { return normalizeTitle(g.title) === normalizeTitle(fg.name || ''); });
        var myHrs   = myGame ? Math.round(myGame.playtimeHours || 0) : 0;
        var theirHrs = fg.playtime_forever ? Math.max(0, Math.round(fg.playtime_forever / 60)) : 0;
        return 'You ' + myHrs + 'h · ' + friendName + ' ' + theirHrs + 'h';
      },
      function(fg) {
        var myGame = games.find(function(g) { return normalizeTitle(g.title) === normalizeTitle(fg.name || ''); });
        return fg.appid
          ? 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + fg.appid + '/library_600x900.jpg'
          : (myGame && (coverCache[myGame.id] || coverCache[String(myGame.id)])) || null;
      },
      function(fg) {
        var t = fg.name || '';
        return COVER_PALETTES[Math.abs(t.charCodeAt(0) || 0) % COVER_PALETTES.length];
      },
      'No games in common.'
    );
  }

  function renderIHave(contentEl) {
    var header = document.createElement('div');
    header.className = 'friend-section-header';
    header.innerHTML =
      '<div class="friend-section-title">📦 You have — they don\'t</div>' +
      '<div class="friend-section-sub">Sorted A–Z · ' + iHave.length + ' games</div>';
    contentEl.appendChild(header);

    renderCompactList(
      contentEl, iHave,
      function(g) { return g.title; },
      function(g) { return Math.round(g.playtimeHours || 0) + 'h played'; },
      function(g) { return coverCache[g.id] || coverCache[String(g.id)] || null; },
      function(g) { return COVER_PALETTES[(g.pal || 0) % COVER_PALETTES.length]; },
      escHtml(friendName) + ' already owns everything you have!'
    );
  }

  // ── Build shell ──
  el.innerHTML =
    '<div class="friend-summary" style="cursor:pointer">' +
      '<div class="friend-stat-card" id="friendStatCard-theyHave" style="border:2px solid var(--accent);background:var(--surface2);transition:border-color 0.15s,background 0.15s">' +
        '<div class="friend-stat-num" style="color:var(--color-pink)">' + theyHave.length + '</div>' +
        '<div class="friend-stat-label">' + escHtml(friendName) + ' has, you don\'t</div>' +
      '</div>' +
      '<div class="friend-stat-card" id="friendStatCard-inCommon" style="border:2px solid var(--border);background:var(--surface);transition:border-color 0.15s,background 0.15s">' +
        '<div class="friend-stat-num" style="color:var(--steam)">' + inCommon.length + '</div>' +
        '<div class="friend-stat-label">In Common</div>' +
      '</div>' +
      '<div class="friend-stat-card" id="friendStatCard-iHave" style="border:2px solid var(--border);background:var(--surface);transition:border-color 0.15s,background 0.15s">' +
        '<div class="friend-stat-num" style="color:var(--color-success)">' + iHave.length + '</div>' +
        '<div class="friend-stat-label">You have, they don\'t</div>' +
      '</div>' +
    '</div>' +
    '<div id="friendTabContent" style="margin-top:4px"></div>';

  // Wire stat card clicks
  ['theyHave', 'inCommon', 'iHave'].forEach(function(tab) {
    document.getElementById('friendStatCard-' + tab).addEventListener('click', function() {
      activeTab = tab;
      shownCount = 150;
      renderTabContent();
    });
  });

  renderTabContent();
}

// ── PLAYTIME GOALS ──
var goals = [];

async function loadGoals() {
  var saved = await window.nexus.store.get('playtimeGoals');
  goals = saved || [];
  renderGoals();
}

async function saveGoals() {
  await window.nexus.store.set('playtimeGoals', goals);
}

async function addGoal() {
  var gameId   = parseInt(document.getElementById('goalGameSelect').value);
  var targetHr = parseInt(document.getElementById('goalTargetHours').value);
  var label    = document.getElementById('goalLabel').value.trim();
  if (!gameId || !targetHr || targetHr < 1) return;
  var game = games.find(function(g) { return g.id === gameId; });
  if (!game) return;
  goals.push({ id: Date.now(), gameId, targetHours: targetHr, label: label || 'Reach ' + targetHr + 'h in ' + game.title, createdAt: new Date().toISOString() });
  await saveGoals();
  renderGoals();
}

async function deleteGoal(goalId) {
  goals = goals.filter(function(g) { return g.id !== goalId; });
  await saveGoals();
  renderGoals();
}

function renderGoals() {
  var el = document.getElementById('goalsArea');
  if (!el) return;

  // Sort: in-progress first by % desc, then done, then no game found
  var sorted = goals.slice().sort(function(a, b) {
    var ga = games.find(function(g) { return g.id === a.gameId; });
    var gb = games.find(function(g) { return g.id === b.gameId; });
    var pa = ga ? Math.min(100, Math.round(((ga.playtimeHours||0) / a.targetHours) * 100)) : 0;
    var pb = gb ? Math.min(100, Math.round(((gb.playtimeHours||0) / b.targetHours) * 100)) : 0;
    var doneA = ga && (ga.playtimeHours||0) >= a.targetHours;
    var doneB = gb && (gb.playtimeHours||0) >= b.targetHours;
    if (doneA && !doneB) return 1;
    if (!doneA && doneB) return -1;
    return pb - pa;
  });

  var completed = sorted.filter(function(g) {
    var game = games.find(function(gm) { return gm.id === g.gameId; });
    return game && (game.playtimeHours||0) >= g.targetHours;
  });
  var active = sorted.filter(function(g) {
    var game = games.find(function(gm) { return gm.id === g.gameId; });
    return !game || (game.playtimeHours||0) < g.targetHours;
  });

  // Summary stats
  var totalTargetHrs  = goals.reduce(function(s,g){return s+g.targetHours;},0);
  var totalCurrentHrs = goals.reduce(function(s,g){
    var game=games.find(function(gm){return gm.id===g.gameId;});
    return s+(game ? Math.min(g.targetHours, game.playtimeHours||0) : 0);
  },0);
  var overallPct = totalTargetHrs > 0 ? Math.round((totalCurrentHrs/totalTargetHrs)*100) : 0;
  var nearlyDone = active.filter(function(g) {
    var game=games.find(function(gm){return gm.id===g.gameId;});
    if(!game) return false;
    var pct=Math.round(((game.playtimeHours||0)/g.targetHours)*100);
    return pct>=75 && pct<100;
  });

  function goalCard(goal) {
    var game = games.find(function(g) { return g.id === goal.gameId; });
    if (!game) return '';
    var current = game.playtimeHours || 0;
    var pct = Math.min(100, Math.round((current / goal.targetHours) * 100));
    var done = current >= goal.targetHours;
    var remaining = Math.max(0, goal.targetHours - current);
    var coverUrl = coverCache[game.id] || coverCache[String(game.id)];
    var eta = remaining > 0 ? remaining + 'h remaining' : '';
    var daysEst = remaining > 0 && current > 0 ? Math.ceil(remaining) : null; // rough: needs session data
    var barColor = done ? '#4ade80' : pct >= 75 ? '#facc15' : 'var(--steam)';
    var genres = (game.genres && game.genres.length ? game.genres[0] : game.genre) || '';
    var mc = game.metacriticScore ? '<span style="font-size:9px;color:' + (game.metacriticScore>=80?'#4ade80':game.metacriticScore>=60?'#facc15':'#f87171') + ';font-weight:800;background:rgba(0,0,0,0.3);padding:1px 5px;border-radius:3px;margin-left:4px">' + game.metacriticScore + '</span>' : '';
    return '<div class="goal-card' + (done ? ' goal-done' : '') + '">' +
      (coverUrl
        ? '<img src="' + coverUrl + '" class="goal-cover">'
        : '<div class="goal-cover goal-cover-placeholder" style="background:linear-gradient(145deg,' + COVER_PALETTES[(game.pal||0)%COVER_PALETTES.length].join(',') + ')"></div>') +
      '<div class="goal-info">' +
        '<div class="goal-title">' + escHtml(goal.label) + '</div>' +
        '<div class="goal-game">' + escHtml(game.title) +
          (genres ? ' · <span style="color:var(--text3)">' + escHtml(genres) + '</span>' : '') + mc +
        '</div>' +
        '<div class="goal-bar-wrap">' +
          '<div class="goal-bar-track"><div class="goal-bar-fill" style="width:' + pct + '%;background:' + barColor + '"></div></div>' +
          '<div class="goal-pct">' + pct + '%</div>' +
        '</div>' +
        '<div class="goal-meta">' +
          '<span>' + current + 'h / ' + goal.targetHours + 'h</span>' +
          (done
            ? '<span style="color:#4ade80;font-weight:700">✓ Complete!</span>'
            : (eta ? '<span>' + eta + '</span>' : '')) +
          (game.status ? '<span class="status-chip status-' + game.status + '" style="font-size:9px;padding:1px 6px">' + game.status + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<button class="goal-delete" onclick="deleteGoal(' + goal.id + ')" title="Remove goal">×</button>' +
    '</div>';
  }

  // Build suggested goals from high-playtime games without goals
  var existingGameIds = new Set(goals.map(function(g){return g.gameId;}));
  var suggestions = games
    .filter(function(g){ return (g.playtimeHours||0)>0 && !existingGameIds.has(g.id); })
    .sort(function(a,b){ return (b.playtimeHours||0)-(a.playtimeHours||0); })
    .slice(0,5)
    .map(function(g){
      var current=g.playtimeHours||0;
      var nextMilestone=current<10?10:current<25?25:current<50?50:current<100?100:current<200?200:current<500?500:1000;
      return {game:g,milestone:nextMilestone};
    });

  var summaryHtml = goals.length ? (
    '<div class="goal-summary-grid">' +
      '<div class="goal-summary-card">' +
        '<div class="goal-summary-num" style="color:var(--steam)">' + goals.length + '</div>' +
        '<div class="goal-summary-label">Goals Set</div>' +
      '</div>' +
      '<div class="goal-summary-card">' +
        '<div class="goal-summary-num" style="color:#4ade80">' + completed.length + '</div>' +
        '<div class="goal-summary-label">Completed</div>' +
      '</div>' +
      '<div class="goal-summary-card">' +
        '<div class="goal-summary-num" style="color:#facc15">' + overallPct + '%</div>' +
        '<div class="goal-summary-label">Overall Progress</div>' +
      '</div>' +
      '<div class="goal-summary-card">' +
        '<div class="goal-summary-num" style="color:#fb923c">' + nearlyDone.length + '</div>' +
        '<div class="goal-summary-label">Almost Done</div>' +
      '</div>' +
    '</div>'
  ) : '';

  // Empty state with suggestions
  if (!goals.length) {
    var suggHtml = suggestions.length
      ? '<div style="margin-top:20px"><div class="stat-bar-title" style="margin-bottom:10px">💡 Suggested Goals</div>' +
          suggestions.map(function(s) {
            var cUrl = coverCache[s.game.id] || coverCache[String(s.game.id)];
            var pal  = COVER_PALETTES[(s.game.pal||0)%COVER_PALETTES.length];
            return '<div class="goal-suggestion" onclick="document.getElementById(\'goalGameSelect\').value=' + s.game.id + ';document.getElementById(\'goalTargetHours\').value=' + s.milestone + '">' +
              (cUrl ? '<img src="' + cUrl + '" style="width:28px;height:37px;border-radius:4px;object-fit:cover;flex-shrink:0">' : '<div style="width:28px;height:37px;border-radius:4px;flex-shrink:0;background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')"></div>') +
              '<div style="flex:1;min-width:0">' +
                '<div style="font-size:12px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(s.game.title) + '</div>' +
                '<div style="font-size:10px;color:var(--text3);margin-top:1px">Reach ' + s.milestone + 'h · currently ' + fmtHrs(s.game.playtimeHours) + 'h</div>' +
              '</div>' +
              '<div style="font-size:10px;font-weight:700;color:var(--steam);flex-shrink:0">Click to set →</div>' +
            '</div>';
          }).join('') +
        '</div>'
      : '';
    el.innerHTML =
      '<div class="empty-state" style="padding:40px 0"><div class="empty-icon">🎯</div><h3>No milestones set</h3><p>Pick a game and set a target — track your progress as you play.</p></div>' +
      suggHtml;
    return;
  }

  var html = summaryHtml;

  if (nearlyDone.length) {
    html += '<div class="stat-bar-title" style="color:#facc15;margin-bottom:10px">⚡ Almost There (' + nearlyDone.length + ')</div>';
    html += nearlyDone.map(goalCard).join('');
  }

  var notNearlyDone = active.filter(function(g) {
    var game=games.find(function(gm){return gm.id===g.gameId;});
    if(!game) return true;
    var pct=Math.round(((game.playtimeHours||0)/g.targetHours)*100);
    return pct<75;
  });

  if (notNearlyDone.length) {
    html += '<div class="stat-bar-title" style="margin-bottom:10px;margin-top:' + (nearlyDone.length?'20px':'0') + '">In Progress (' + notNearlyDone.length + ')</div>';
    html += notNearlyDone.map(goalCard).join('');
  }

  if (completed.length) {
    html += '<div class="stat-bar-title" style="margin:20px 0 10px">Completed 🏆 (' + completed.length + ')</div>';
    html += completed.map(goalCard).join('');
  }

  if (suggestions.length) {
    html += '<div class="stat-bar-title" style="margin:24px 0 10px">💡 Suggested Next Goals</div>';
    html += suggestions.map(function(s) {
      var cUrl = coverCache[s.game.id] || coverCache[String(s.game.id)];
      var pal  = COVER_PALETTES[(s.game.pal||0)%COVER_PALETTES.length];
      return '<div class="goal-suggestion" onclick="document.getElementById(\'goalGameSelect\').value=' + s.game.id + ';document.getElementById(\'goalTargetHours\').value=' + s.milestone + '">' +
        (cUrl ? '<img src="' + cUrl + '" style="width:28px;height:37px;border-radius:4px;object-fit:cover;flex-shrink:0">' : '<div style="width:28px;height:37px;border-radius:4px;flex-shrink:0;background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')"></div>') +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:12px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(s.game.title) + '</div>' +
          '<div style="font-size:10px;color:var(--text3);margin-top:1px">Next milestone: ' + s.milestone + 'h · currently ' + fmtHrs(s.game.playtimeHours) + 'h</div>' +
        '</div>' +
        '<div style="font-size:10px;font-weight:700;color:var(--steam);flex-shrink:0">Click to set →</div>' +
      '</div>';
    }).join('');
  }

  el.innerHTML = html;
  renderHallOfFame();
  var footerEl = document.createElement('div');
  footerEl.innerHTML = BRAND_FOOTER_HTML;
  el.appendChild(footerEl.firstChild);
}

function populateGoalGameSelect() {
  var sel = document.getElementById('goalGameSelect');
  if (!sel) return;
  var sorted = games.slice().sort(function(a,b) { return a.title.localeCompare(b.title); });
  sel.innerHTML = '<option value="">Select a game…</option>' +
    sorted.map(function(g) {
      var hrs = g.playtimeHours ? ' (' + fmtHrs(g.playtimeHours) + 'h)' : '';
      return '<option value="' + g.id + '">' + escHtml(g.title) + escHtml(hrs) + '</option>';
    }).join('');
}


// ── PRICE ALERT HISTORY ──
async function renderNotifHistory() {
  var el = document.getElementById('notifHistoryArea');
  if (!el) return;
  var history = await window.nexus.notif.getHistory();
  if (!history.length) {
    el.innerHTML = wishlist.length
      ? '<div style="font-size:12px;color:var(--text3);padding:12px 0">No price alerts set. Set a target price on any wishlist game to get notified when it drops.</div>'
      : '';
    return;
  }
  var rows = history.map(function(n) {
    var d    = new Date(n.ts);
    var when = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var row  = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);gap:12px';
    row.innerHTML =
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(n.title) + '</div>' +
        '<div style="font-size:10px;color:var(--text3)">' + when + '</div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' +
        '<div style="font-size:13px;font-weight:800;color:#4ade80">$' + Number(n.price).toFixed(2) + '</div>' +
        '<div style="font-size:10px;color:var(--text3)">target $' + Number(n.target).toFixed(2) + '</div>' +
      '</div>';
    if (n.url) {
      var link = document.createElement('a');
      link.href      = n.url;
      link.target    = '_blank';
      link.textContent = 'View ↗';
      link.style.cssText = 'font-size:10px;color:var(--steam);text-decoration:none;flex-shrink:0';
      row.appendChild(link);
    }
    return row.outerHTML;
  }).join('');

  el.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
      '<div class="stat-bar-title">Recent Price Alerts</div>' +
      '<button class="filter-chip" onclick="clearNotifHistory()" style="font-size:10px">Clear All</button>' +
    '</div>' + rows;
}

async function clearNotifHistory() {
  await window.nexus.notif.clearHistory();
  renderNotifHistory();
}

// ── GAME DISCOVERY ──

// ── DATA HELPERS ──
// ── SEARCH QUERY PARSER ──
// Supports:
//   multi-word AND:  adventure indie       → must match BOTH
//   OR operator:     rpg | strategy        → match either
//   field prefixes:  genre:rpg  tag:indie  dev:valve  pub:ea  status:backlog  mc:80  plat:steam  title:witcher
//   negation:        -horror               → exclude games with "horror" anywhere
//   quoted phrases:  "dark souls"          → exact phrase match
function parseSearchQuery(raw) {
  if (!raw || !raw.trim()) return null;
  // Split by | first for OR groups
  var orGroups = raw.split(/\s*\|\s*/).map(function(group) {
    // Each group: split by spaces respecting quotes
    var tokens = [];
    var re = /("(?:[^"]+)"|-?[\w:]+|-?\S+)/g;
    var m;
    while ((m = re.exec(group)) !== null) tokens.push(m[1]);
    return tokens.map(function(token) {
      var negate = token.startsWith('-') && token.length > 1;
      if (negate) token = token.slice(1);
      var colonIdx = token.indexOf(':');
      var field = null, value = token;
      if (colonIdx > 0 && !token.startsWith('"')) {
        field = token.slice(0, colonIdx).toLowerCase();
        value = token.slice(colonIdx + 1);
      }
      value = value.replace(/^"|"$/g, '').toLowerCase();
      return { field: field, value: value, negate: negate };
    }).filter(function(t) { return t.value.length > 0; });
  });
  return orGroups;
}

function gameMatchesToken(g, token) {
  var v = token.value;
  var f = token.field;
  var genres = (g.genres && g.genres.length ? g.genres : (g.genre ? [g.genre] : [])).map(function(x) { return (x||'').toLowerCase(); });
  var tags    = (g.tags || []).map(function(x) { return (x||'').toLowerCase(); });
  var match = false;
  if (!f || f === 'title')   match = match || !!(g.title       && g.title.toLowerCase().includes(v));
  if (!f || f === 'genre')   match = match || genres.some(function(gn) { return gn.includes(v); });
  if (!f || f === 'tag')     match = match || tags.some(function(t)  { return t.includes(v);  });
  if (!f || f === 'status')  match = match || !!(g.status      && g.status.toLowerCase().includes(v));
  if (f === 'intent')        match = match || !!(g.intent       && g.intent.toLowerCase().includes(v));
  if (!f || f === 'dev')     match = match || !!(g.developer   && g.developer.toLowerCase().includes(v));
  if (!f || f === 'pub')     match = match || !!(g.publisher   && g.publisher.toLowerCase().includes(v));
  if (!f || f === 'plat')    match = match || (g.platforms||[]).some(function(p){ return p.toLowerCase().includes(v); });
  if (!f)                    match = match || !!(g.description && g.description.toLowerCase().includes(v));
  if (f === 'mc') {
    var threshold = parseInt(v);
    if (!isNaN(threshold)) match = !!(g.metacriticScore && g.metacriticScore >= threshold);
    else match = false;
  }
  if (f === 'rating') {
    var threshold = parseInt(v);
    if (!isNaN(threshold)) match = !!(g.userRating && g.userRating >= threshold);
    else match = false;
  }
  return token.negate ? !match : match;
}

function gameMatchesQuery(g, orGroups) {
  // OR groups: game must match ALL tokens in at least ONE group
  return orGroups.some(function(andTokens) {
    return andTokens.every(function(token) { return gameMatchesToken(g, token); });
  });
}

function getFiltered() {
  const rawQ = document.getElementById('searchInput').value;
  const sort = document.getElementById('sortSelect').value;
  const genreFilter = document.getElementById('genreFilter').value;
  let list = games.slice();
  const parsedQ = parseSearchQuery(rawQ);
  if (parsedQ) list = list.filter(function(g) {
    try { return gameMatchesQuery(g, parsedQ); }
    catch(e) { return false; }
  });
  // Hidden filter shows ONLY hidden games; otherwise hidden games are excluded
  if (currentFilter === 'hidden') {
    list = list.filter(g => g.hidden);
  } else {
    if (!showHidden && !parsedQ) list = list.filter(function(g) { return !g.hidden; });
    // gpCatalog entries only shown when explicitly filtering by gamepass or searching
    if (currentFilter === 'gamepass') {
      list = list.filter(g => g.gpCatalog);
    } else {
      // Exclude gpCatalog from all other views (they are not "owned")
      if (!parsedQ) list = list.filter(g => !g.gpCatalog);
      if (activePlatformSet.size > 0) {
        // Multi-platform: show games on any of the selected platforms
        list = list.filter(g => g.platforms.some(p => activePlatformSet.has(p)));
      } else if (currentFilter === 'dupes')  list = list.filter(g => g.platforms.length > 1);
      else if (currentFilter === 'noart')   list = list.filter(g => !coverCache[g.id] && !coverCache[String(g.id)]);
      else if (currentFilter === 'nometa')  list = list.filter(g => (!g.genres || !g.genres.length) && (!g.tags || !g.tags.length) && !g.description);
      else if (currentFilter === 'norating') list = list.filter(g => !g.userRating && g.status !== 'not-for-me' && !g.gpCatalog);
      else if (currentFilter === 'notags')  list = list.filter(g => !g.tags || !g.tags.length);
      else if (currentFilter === 'recent') { const cutoff = Date.now() - 30*24*60*60*1000; list = list.filter(g => g.addedAt && new Date(g.addedAt).getTime() > cutoff); }
      else if (currentFilter === 'unplayed') { list = list.filter(g => (g.playtimeHours||0) === 0 && g.status !== 'not-for-me' && !g.gpCatalog); }
      else if (currentFilter.startsWith('status:')) { var st = currentFilter.slice(7); list = list.filter(g => g.status === st); }
      else if (currentFilter.startsWith('intent:')) { var it = currentFilter.slice(7); list = list.filter(g => g.intent === it); }
      else if (currentFilter !== 'all' && currentFilter !== 'multi-platform') list = list.filter(g => g.platforms.includes(currentFilter));
    }
  }
  if (genreFilter && genreFilter !== 'all') list = list.filter(g => {
    if (g.genres && g.genres.includes(genreFilter)) return true;
    return g.genre === genreFilter;
  });
  const tagFilterEl = document.getElementById('tagFilter');
  const tagFilter = tagFilterEl ? tagFilterEl.value : 'all';
  if (tagFilter && tagFilter !== 'all') list = list.filter(g => g.tags && g.tags.includes(tagFilter));
  if (sort === 'alpha')                list.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === 'alpha-desc')      list.sort((a, b) => b.title.localeCompare(a.title));
  else if (sort === 'platform')        list.sort((a, b) => (a.platforms[0] || '').localeCompare(b.platforms[0] || ''));
  else if (sort === 'genre')           list.sort((a, b) => (String(a.genres && a.genres.length ? a.genres[0] : (a.genre || 'Other'))).localeCompare(String(b.genres && b.genres.length ? b.genres[0] : (b.genre || 'Other'))) || a.title.localeCompare(b.title));
  else if (sort === 'playtime-desc' || sort === 'playtime') list.sort((a, b) => (b.playtimeHours || 0) - (a.playtimeHours || 0));
  else if (sort === 'playtime-asc')    list.sort((a, b) => (a.playtimeHours || 0) - (b.playtimeHours || 0));
  else if (sort === 'recent')          list.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
  else if (sort === 'dupes')           list.sort((a, b) => b.platforms.length - a.platforms.length);
  else if (sort === 'metacritic-desc' || sort === 'metacritic') list.sort((a, b) => (b.metacriticScore || 0) - (a.metacriticScore || 0));
  else if (sort === 'metacritic-asc')  list.sort((a, b) => (a.metacriticScore || 0) - (b.metacriticScore || 0));
  return list;
}

function updateGenreDropdown() {
  var sel = document.getElementById('genreFilter');
  var current = sel.value;
  // Strict canonical list only — never append library genres (avoids [object Object] etc.)
  var CANONICAL_GENRES = ['Action','Adventure','Casual','Free to Play','Indie',
    'Massively Multiplayer','Racing','RPG','Simulation','Sports','Strategy'];
  sel.innerHTML = '<option value="all">All Genres</option>'
    + CANONICAL_GENRES.map(g => '<option value="' + escHtml(g) + '"' + (g === current ? ' selected' : '') + '>' + escHtml(g) + '</option>').join('');
}

function updateTagDropdown() {
  var sel = document.getElementById('tagFilter');
  if (!sel) return;
  var current = sel.value;
  // Collect all unique tags across all owned games (sorted)
  var tagSet = new Set();
  games.filter(function(g) { return !g.gpCatalog; }).forEach(function(g) {
    (g.tags || []).forEach(function(t) { if (t && typeof t === 'string') tagSet.add(t); });
  });
  var tags = [...tagSet].sort();
  sel.innerHTML = '<option value="all">All Tags</option>'
    + tags.map(function(t) {
        return '<option value="' + escHtml(t) + '"' + (t === current ? ' selected' : '') + '>' + escHtml(t) + '</option>';
      }).join('');
  // Show/hide the dropdown based on whether there are any tags
  sel.style.display = tags.length ? '' : 'none';
}

function normalizeTitle(t) {
  return (typeof t === 'string' ? t : String(t || '')).toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/[:!?.,'\-]/g, ' ')
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}


// Returns groups of games that are duplicates of each other
function getDupeGroups() {
  var groups = [];
  var processedIds = new Set();

  // Group 1: games already merged onto one record (multi-platform)
  games.forEach(function(g) {
    if (g.platforms.length > 1 && !processedIds.has(g.id)) {
      groups.push({ canonical: g, duplicates: [], type: 'merged' });
      processedIds.add(g.id);
    }
  });

  // Group 2: fuzzy title matches across separate records
  var seen = {};
  games.forEach(function(g) {
    if (processedIds.has(g.id)) return;
    var key = normalizeTitle(g.title);
    if (!seen[key]) { seen[key] = []; }
    seen[key].push(g);
  });
  Object.values(seen).forEach(function(group) {
    if (group.length < 2) return;
    // canonical = the one with most playtime, or most platforms, or first
    var canonical = group.slice().sort(function(a,b) {
      return (b.playtimeHours||0) - (a.playtimeHours||0) || b.platforms.length - a.platforms.length;
    })[0];
    var duplicates = group.filter(function(g) { return g.id !== canonical.id; });
    groups.push({ canonical, duplicates, type: 'fuzzy' });
    group.forEach(function(g) { processedIds.add(g.id); });
  });

  return groups;
}
function getDupes() {
  // First: exact multi-platform (already in data)
  var exactDupes = games.filter(g => g.platforms.length > 1);
  // Also find fuzzy matches across different game records
  var seen = {};
  var fuzzyDupeIds = new Set();
  games.forEach(function(g) {
    var key = normalizeTitle(g.title);
    if (!seen[key]) { seen[key] = g; }
    else {
      // Merge platforms display — mark both as dupes
      fuzzyDupeIds.add(g.id);
      fuzzyDupeIds.add(seen[key].id);
    }
  });
  var fuzzyDupes = games.filter(g => fuzzyDupeIds.has(g.id) && g.platforms.length === 1);
  // Combine, deduplicate by id
  var allIds = new Set([...exactDupes.map(g => g.id), ...fuzzyDupes.map(g => g.id)]);
  return games.filter(g => allIds.has(g.id));
}

// ── RENDER ALL ──
function renderAll() {
  updateCounts();
  updateGenreDropdown(); updateTagDropdown();
  renderLibrary();
  updateShowHiddenBtn();
}

// ── COUNTS ──
function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── STATUS BAR ──
var _statusHideTimer = null;

function showStatus(text, pct, opts) {
  // opts: { type: 'success'|'error'|'info', autohide: ms }
  opts = opts || {};
  var bar     = document.getElementById('statusBar');
  var fill    = document.getElementById('statusBarFill');
  var track   = document.getElementById('statusBarTrack');
  var label   = document.getElementById('statusBarText');
  var spinner = document.getElementById('statusBarSpinner');
  if (!bar) return;

  // Clear any pending auto-hide
  if (_statusHideTimer) { clearTimeout(_statusHideTimer); _statusHideTimer = null; }

  bar.classList.remove('status-success', 'status-error', 'visible');
  if (opts.type === 'success') bar.classList.add('status-success');
  if (opts.type === 'error')   bar.classList.add('status-error');

  label.textContent = text;

  var isIdle = (pct === 100 || opts.type === 'success' || opts.type === 'error');

  // Spinner: show while actively working, hide when done
  if (spinner) spinner.className = 'status-bar-spinner' + (isIdle ? ' hidden' : '');

  // Progress track
  if (track) track.style.display = (pct === undefined || pct < 0 || isIdle) ? 'none' : 'block';
  if (fill) {
    if (pct === undefined || pct < 0) {
      fill.classList.add('indeterminate');
      fill.style.width = '';
    } else {
      fill.classList.remove('indeterminate');
      fill.style.width = pct + '%';
    }
  }

  void bar.offsetWidth; // force reflow before adding visible
  bar.classList.add('visible');

  // Auto-hide completed/error states after a delay
  if (isIdle || opts.autohide) {
    _statusHideTimer = setTimeout(hideStatus, opts.autohide || 3000);
  }
}

function hideStatus() {
  var bar = document.getElementById('statusBar');
  if (bar) bar.classList.remove('visible');
  if (_statusHideTimer) { clearTimeout(_statusHideTimer); _statusHideTimer = null; }
}

function updateCounts() {
  const dupes = getDupes();
  const sc = function(p) { return games.filter(g => g.platforms.includes(p)).length; };

  // gpCatalog entries are NOT owned — exclude from the main owned count
  var ownedGames = games.filter(g => !g.gpCatalog);
  var gpCatalogCount = games.filter(g => g.gpCatalog).length;

  var totalEl = document.getElementById('sbTotalCount');
  if (totalEl) totalEl.innerHTML = ownedGames.length + ' <span>games</span>';
  setText('sb-count-all',    ownedGames.length);
  setText('sb-count-steam',  sc('steam'));
  setText('sb-count-gog',    sc('gog'));
  setText('sb-count-epic',   sc('epic'));
  setText('sb-count-amazon', sc('amazon'));
  setText('sb-count-xbox',   sc('xbox'));
  setText('sb-count-gamepass', gpCatalogCount);
  setText('sb-count-dupes',  dupes.length);
  setText('chip-all',        ownedGames.length);
  setText('chip-steam',      sc('steam'));
  setText('chip-gog',        sc('gog'));
  setText('chip-epic',       sc('epic'));
  setText('chip-amazon',     sc('amazon'));
  setText('chip-xbox',       sc('xbox'));
  setText('chip-dupes',      dupes.length);
  var noArtCount = games.filter(function(g) { return !coverCache[g.id] && !coverCache[String(g.id)]; }).length;
  setText('chip-noart',      noArtCount);
  var recentCutoff = Date.now() - 30*24*60*60*1000;
  var recentCount  = games.filter(function(g) { return g.addedAt && new Date(g.addedAt).getTime() > recentCutoff; }).length;
  setText('chip-recent',     recentCount);
  setText('chip-exploring',  games.filter(function(g) { return g.status === 'exploring'; }).length);
  setText('chip-finished',   games.filter(function(g) { return g.status === 'finished'; }).length);
  setText('chip-unplayed',   games.filter(function(g) { return (g.playtimeHours||0) === 0 && g.status !== 'not-for-me' && !g.gpCatalog; }).length);
  setText('chip-notforme',   games.filter(function(g) { return g.status === 'not-for-me'; }).length);
  setText('chip-intent-playnext', games.filter(function(g) { return g.intent === 'playnext'; }).length);
  setText('chip-intent-priority', games.filter(function(g) { return g.intent === 'priority'; }).length);
  setText('chip-intent-queue',    games.filter(function(g) { return g.intent === 'queue'; }).length);
  var pip = document.getElementById('navPip');
  if (pip) pip.style.display = dupes.length > 0 ? 'block' : 'none';
  setText('sb-count-dupes',     dupes.length);
  setText('sb-count-noart',     games.filter(function(g) { return !coverCache[g.id] && !coverCache[String(g.id)]; }).length);
  setText('sb-count-nometa',    games.filter(function(g) { return !g.gpCatalog && (!g.genres || !g.genres.length) && (!g.tags || !g.tags.length) && !g.description; }).length);
  setText('sb-count-norating',  games.filter(function(g) { return !g.userRating && g.status !== 'not-for-me' && !g.gpCatalog; }).length);
  setText('sb-count-hidden',    games.filter(function(g) { return !!g.hidden; }).length);
}

// ── LIBRARY RENDER ──
function renderLibrary() {
  kbFocusIdx = -1;
  updateCounts();
  const list = getFiltered();
  const area = document.getElementById('gameArea');

  if (list.length === 0) {
    area.innerHTML = '<div class="empty-state"><div class="empty-icon">\uD83C\uDFAE</div><h3>Nothing matches</h3><p>Try adjusting your search or filters.</p></div>';
    return;
  }

  area.innerHTML = '<div class="area-header"><div class="area-title">Games</div><div class="area-count">' + list.length + ' result' + (list.length !== 1 ? 's' : '') + '</div></div>';

  if (currentView === 'grid') {
    const grid = document.createElement('div');
    grid.className = 'game-grid';
    list.forEach(function(g, i) {
      var pal = COVER_PALETTES[(g.pal || 0) % COVER_PALETTES.length];
      var isDupe   = g.platforms.length > 1;
      var isNew    = g.addedAt && (Date.now() - new Date(g.addedAt).getTime()) < 30*24*60*60*1000;
      var isHidden = !!g.hidden;
      var card = document.createElement('div');
      card.className = 'game-card';
      if (g.status) card.dataset.status = g.status;
      card.style.animationDelay = (i * 0.025) + 's';
      if (isHidden) card.style.opacity = '0.5';
      var coverUrl = coverCache[g.id] || coverCache[String(g.id)];
      var gradBg = 'linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')';
      var hasArt = !!coverUrl;
      var coverInner = hasArt
        ? '<img src="' + coverUrl + '" class="cover-img" alt="' + escHtml(g.title) + '" data-gameid="' + g.id + '" onerror="nexusCoverError(this)">'
        : '<div class="cover-art" style="background:' + gradBg + ';position:relative">'
            + '<div class="cover-gradient"></div>'
            + '<div class="cover-title-overlay">' + escHtml(g.title) + '</div>'
            + '<button class="find-art-btn" onclick="event.stopPropagation();openCoverSearch(' + g.id + ')" title="Find cover art">🔍 Find Art</button>'
            + '</div>';
      var playtimeBadge = (g.playtimeHours && g.playtimeHours > 0)
        ? '<div class="playtime-badge">' + (g.playtimeHours >= 1000 ? Math.round(g.playtimeHours/1000) + 'k' : g.playtimeHours) + 'h</div>'
        : '';
      var newBadge    = isNew    ? '<div class="new-badge">NEW</div>' : '';
      var hiddenBadge = isHidden ? '<div style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.75);color:#fb923c;font-size:9px;font-weight:800;padding:2px 6px;border-radius:4px">HIDDEN</div>' : '';
      var gpBadge     = g.gpCatalog ? '<div class="gp-catalog-badge">GAME PASS</div>' : '';
      var intentBadge = g.intent ? '<div style="position:absolute;bottom:6px;left:6px;font-size:8px;font-weight:800;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,0.75);color:' + (INTENT_COLOR[g.intent]||'#fff') + '">' + (INTENT_LABEL[g.intent]||'') + '</div>' : '';
      var mcScore = g.metacriticScore ? g.metacriticScore : null;
      var mcColor = !mcScore ? null : mcScore >= 80 ? '#4ade80' : mcScore >= 60 ? '#facc15' : '#f87171';
      card.innerHTML =
        '<div class="game-card-cover">' +
          coverInner +
          (isDupe ? '<div class="dupe-badge">×' + g.platforms.length + '</div>' : '') +
          playtimeBadge +
          newBadge +
          hiddenBadge +
          gpBadge +
          intentBadge +
          (mcScore ? '<div class="mc-badge" style="background:' + mcColor + ';left:auto;right:6px;">' + mcScore + '</div>' : '') +
        '</div>' +
        '<div class="game-card-body">' +
          '<div class="card-title">' + escHtml(g.title) + '</div>' +
          '<div class="card-meta">' +
            '<div class="card-genre">' +
              (g.status ? '<span class="card-status-dot" style="background:' + STATUS_COLOR[g.status] + '"></span>' : '') +
              escHtml(g.genres && g.genres.length ? g.genres.filter(function(x){return typeof x==='string';}).join(' · ') : (g.genre || '')) +
            '</div>' +
            '<div class="card-platforms">' +
              g.platforms.map(function(p) {
                return '<div class="plat-dot" style="background:' + (getComputedStyle(document.body).getPropertyValue('--' + p).trim() || '#888') + '" title="' + (PLAT_LABEL[p] || p) + '"></div>';
              }).join('') +
            '</div>' +
          '</div>' +
          (g.tags && g.tags.length ? '<div class="card-tag-row">' + g.tags.slice(0,3).map(function(t) { return '<span class="card-tag">' + escHtml(t) + '</span>'; }).join('') + '</div>' : '') +
        '</div>';
      card.addEventListener('click', function(e) {
        if (e.shiftKey || bulkMode) {
          e.preventDefault();
          toggleBulkSelect(g.id, card);
        } else {
          openGameDetail(g);
        }
      });
      card.addEventListener('contextmenu', function(e) { showContextMenu(e, g); });
      grid.appendChild(card);
    });
    area.appendChild(grid);

  } else {
    var listEl = document.createElement('div');
    listEl.className = 'game-list';
    listEl.id = 'libraryList';
    listEl.innerHTML =
      '<div class="list-header">' +
        '<div class="list-header-cell">Title</div>' +
        '<div class="list-header-cell">Genre</div>' +
        '<div class="list-header-cell">Platforms</div>' +
        '<div class="list-header-cell">Played</div>' +
        '<div class="list-header-cell">Score</div>' +
        '<div class="list-header-cell">Status</div>' +
        '<div class="list-header-cell"></div>' +
      '</div>';
    list.forEach(function(g, i) {
      var isDupe = g.platforms.length > 1;
      var platTokens = {
        steam: 'var(--steam)', gog: 'var(--gog)', epic: 'var(--epic)',
        amazon: 'var(--amazon)', xbox: 'var(--xbox)', gamepass: 'var(--gamepass)'
      };
      var color = platTokens[g.platforms[0]] || '#888';
      var coverUrl = coverCache[g.id] || coverCache[String(g.id)];
      var pal = COVER_PALETTES[(g.pal || 0) % COVER_PALETTES.length];
      var thumbHtml = coverUrl
        ? '<img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:5px" onerror="this.style.display=\'none\'">'
        : '<div style="width:100%;height:100%;border-radius:5px;background:linear-gradient(135deg,' + pal[0] + ',' + pal[1] + ')"></div>';
      var row = document.createElement('div');
      row.className = 'list-row' + (isDupe ? ' is-dupe' : '') + (g.hidden ? ' is-hidden' : '');
      row.style.animationDelay = (i * 0.02) + 's';
      row.innerHTML =
        '<div class="list-game-name">' +
          '<div class="list-thumb">' + thumbHtml + '</div>' +
          '<div style="min-width:0">' +
            '<div class="list-title-text">' + escHtml(g.title) + '</div>' +
            (isDupe ? '<span class="list-dupe-tag">\xD7' + g.platforms.length + '</span>' : '') +
            (g.gpCatalog ? '<span class="gp-catalog-tag">GAME PASS</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="list-genre">' + escHtml(g.genres && g.genres.length ? g.genres.filter(function(x){return typeof x==='string';})[0] || '' : (g.genre || '')) + '</div>' +
        '<div class="list-plats">' +
          g.platforms.map(function(p) {
            return '<span class="plat-pill plat-' + p + '">' + (PLAT_LABEL[p] || p) + '</span>';
          }).join('') +
        '</div>' +
        '<div class="list-playtime">' + (g.playtimeHours > 0 ? (fmtHrs(g.playtimeHours)) + 'h' : '<span style="color:var(--text3)">—</span>') + '</div>' +
        '<div class="list-mc-col">' +
          (g.metacriticScore ? '<span style="font-family:\'Syne\',sans-serif;font-size:11px;font-weight:800;color:' + (g.metacriticScore >= 80 ? '#4ade80' : g.metacriticScore >= 60 ? '#facc15' : '#f87171') + '">' + g.metacriticScore + '</span>' : '<span style="color:var(--text3)">—</span>') +
        '</div>' +
        '<div>' +
          (g.status ? '<span class="list-status-badge list-status-' + g.status + '">' + g.status + '</span>' : '') +
        '</div>' +
        '<div class="list-actions">' +
          '<button class="list-action-btn" title="Remove game">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>' +
          '</button>' +
        '</div>';
      row.addEventListener('click', function(e) {
        if (e.shiftKey || bulkMode) { e.preventDefault(); toggleBulkSelect(g.id, row); }
        else { openGameDetail(g); }
      });
      row.addEventListener('contextmenu', function(e) { showContextMenu(e, g); });
      row.querySelector('.list-action-btn').addEventListener('click', function(e) {
        e.stopPropagation();
        promptDelete(g);
      });
      listEl.appendChild(row);
    });
    area.appendChild(listEl);
  }
}

// ── STATS PAGE ──
async function renderStats() {
  const area = document.getElementById('statsArea');
  const dupes = getDupes();
  const sc = function(p) { return games.filter(g => g.platforms.includes(p)).length; };

  // ── Load sessions for burn down ──
  var allSessionData = {};
  try { allSessionData = await window.nexus.store.getByPrefix('sessions:') || {}; } catch(e) {}
  var allSessions = [];
  Object.entries(allSessionData).forEach(function(entry) {
    var gameId = entry[0].replace('sessions:', '');
    var game = games.find(function(g) { return String(g.id) === String(gameId); });
    if (!game) return;
    (entry[1] || []).forEach(function(s) {
      var secs = Math.max(0, Number(s.seconds) || 0);
      if (secs === 0) return;
      allSessions.push({ gameId: gameId, title: game.title, game: game, date: new Date(s.date), seconds: secs });
    });
  });
  allSessions.sort(function(a,b) { return b.date - a.date; });

  // Platform data
  const platData = [
    ['Steam','steam',sc('steam'),'var(--steam)'],
    ['GOG','gog',sc('gog'),'var(--gog)'],
    ['Epic','epic',sc('epic'),'var(--epic)'],
    ['Amazon','amazon',sc('amazon'),'var(--amazon)'],
    ['Xbox','xbox',sc('xbox'),'var(--xbox)'],
  ].filter(r => r[2] > 0);
  const maxPlat = Math.max(...platData.map(r => r[2]), 1);

  // Genre data
  const genres = {};
  games.forEach(function(g) {
    var keys = (g.genres && g.genres.length) ? g.genres : [g.genre || 'Other'];
    keys.forEach(function(k) {
      if (k && typeof k === 'string') genres[k] = (genres[k] || 0) + 1;
    });
  });
  const topGenres = Object.entries(genres).sort((a,b) => b[1]-a[1]).slice(0, 8);
  const maxG = topGenres.length ? topGenres[0][1] : 1;
  const genreColors = ['#7fc8f8','#a78bfa','#f472b6','#fb923c','#4ade80','#facc15','#38bdf8','#e879f9'];

  // Playtime data
  const withTime = games.filter(g => g.playtimeHours > 0).sort((a,b) => b.playtimeHours - a.playtimeHours);
  const totalHours = games.reduce((s, g) => s + (g.playtimeHours || 0), 0);
  const top10 = withTime.slice(0, 10);
  const maxTime = top10.length ? top10[0].playtimeHours : 1;
  const steamGames = games.filter(g => g.platforms.includes('steam'));
  const needsResync = steamGames.length > 0 && withTime.length === 0;

  // Recently added (last 7 days)
  const cutoff = Date.now() - 7*24*60*60*1000;
  const recentGames = games.filter(g => g.addedAt && new Date(g.addedAt).getTime() > cutoff)
    .sort((a,b) => new Date(b.addedAt) - new Date(a.addedAt)).slice(0, 8);

  // Wishlist value summary
  var wishValue = 0, wishLowest = 0, wishCount = 0;
  wishlist.forEach(function(w) {
    if (w.bestPrice !== null && w.bestPrice !== undefined) { wishValue += w.bestPrice; wishCount++; }
    if (w.lowestPrice) wishLowest += w.lowestPrice;
  });

  // SVG donut chart for genres
  function makeDonut(segments, size) {
    var total = segments.reduce((s,seg) => s + seg.count, 0);
    if (!total) return '';
    var r = size/2 - 8, cx = size/2, cy = size/2;
    var circumference = 2 * Math.PI * r;
    var offset = 0;
    var paths = segments.slice(0, 6).map(function(seg, i) {
      var pct = seg.count / total;
      var dash = pct * circumference;
      var gap  = circumference - dash;
      var el = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none"'
        + ' stroke="' + seg.color + '" stroke-width="16"'
        + ' stroke-dasharray="' + dash.toFixed(1) + ' ' + gap.toFixed(1) + '"'
        + ' stroke-dashoffset="' + (-offset * circumference).toFixed(1) + '"'
        + ' transform="rotate(-90 ' + cx + ' ' + cy + ')"/>';
      offset += pct;
      return el;
    });
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">'
      + paths.join('') + '</svg>';
  }


  // Status breakdown
  var statusCounts = { exploring: 0, finished: 0, 'not-for-me': 0, none: 0 };
  games.forEach(function(g) {
    if (g.status && statusCounts[g.status] !== undefined) statusCounts[g.status]++;
    else if (!g.status) statusCounts.none++;
  });
  var completionRate = games.length ? Math.round((statusCounts.finished / games.length) * 100) : 0;
  var avgPlaytime = withTime.length ? Math.round(totalHours / withTime.length) : 0;

  // Tag cloud (top 20 tags)
  var tagCounts = {};
  games.forEach(function(g) {
    (g.tags || []).forEach(function(t) {
      if (t && typeof t === 'string') tagCounts[t] = (tagCounts[t] || 0) + 1;
    });
  });
  var topTags = Object.entries(tagCounts).sort(function(a,b) { return b[1]-a[1]; }).slice(0, 20);

  // Status breakdown data
  var statusCounts = { exploring: 0, finished: 0, 'not-for-me': 0, none: 0 };
  games.forEach(function(g) {
    if (g.status && statusCounts[g.status] !== undefined) statusCounts[g.status]++;
    else statusCounts.none++;
  });
  var completionRate = games.length ? Math.round((statusCounts.finished / games.length) * 100) : 0;
  var avgPlaytime    = withTime.length ? Math.round(totalHours / withTime.length) : 0;

  var donutSegments = topGenres.slice(0, 6).map(function(e, i) { return { label: e[0], count: e[1], color: genreColors[i] }; });
  var donut = makeDonut(donutSegments, 140);

  area.innerHTML =
    // ── Row 1: headline numbers ──
    '<div class="stats-grid">' +
      statCard(games.length, 'Total Games', 'var(--text)', 'all') +
      statCard(games.filter(function(g){ return (g.playtimeHours||0) === 0 && g.status !== 'not-for-me' && !g.gpCatalog; }).length, 'Unplayed Backlog', COLOR.backlog, 'unplayed') +
      statCard(withTime.length, 'Games Played', '#7fc8f8', 'playtime') +
      statCard(totalHours >= 1000 ? (totalHours/1000).toFixed(1) + 'k' : totalHours, 'Hours Played', 'var(--steam)') +
      statCard(statusCounts.finished, 'Games Finished', COLOR.success, 'status:finished') +
      statCard(dupes.length, 'Duplicates', 'var(--dupe)', 'dupes') +
    '</div>' +

    // ── Row 2: three-column layout ──
    '<div class="stats-cols">' +

      // Platform bars
      '<div class="stats-panel">' +
        '<div class="stat-bar-title">By Platform</div>' +
        platData.map(function(row) {
          return '<div class="stat-bar-row" style="cursor:pointer" onclick="setFilter(\'' + row[1] + '\');showPage(\'library\')" title="View ' + row[0] + ' games">' +
            '<div class="stat-bar-label">' + row[0] + '</div>' +
            '<div class="stat-bar-track"><div class="stat-bar-fill" style="width:' + ((row[2]/maxPlat)*100).toFixed(1) + '%;background:' + row[3] + '"></div></div>' +
            '<div class="stat-bar-count">' + row[2] + '</div>' +
          '</div>';
        }).join('') +
      '</div>' +

      // Genre donut + legend + Fix Genres button
      '<div class="stats-panel" style="display:flex;gap:16px;align-items:center">' +
        '<div style="flex-shrink:0">' + donut + '</div>' +
        '<div style="flex:1">' +
          '<div class="stat-bar-title" style="margin-bottom:10px">Genres' +
            (genres['Other'] > 0 ? ' <button onclick="fetchSteamGenresForOtherGames()" style="font-size:9px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text3);padding:2px 7px;cursor:pointer;margin-left:6px" title="Fetch multi-genre data from Steam for all games">Fetch All Genres</button>' : '') +
          '</div>' +
          donutSegments.map(function(s) {
            return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">' +
              '<div style="width:8px;height:8px;border-radius:50%;background:' + s.color + ';flex-shrink:0"></div>' +
              '<div style="font-size:11px;color:var(--text2);flex:1">' + escHtml(s.label) + '</div>' +
              '<div style="font-size:11px;color:var(--text3)">' + s.count + '</div>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>' +

      // Wishlist value panel
      '<div class="stats-panel">' +
        '<div class="stat-bar-title">Wishlist Value</div>' +
        (wishCount > 0
          ? '<div style="margin-bottom:12px">' +
              '<div class="stat-card-num" style="font-size:28px;color:var(--epic)">$' + wishValue.toFixed(2) + '</div>' +
              '<div style="font-size:11px;color:var(--text3);margin-top:2px">current best price · ' + wishCount + ' tracked</div>' +
            '</div>' +
            '<div style="margin-bottom:12px">' +
              '<div class="stat-card-num" style="font-size:22px;color:#4ade80">$' + wishLowest.toFixed(2) + '</div>' +
              '<div style="font-size:11px;color:var(--text3);margin-top:2px">historical low total</div>' +
            '</div>' +
            '<div style="font-size:11px;color:var(--text3)">Potential savings: <span style="color:#4ade80">$' + Math.max(0, wishValue - wishLowest).toFixed(2) + '</span> if all hit lows</div>'
          : '<div style="font-size:12px;color:var(--text3);padding:12px 0">No price data yet.<br>Check prices from the Wishlist page.</div>'
        ) +
      '</div>' +
    '</div>' +

    // ── Row 3: Playtime leaderboard ──
    (needsResync
      ? ('<div class="stats-panel" style="margin-bottom:20px">' +
          '<div class="stat-bar-title">Most Played</div>' +
          '<div style="font-size:12px;color:var(--text3);padding:8px 0">Playtime data not yet loaded — go to Settings and click <strong style=\"color:var(--steam)\">Re-sync Steam Library</strong> to populate this.</div>' +
        '</div>')
      : top10.length
        ? ('<div class="stats-panel" style="margin-bottom:20px">' +
            '<div class="stat-bar-title">Most Played</div>' +
            top10.map(function(g, i) {
              var pct = ((g.playtimeHours / maxTime) * 100).toFixed(1);
              return '<div class="stat-bar-row">' +
                '<div class="stat-bar-rank">' + (i+1) + '</div>' +
                '<div class="stat-bar-label" style="width:160px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(g.title) + '">' + escHtml(g.title) + '</div>' +
                '<div class="stat-bar-track"><div class="stat-bar-fill" style="width:' + pct + '%;background:linear-gradient(90deg,var(--steam),#7fc8f8)"></div></div>' +
                '<div class="stat-bar-count">' + (g.playtimeHours >= 1000 ? (g.playtimeHours/1000).toFixed(1)+'k' : g.playtimeHours) + 'h</div>' +
              '</div>';
            }).join('') +
          '</div>')
        : '') +

    // ── Row 4: Recently Added ──
    (recentGames.length ? '<div class="stats-panel">' +
      '<div class="stat-bar-title">Recently Added (Last 30 Days)</div>' +
      '<div class="stats-recent-grid">' +
      recentGames.map(function(g) {
        var cUrl = coverCache[g.id] || coverCache[String(g.id)];
        var pal  = COVER_PALETTES[(g.pal || 0) % COVER_PALETTES.length];
        var daysAgo = Math.floor((Date.now() - new Date(g.addedAt).getTime()) / (24*60*60*1000));
        return '<div class="recent-game-card">' +
          (cUrl ? '<img src="' + cUrl + '" class="recent-game-thumb">' : '<div class="recent-game-thumb" style="background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')"></div>') +
          '<div class="recent-game-info">' +
            '<div class="recent-game-title">' + escHtml(g.title) + '</div>' +
            '<div class="recent-game-meta">' + (daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : daysAgo + 'd ago') + ' · ' + escHtml(g.genre || 'Other') + '</div>' +
          '</div>' +
        '</div>';
      }).join('') +
      '</div></div>' : '') +


    '<div id="statsExtraPanels"></div>' +
    burnDownSection(allSessions) +
    BRAND_FOOTER_HTML;
    

  // Render deferred panels (need DOM to exist first)
  requestAnimationFrame(function() {
    renderStatusPanel();
  });

    function statCard(num, label, color, filterTarget) {
    var clickAttr = filterTarget
      ? ' style="cursor:pointer" onclick="setFilter(\'' + filterTarget + '\');showPage(\'library\')"'
      : '';
    return '<div class="stat-card"' + clickAttr + '>' +
      '<div class="stat-card-num" style="color:' + color + '">' + num + '</div>' +
      '<div class="stat-card-label">' + label + (filterTarget ? ' ↗' : '') + '</div>' +
      '</div>';
  }

  
}
// ── DUPES PAGE ──
function renderDupesPage() {
  var groups = getDupeGroups().filter(function(gr) { return gr.duplicates.length > 0 || gr.type === 'merged'; });
  var area = document.getElementById('dupesArea');
  if (groups.length === 0) {
    area.innerHTML = '<div class="empty-state"><div class="empty-icon">\u2705</div><h3>Clean library.</h3><p>No duplicates detected — every title is unique across your platforms.</p></div>';
    return;
  }

  area.innerHTML = '<div class="area-header"><div class="area-title">Duplicates</div><div class="area-count">' + groups.length + ' duplicate group' + (groups.length !== 1 ? 's' : '') + '</div></div>';
  var listEl = document.createElement('div');
  listEl.className = 'game-list';
  listEl.innerHTML =
    '<div class="list-header">' +
      '<div class="list-header-cell" style="flex:2">Title</div>' +
      '<div class="list-header-cell">Platforms</div>' +
      '<div class="list-header-cell">Type</div>' +
      '<div class="list-header-cell" style="width:180px"></div>' +
    '</div>';

  groups.forEach(function(gr, i) {
    var g = gr.canonical;
    var platTokens = {
      steam: 'var(--steam)', gog: 'var(--gog)', epic: 'var(--epic)',
      amazon: 'var(--amazon)', xbox: 'var(--xbox)', gamepass: 'var(--gamepass)'
    };
    var color = platTokens[g.platforms[0]] || '#888';
    var row = document.createElement('div');
    row.className = 'list-row is-dupe';
    row.style.animationDelay = (i * 0.03) + 's';

    var allPlatforms = [...g.platforms];
    gr.duplicates.forEach(function(d) {
      d.platforms.forEach(function(p) { if (!allPlatforms.includes(p)) allPlatforms.push(p); });
    });

    var typeLabel = gr.type === 'merged'
      ? '<span style="font-size:10px;color:var(--text3)">\u2714 Merged</span>'
      : '<span style="font-size:10px;color:var(--dupe)">\u26A0 Separate records</span>';

    var dupeList = gr.duplicates.length
      ? '<div style="font-size:10px;color:var(--text3);margin-top:2px">' +
          gr.duplicates.map(function(d) { return escHtml(d.title) + ' (' + d.platforms.join(', ') + ')'; }).join(' · ') +
        '</div>'
      : '';

    row.innerHTML =
      '<div class="list-game-name" style="flex:2">' +
        '<div class="list-accent" style="background:' + color + '"></div>' +
        '<div>' +
          '<div class="list-title-text">' + escHtml(g.title) + '</div>' +
          dupeList +
        '</div>' +
      '</div>' +
      '<div class="list-plats">' +
        allPlatforms.map(function(p) {
          return '<span class="plat-pill plat-' + p + '">' + (PLAT_LABEL[p] || p) + '</span>';
        }).join('') +
      '</div>' +
      '<div>' + typeLabel + '</div>' +
      '<div class="list-actions" style="width:180px;gap:6px">' +
        (gr.type === 'fuzzy'
          ? '<button class="list-action-btn merge-btn" style="width:auto;padding:4px 10px;font-size:10px;color:#4ade80;border-color:#4ade80" title="Merge into one record">Merge</button>'
          : '') +
        '<button class="list-action-btn" title="Open game detail">\u2261</button>' +
        '<button class="list-action-btn delete-btn" title="Remove">' +
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>' +
        '</button>' +
      '</div>';

    if (gr.type === 'fuzzy') {
      var mergeBtn = row.querySelector('.merge-btn');
      if (mergeBtn) mergeBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        mergeGameRecords(gr.canonical, gr.duplicates);
      });
    }
    row.querySelector('.list-action-btn:not(.merge-btn):not(.delete-btn)').addEventListener('click', function(e) {
      e.stopPropagation(); openGameDetail(g);
    });
    row.querySelector('.delete-btn').addEventListener('click', function(e) {
      e.stopPropagation(); promptDelete(g);
    });
    row.addEventListener('click', function() { openGameDetail(g); });
    row.addEventListener('contextmenu', function(e) { showContextMenu(e, g); });
    listEl.appendChild(row);
  });
  area.appendChild(listEl);
}

async function mergeGameRecords(canonical, duplicates) {
  var dupTitles = duplicates.map(function(d) { return '"' + d.title + '"'; }).join(', ');
  if (!confirm(
    'Merge ' + dupTitles + ' into "' + canonical.title + '"?\n\n' +
    '✓ Platforms will be combined\n' +
    '✓ Play sessions will be transferred\n' +
    '✓ Best playtime & rating kept\n' +
    '✓ Cover art transferred if needed\n\n' +
    'The duplicate entry will be removed. Your total game count will decrease by ' +
    duplicates.length + ' — this is expected, as these are the same game.'
  )) return;

  // ── Build merged fields ──────────────────────────────────────────
  var allPlatforms = [...canonical.platforms];
  var bestPlaytime = Math.max(0, canonical.playtimeHours || 0);
  var mergedTags   = [...(canonical.tags || [])];
  var mergedGenres = [...(canonical.genres || (canonical.genre ? [canonical.genre] : []))];
  var bestRating   = canonical.userRating || 0;
  var bestStatus   = canonical.status;
  var bestNotes    = canonical.notes || '';
  // Keep earliest addedAt, latest lastPlayedAt
  var earliestAdded  = canonical.addedAt ? new Date(canonical.addedAt).getTime() : Date.now();
  var latestPlayed   = canonical.lastPlayedAt ? new Date(canonical.lastPlayedAt).getTime() : 0;

  // Status priority: finished > playing > playnext > want > unplayed
  var statusPriority = { 'finished': 5, 'playing': 4, 'playnext': 3, 'want': 2, 'unplayed': 1, 'not-for-me': 0 };

  duplicates.forEach(function(d) {
    // Platforms
    (d.platforms || []).forEach(function(p) { if (!allPlatforms.includes(p)) allPlatforms.push(p); });
    // Playtime — take the highest (Steam sometimes double-counts, so max is safest)
    bestPlaytime = Math.max(bestPlaytime, Math.max(0, d.playtimeHours || 0));
    // Tags & genres
    (d.tags || []).forEach(function(t) { if (!mergedTags.includes(t)) mergedTags.push(t); });
    (d.genres || (d.genre ? [d.genre] : [])).forEach(function(g) { if (!mergedGenres.includes(g)) mergedGenres.push(g); });
    // Rating — keep highest
    if ((d.userRating || 0) > bestRating) bestRating = d.userRating;
    // Status — keep highest priority
    if ((statusPriority[d.status] || 0) > (statusPriority[bestStatus] || 0)) bestStatus = d.status;
    // Notes — append if different
    if (d.notes && d.notes !== bestNotes) bestNotes = bestNotes ? bestNotes + '\n' + d.notes : d.notes;
    // Dates
    if (d.addedAt && new Date(d.addedAt).getTime() < earliestAdded) earliestAdded = new Date(d.addedAt).getTime();
    if (d.lastPlayedAt && new Date(d.lastPlayedAt).getTime() > latestPlayed) latestPlayed = new Date(d.lastPlayedAt).getTime();
  });

  // ── Update canonical record ──────────────────────────────────────
  var existingAliases = canonical.mergedTitles || [];
  var newAliases = duplicates.map(function(d) { return d.title; });
  // Also carry forward any aliases the duplicates themselves had
  duplicates.forEach(function(d) {
    (d.mergedTitles || []).forEach(function(a) { if (!newAliases.includes(a)) newAliases.push(a); });
  });
  var allAliases = existingAliases.concat(newAliases.filter(function(a) { return !existingAliases.includes(a); }));

  var fields = {
    platforms:     allPlatforms,
    playtimeHours: bestPlaytime,
    tags:          mergedTags,
    genres:        mergedGenres,
    genre:         mergedGenres[0] || canonical.genre || 'Other',
    userRating:    bestRating || canonical.userRating,
    status:        bestStatus || canonical.status,
    notes:         bestNotes || canonical.notes,
    addedAt:       new Date(earliestAdded).toISOString(),
    lastPlayedAt:  latestPlayed > 0 ? new Date(latestPlayed).toISOString() : canonical.lastPlayedAt,
    steamAppId:    canonical.steamAppId || duplicates.find(function(d) { return d.steamAppId; })?.steamAppId,
    mergedTitles:  allAliases,
  };
  await window.nexus.games.update(canonical.id, fields);

  // ── Transfer cover art ───────────────────────────────────────────
  var canonicalHasCover = coverCache[canonical.id] || coverCache[String(canonical.id)];
  if (!canonicalHasCover) {
    for (var i = 0; i < duplicates.length; i++) {
      var dupCover = coverCache[duplicates[i].id] || coverCache[String(duplicates[i].id)];
      if (dupCover) {
        coverCache[canonical.id] = dupCover;
        coverCache[String(canonical.id)] = dupCover;
        break;
      }
    }
  }

  // ── Transfer sessions from duplicates to canonical ───────────────
  try {
    var canonicalSessions = await window.nexus.store.get('sessions:' + canonical.id) || [];
    for (var j = 0; j < duplicates.length; j++) {
      var dupSessions = await window.nexus.store.get('sessions:' + duplicates[j].id) || [];
      if (dupSessions.length) {
        // Tag transferred sessions so we know their origin
        var tagged = dupSessions.map(function(s) {
          return Object.assign({}, s, { mergedFrom: duplicates[j].title });
        });
        canonicalSessions = canonicalSessions.concat(tagged);
        // Delete duplicate's session store
        await window.nexus.store.delete('sessions:' + duplicates[j].id);
      }
    }
    if (canonicalSessions.length) {
      await window.nexus.store.set('sessions:' + canonical.id, canonicalSessions);
    }
  } catch(e) { console.warn('Session merge failed:', e); }

  // ── Delete duplicate records ─────────────────────────────────────
  for (var k = 0; k < duplicates.length; k++) {
    await window.nexus.games.delete(duplicates[k].id);
  }

  // ── Refresh ──────────────────────────────────────────────────────
  games = await window.nexus.games.getAll();
  renderAll();
  if (currentPage === 'dupes') renderDupesPage();
  showStatus('✓ Merged "' + canonical.title + '" — platforms: ' + allPlatforms.join(', '), 100);
  setTimeout(hideStatus, 4000);
}

// ── ADD GAME MODAL ──
function openAddModal() {
  document.getElementById('newTitle').value = '';
  document.getElementById('newGenre').value = 'Action';
  document.querySelectorAll('.plat-tile').forEach(function(el) {
    el.className = 'plat-tile';
    el.querySelector('input').checked = false;
  });
  document.getElementById('modalDupeAlert').classList.remove('show');
  document.getElementById('addOverlay').classList.add('open');
  setTimeout(function() { document.getElementById('newTitle').focus(); }, 150);
}

function closeAddModal() {
  document.getElementById('addOverlay').classList.remove('open');
}

function togglePlatTile(el) {
  var p = el.dataset.p;
  var cb = el.querySelector('input');
  cb.checked = !cb.checked;
  el.className = 'plat-tile' + (cb.checked ? ' sel-' + p : '');
}

function checkDupe() {
  var val = document.getElementById('newTitle').value.trim().toLowerCase();
  var match = games.find(function(g) { return g.title.toLowerCase() === val; });
  var alertEl = document.getElementById('modalDupeAlert');
  var textEl  = document.getElementById('modalDupeText');
  if (match && val) {
    alertEl.classList.add('show');
    textEl.innerHTML = '<strong>Already in your library!</strong> You own <em>' + escHtml(match.title) + '</em> on ' +
      match.platforms.map(function(p) { return '<strong>' + (PLAT_LABEL[p] || p) + '</strong>'; }).join(' + ') +
      '. Adding will merge the platforms.';
  } else {
    alertEl.classList.remove('show');
  }
}

async function addGame() {
  var title = document.getElementById('newTitle').value.trim();
  if (!title) { document.getElementById('newTitle').focus(); return; }
  var platforms = Array.from(document.querySelectorAll('.plat-tile input:checked')).map(function(el) { return el.value; });
  if (!platforms.length) { alert('Please select at least one platform.'); return; }
  var genre = document.getElementById('newGenre').value;
  await window.nexus.games.add({ title: title, genre: genre, platforms: platforms });
  games = await window.nexus.games.getAll();
  closeAddModal();
  renderAll();
  // Kick off background enrichment for the newly added game
  setTimeout(enrichRawgGamesInBackground, 2000);
}

// ── DELETE ──
async function toggleHideCurrentGame() {
  if (!currentDetailGame) return;
  var g = currentDetailGame;
  var nowHidden = !g.hidden;
  g.hidden = nowHidden;
  await window.nexus.games.update(g.id, { hidden: nowHidden });
  games = await window.nexus.games.getAll();
  // Update button label
  var btn = document.getElementById('gameDetailHideBtn');
  if (btn) btn.textContent = nowHidden ? '👁 Unhide' : '👁 Hide';
  if (btn) { if (nowHidden) btn.classList.add('active'); else btn.classList.remove('active'); }
  renderAll();
  showStatus((nowHidden ? '👁 Hidden: ' : '👁 Visible: ') + g.title, 100);
  setTimeout(hideStatus, 2500);
}

function updateHideBtnLabel(game) {
  var btn = document.getElementById('gameDetailHideBtn');
  if (!btn) return;
  btn.textContent = game.hidden ? '👁 Unhide' : '👁 Hide';
  if (game.hidden) btn.classList.add('active'); else btn.classList.remove('active');
}

window.toggleShowHidden = function() {
  showHidden = !showHidden;
  renderAll();
  var btn = document.getElementById('showHiddenBtn');
  if (btn) {
    btn.textContent = showHidden ? '👁 Hide Hidden' : '👁 Show Hidden';
    btn.style.color = showHidden ? '#fb923c' : '';
  }
};

function updateShowHiddenBtn() {
  var hiddenCount = games.filter(function(g) { return g.hidden; }).length;
  var btn = document.getElementById('showHiddenBtn');
  if (!btn) return;
  if (hiddenCount > 0) {
    btn.style.display = 'block';
    btn.textContent = showHidden ? '👁 Hide Hidden (' + hiddenCount + ')' : '👁 Show Hidden (' + hiddenCount + ')';
    btn.style.color = showHidden ? '#fb923c' : '';
  } else {
    btn.style.display = 'none';
  }
}

async function promptDelete(game) {
  if (confirm('Remove "' + game.title + '" from your library?')) {
    await window.nexus.games.delete(game.id);
    games = await window.nexus.games.getAll();
    renderAll();
    if (currentPage === 'dupes') renderDupesPage();
    if (currentPage === 'stats') renderStats();
  }
}

// ── CLEAR LIBRARY ──
async function clearLibrary() {
  if (confirm('This will permanently delete your entire library. Are you sure?')) {
    var btn = document.getElementById('clearLibraryBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Clearing…'; }
    for (var i = 0; i < games.length; i++) {
      await window.nexus.games.delete(games[i].id);
    }
    games = [];
    renderAll();
    if (btn) { btn.disabled = false; btn.textContent = 'Clear Library'; }
    showStatus('✓ Library cleared', 100);
    setTimeout(hideStatus, 2500);
  }
}

// ── EXPORT ──
async function exportJSON() {
  var fb  = document.getElementById('exportFeedback');
  var btn = document.getElementById('exportJsonBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
  try {
    var result = await window.nexus.library.exportJSON();
    if (result.cancelled) return;
    fb.textContent = '✓ Exported ' + result.count + ' games to ' + result.path;
    fb.className = 'settings-feedback ok';
  } catch(e) {
    fb.textContent = 'Export failed: ' + e.message;
    fb.className = 'settings-feedback err';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Export JSON'; }
  }
}

async function exportCSV() {
  var fb  = document.getElementById('exportFeedback');
  var btn = document.getElementById('exportCsvBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
  try {
    var result = await window.nexus.library.exportCSV();
    if (result.cancelled) return;
    fb.textContent = '✓ Exported ' + result.count + ' games to ' + result.path;
    fb.className = 'settings-feedback ok';
  } catch(e) {
    fb.textContent = 'Export failed: ' + e.message;
    fb.className = 'settings-feedback err';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Export CSV'; }
  }
}

// ── STEAM CONNECT ──
async function connectSteam() {
  var steamId  = document.getElementById('steamId').value.trim();
  var steamKey = document.getElementById('steamKey').value.trim();
  var feedback = document.getElementById('steamFeedback');
  var btn      = document.getElementById('steamConnectBtn');

  if (!steamId || !steamKey) {
    feedback.textContent = 'Please enter both your Steam ID and API Key.';
    feedback.className = 'settings-feedback err';
    return;
  }

  feedback.textContent = 'Connecting to Steam — this may take a moment for large libraries…';
  feedback.className = 'settings-feedback';
  btn.disabled = true;
  btn.textContent = 'Importing…';
  showStatus('Importing Steam library…', -1);

  try {
    var result = await window.nexus.steam.importLibrary(steamId, steamKey);
    games = await window.nexus.games.getAll();
    renderAll();
    hideStatus();

    var syncTime = new Date(result.lastSync).toLocaleTimeString();
    feedback.textContent = 'Imported ' + result.total + ' games from Steam (' + result.added + ' new, ' + result.merged + ' merged). Synced at ' + syncTime + '.';
    feedback.className = 'settings-feedback ok';

    var syncStatusEls = document.querySelectorAll('#steam-sync-status');
    syncStatusEls.forEach(function(el) { el.textContent = 'Synced at ' + syncTime; el.className = 'account-status status-ok'; });
    var steamStatusEl = document.getElementById('steam-status');
    if (steamStatusEl) steamStatusEl.textContent = 'Connected';
    var resyncBtn = document.getElementById('steamResyncBtn');
    if (resyncBtn) { resyncBtn.disabled = false; resyncBtn.style.opacity = '1'; }
    var lastSyncLabel = document.getElementById('steamLastSyncLabel');
    if (lastSyncLabel) lastSyncLabel.textContent = 'Last synced: ' + syncTime;
    // Auto-fetch genres+tags in background after import
    setTimeout(function() { fetchSteamGenresInBackground(); }, 2000);
    // Check if any newly imported games were on the wishlist
    setTimeout(checkWishlistMatchesAfterImport, 3000);

  } catch (err) {
    feedback.textContent = 'Error: ' + err.message;
    feedback.className = 'settings-feedback err';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect Steam';
  }
}

// ── STEAM RE-SYNC ──
async function resyncSteam() {
  var feedback = document.getElementById('steamFeedback');
  var btn = document.getElementById('steamResyncBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  feedback.textContent = 'Re-syncing your Steam library…';
  feedback.className = 'settings-feedback';
  try {
    var result = await window.nexus.steam.resync();
    games = await window.nexus.games.getAll();
    renderAll();
    var syncTime = new Date(result.lastSync).toLocaleTimeString();
    feedback.textContent = 'Re-synced ' + result.total + ' games (' + result.added + ' new, ' + result.merged + ' merged). Synced at ' + syncTime;
    feedback.className = 'settings-feedback ok';
    var lastSyncLabel = document.getElementById('steamLastSyncLabel');
    if (lastSyncLabel) lastSyncLabel.textContent = 'Last synced: ' + syncTime;
    var syncStatusEls = document.querySelectorAll('#steam-sync-status');
    syncStatusEls.forEach(function(el) { el.textContent = 'Synced at ' + syncTime; el.className = 'account-status status-ok'; });
    setTimeout(function() { fetchSteamGenresInBackground(); }, 2000);
  } catch (err) {
    feedback.textContent = 'Error: ' + err.message;
    feedback.className = 'settings-feedback err';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-sync Steam Library';
  }
}

// ── LOAD SAVED STEAM STATUS ──
async function loadSteamStatus() {
  var steamId  = await window.nexus.store.get('steamId');
  var lastSync = await window.nexus.store.get('steamLastSync');
  var hasKey   = !!(await window.nexus.store.get('steamApiKey'));
  if (steamId && hasKey) {
    document.getElementById('steamId').value = steamId;
    document.getElementById('steamKey').placeholder = 'API Key saved ✓';
    var steamStatusEl = document.getElementById('steam-status');
    if (steamStatusEl) steamStatusEl.textContent = 'Connected';
    var syncText = lastSync ? 'Synced ' + new Date(lastSync).toLocaleDateString() : 'Connected';
    document.querySelectorAll('#steam-sync-status').forEach(function(el) { el.textContent = syncText; el.className = 'sidebar-row-sub'; });
    var resyncBtn = document.getElementById('steamResyncBtn');
    if (resyncBtn) { resyncBtn.disabled = false; resyncBtn.style.opacity = '1'; }
    var lastSyncLabel = document.getElementById('steamLastSyncLabel');
    if (lastSyncLabel && lastSync) lastSyncLabel.textContent = 'Last synced: ' + new Date(lastSync).toLocaleString();
  }
}

// ── GOG DIRECT IMPORT ──
async function importGOG() {
  var feedback = document.getElementById('gogFeedback');
  var btn = document.getElementById('gogImportBtn');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  feedback.textContent = 'Reading GOG Galaxy database…';
  feedback.className = 'settings-feedback';
  showStatus('Importing GOG library…', -1);
  try {
    var result = await window.nexus.gog.importFromDB();
    games = await window.nexus.games.getAll();
    renderAll();
    var syncTime = new Date(result.lastSync).toLocaleTimeString();
    feedback.textContent = 'Imported ' + result.total + ' GOG games (' + result.added + ' new, ' + result.merged + ' merged). Synced at ' + syncTime + '.';
    feedback.className = 'settings-feedback ok';
    showStatus('✓ GOG import complete — ' + result.added + ' added', 100, {type:'success'});
    document.getElementById('gogLastSyncLabel').textContent = 'Last synced: ' + syncTime;
    var gogSub = document.getElementById('gog-sync-status');
    if (gogSub) gogSub.textContent = 'Synced today';
    // Auto-enrich new games in background
    if (result.added > 0) setTimeout(enrichRawgGamesInBackground, 3000);
  } catch (err) {
    feedback.textContent = 'Error: ' + err.message;
    feedback.className = 'settings-feedback err';
    showStatus('✗ GOG import failed: ' + err.message, 100, {type:'error'});
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import GOG Library';
  }
}

// ── EPIC CSV IMPORT ──
async function importEpicCSV() {
  var file = document.getElementById('epicCsvInput').files[0];
  var feedback = document.getElementById('epicFeedback');
  var btn = document.getElementById('epicImportBtn');
  if (!file) return;
  btn.disabled = true;
  btn.textContent = 'Importing…';
  feedback.textContent = 'Reading file…';
  feedback.className = 'settings-feedback';
  try {
    var csvText = await file.text();
    var result = await window.nexus.epic.importFromCSV(csvText);
    games = await window.nexus.games.getAll();
    renderAll();
    feedback.textContent = 'Imported ' + result.total + ' Epic games (' + result.added + ' new, ' + result.merged + ' merged).';
    feedback.className = 'settings-feedback ok';
    var epicStatus = document.querySelector('.sidebar-row[data-filter="epic"] .sidebar-row-sub');
    if (epicStatus) epicStatus.textContent = 'Synced ✓';
  } catch (err) {
    feedback.textContent = 'Error: ' + err.message;
    feedback.className = 'settings-feedback err';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import Epic Library';
  }
}

// ── EPIC CSV TEMPLATE DOWNLOAD ──
function downloadEpicTemplate() {
  var csv = 'Title,Genre\nFortnite,Action\nRocket League,Sports\nGenshin Impact,RPG';
  var blob = new Blob([csv], { type: 'text/csv' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'epic-games-template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ── UTILS ──
function escHtml(str) {
  if (str === null || str === undefined) return '';
  if (typeof str !== 'string') str = String(str);
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Safe playtime display — clamps negatives (bad Steam data) to 0
function fmtHrs(h) {
  var v = Math.max(0, h || 0);
  if (v === 0) return '0';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
}

function makeSparkline(history) {
  if (!history || history.length < 2) return '';
  var prices = history.map(function(h) { return h.price; });
  var min = Math.min.apply(null, prices), max = Math.max.apply(null, prices);
  var range = max - min || 1;
  var w = 80, h = 24, pad = 2;
  var pts = prices.map(function(p, i) {
    var x = pad + (i / (prices.length - 1)) * (w - pad*2);
    var y = pad + (1 - (p - min) / range) * (h - pad*2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  var trend = prices[prices.length-1] < prices[0] ? '#4ade80' : prices[prices.length-1] > prices[0] ? '#f87171' : '#7fc8f8';
  return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="margin-top:4px;display:block" title="' + prices.length + ' price records (low $' + min.toFixed(2) + ')">'
    + '<polyline points="' + pts + '" fill="none" stroke="' + trend + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>'
    + '</svg>';
}

// ── EPIC HEROIC IMPORT ──
async function importEpicHeroic() {
  var feedback = document.getElementById('epicFeedback');
  var btn = document.getElementById('epicHeroicBtn');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  feedback.textContent = 'Reading Heroic Games Launcher library…';
  feedback.className = 'settings-feedback';
  showStatus('Importing Epic & Amazon via Heroic…', -1);
  try {
    var result = await window.nexus.epic.importFromHeroic();
    games = await window.nexus.games.getAll();
    renderAll();
    var syncTime = new Date(result.lastSync).toLocaleTimeString();
    var msg = '';
    if (result.epic.total > 0) {
      msg += 'Epic: ' + result.epic.added + ' new, ' + result.epic.merged + ' merged. ';
    }
    if (result.amazon.total > 0) {
      msg += 'Amazon: ' + result.amazon.added + ' new, ' + result.amazon.merged + ' merged. ';
    }
    feedback.textContent = msg + 'Synced at ' + syncTime + '.';
    feedback.className = 'settings-feedback ok';
    showStatus('✓ Heroic import complete', 100, {type:'success'});
    setText('epicLastSyncLabel', 'Last synced: ' + syncTime);
    var epicSub = document.getElementById('epic-sync-status');
    if (epicSub) epicSub.textContent = 'Synced today';
    var amazonSub = document.getElementById('amazon-sync-status');
    if (amazonSub && result.amazon && result.amazon.total > 0) {
      amazonSub.textContent = 'Synced today';
      await window.nexus.store.set('amazonLastSync', new Date().toISOString());
    }
    // Auto-enrich new games in background
    var heroicAdded = (result.epic.added || 0) + (result.amazon.added || 0);
    if (heroicAdded > 0) setTimeout(enrichRawgGamesInBackground, 3000);
  } catch (err) {
    feedback.textContent = 'Error: ' + err.message;
    feedback.className = 'settings-feedback err';
    showStatus('✗ Heroic import failed: ' + err.message, 100, {type:'error'});
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import via Heroic';
  }
}

// ── SYNC REMINDER ──

var syncReminderDismissed = false;

async function checkSyncReminder() {
  if (syncReminderDismissed) return;
  var banner = document.getElementById('syncReminderBanner');
  if (!banner) return;

  var now = Date.now();
  function daysAgo(ts) { return ts ? Math.floor((now - new Date(ts)) / 86400000) : null; }

  // Per-platform stale thresholds (days)
  var THRESHOLDS = { steam: 30, gog: 14, epic: 14, amazon: 14, xbox: 7 };

  var steamId   = await window.nexus.store.get('steamId');
  var steamSync = await window.nexus.store.get('steamLastSync');
  var gogSync   = await window.nexus.store.get('gogLastSync');
  var epicSync  = await window.nexus.store.get('epicLastSync');
  var xboxSync  = await window.nexus.store.get('xboxLastSync');
  var amazonSync = await window.nexus.store.get('amazonLastSync');

  // Check per-platform dismiss timestamps — don't re-nag for 3 days after dismissal
  var SNOOZE_DAYS = 3;
  async function isSnoozed(platform) {
    var ts = await window.nexus.store.get('syncReminderDismissed.' + platform);
    return ts && (now - new Date(ts)) < SNOOZE_DAYS * 86400000;
  }

  var stale = [];
  var hasXbox = false;

  if (steamId && steamSync && daysAgo(steamSync) >= THRESHOLDS.steam && !(await isSnoozed('steam')))
    stale.push({ name: 'Steam', days: daysAgo(steamSync) });
  if (gogSync && daysAgo(gogSync) >= THRESHOLDS.gog && !(await isSnoozed('gog')))
    stale.push({ name: 'GOG', days: daysAgo(gogSync) });
  if (epicSync && daysAgo(epicSync) >= THRESHOLDS.epic && !(await isSnoozed('epic')))
    stale.push({ name: 'Epic', days: daysAgo(epicSync) });
  if (amazonSync && daysAgo(amazonSync) >= THRESHOLDS.amazon && !(await isSnoozed('amazon')))
    stale.push({ name: 'Amazon', days: daysAgo(amazonSync) });
  if (xboxSync && daysAgo(xboxSync) >= THRESHOLDS.xbox && !(await isSnoozed('xbox'))) {
    stale.push({ name: 'Xbox', days: daysAgo(xboxSync) });
    hasXbox = true;
  }

  if (!stale.length) { banner.style.display = 'none'; return; }

  var textEl = document.getElementById('syncReminderText');
  if (textEl) {
    var names = stale.map(function(s) { return s.name + ' (' + s.days + 'd ago)'; });
    if (hasXbox && stale.length === 1) {
      textEl.innerHTML = '<strong>Xbox</strong> hasn\'t been synced in ' + daysAgo(xboxSync) + ' days — Game Pass titles rotate regularly, so you may be missing new additions or games that have left the catalog.';
    } else if (hasXbox) {
      textEl.innerHTML = '<strong>' + names.join(', ') + '</strong> are overdue for a sync. Xbox in particular rotates Game Pass titles frequently — resync to stay up to date.';
    } else {
      textEl.innerHTML = '<strong>' + names.join(', ') + '</strong> ' + (stale.length === 1 ? 'hasn\'t' : 'haven\'t') + ' been synced in a while — you may be missing new games.';
    }
  }

  banner.style.display = 'flex';
}

window.dismissSyncReminder = async function() {
  syncReminderDismissed = true;
  var banner = document.getElementById('syncReminderBanner');
  if (banner) banner.style.display = 'none';
  // Snooze all currently stale platforms for 3 days
  var now = Date.now();
  var platforms = ['steam', 'gog', 'epic', 'amazon', 'xbox'];
  for (var p of platforms) {
    var lastSync = await window.nexus.store.get(p + 'LastSync');
    if (lastSync) await window.nexus.store.set('syncReminderDismissed.' + p, new Date().toISOString());
  }
  // Allow re-check next session
  setTimeout(function() { syncReminderDismissed = false; }, 3 * 86400000);
};

// ── LOAD SAVED PLATFORM SYNC STATUS ──
async function loadPlatformSyncStatus() {
  var gogSync    = await window.nexus.store.get('gogLastSync');
  var epicSync   = await window.nexus.store.get('epicLastSync');
  var amazonSync = await window.nexus.store.get('amazonLastSync');

  function syncLabel(ts) {
    if (!ts) return null;
    var d = new Date(ts);
    var age = Math.floor((Date.now() - d) / 86400000);
    if (age === 0) return 'Synced today';
    if (age === 1) return 'Synced yesterday';
    if (age <= 7)  return 'Synced ' + age + 'd ago';
    return 'Synced ' + d.toLocaleDateString();
  }

  if (gogSync) {
    document.getElementById('gogLastSyncLabel') && (document.getElementById('gogLastSyncLabel').textContent = 'Last synced: ' + new Date(gogSync).toLocaleString());
    var el = document.getElementById('gog-sync-status');
    if (el) el.textContent = syncLabel(gogSync);
  }
  if (epicSync) {
    var el2 = document.getElementById('epic-sync-status');
    if (el2) el2.textContent = syncLabel(epicSync);
  }
  if (amazonSync) {
    var el3 = document.getElementById('amazon-sync-status');
    if (el3) el3.textContent = syncLabel(amazonSync);
  }
}

// ── COVER ART ──

async function loadSavedCredentials() {
  igdbClientId     = await window.nexus.store.get('igdbClientId') || '';
  igdbClientSecret = await window.nexus.store.get('igdbClientSecret') || '';
  ggdealsApiKey    = await window.nexus.store.get('ggdealsApiKey') || '';
  rawgApiKey       = await window.nexus.store.get('rawgApiKey') || '';
  openxblApiKey    = await window.nexus.store.get('openxblApiKey') || '';

  console.log('[Nexus] Credentials loaded — IGDB ID:', igdbClientId ? '✓ present' : '✗ empty',
    '| IGDB Secret:', igdbClientSecret ? '✓ present' : '✗ empty',
    '| gg.deals:', ggdealsApiKey ? '✓ present' : '✗ empty',
    '| RAWG:', rawgApiKey ? '✓ present' : '✗ empty',
    '| OpenXBL:', openxblApiKey ? '✓ present' : '✗ empty');

  // Load persisted cover cache from separate store file
  try {
    var savedCache = await window.nexus.covers.loadCache();
    if (savedCache && typeof savedCache === 'object') {
      var count = Object.keys(savedCache).length;
      Object.assign(coverCache, savedCache);
      console.log('[Nexus] Cover cache loaded:', count, 'entries');
    }
  } catch(e) {
    console.warn('[Nexus] Cover cache load failed (will re-fetch):', e.message);
  }

  // Manual cover overrides take priority
  try {
    var overrides = await window.nexus.store.get('coverOverrides') || {};
    Object.assign(coverCache, overrides);
  } catch(e) {
    console.warn('[Nexus] Cover overrides load failed:', e.message);
  }

  if (ggdealsApiKey) {
    var el = document.getElementById('ggdealsApiKey');
    if (el) el.placeholder = 'API Key saved ✓';
  }
  if (rawgApiKey) {
    var rawgEl = document.getElementById('rawgApiKey');
    if (rawgEl) { rawgEl.placeholder = 'API Key saved ✓'; rawgEl.value = ''; }
    var rawgFb = document.getElementById('rawgFeedback');
    if (rawgFb) { rawgFb.textContent = '✓ RAWG key is saved and active.'; rawgFb.className = 'settings-feedback ok'; }
  }
  if (openxblApiKey) {
    var xblEl = document.getElementById('openxblApiKey');
    if (xblEl) xblEl.placeholder = 'API Key saved ✓';
    // Re-enable import buttons since key is already stored
    var xboxBtn = document.getElementById('xboxImportBtn');
    var gpBtn   = document.getElementById('gamepassImportBtn');
    if (xboxBtn) { xboxBtn.disabled = false; xboxBtn.style.opacity = '1'; }
    if (gpBtn)   { gpBtn.disabled   = false; gpBtn.style.opacity   = '1'; }
    // Update sidebar status
    var xboxSyncSt = document.getElementById('xbox-sync-status');
    if (xboxSyncSt) xboxSyncSt.textContent = 'Connected · ready to sync';
    var xboxSt = document.getElementById('xbox-status');
    if (xboxSt) xboxSt.textContent = 'Connected via OpenXBL';
  }
  if (igdbClientId) {
    // Show placeholders only — never pre-fill the actual values into the input
    // so saveIGDBAndFetch doesn't treat them as "newly typed" and overwrite with empty secret
    document.getElementById('igdbClientId').placeholder    = 'Client ID saved ✓';
    document.getElementById('igdbClientSecret').placeholder = 'Client Secret saved ✓';
  }
}

async function fetchCoversInBackground() {
  if (!games.length) return;

  // Load manual overrides — these must NEVER be overwritten by auto-fetch
  var manualOverrides = {};
  try { manualOverrides = await window.nexus.store.get('coverOverrides') || {}; } catch(e) {}

  // Only fetch art for games that don't already have a cover (cached or manually set)
  // Also skip games IGDB has confirmed have no cover art (igdbNoArt flag)
  var needsArt = games.filter(function(g) {
    var sid = String(g.id);
    return !manualOverrides[sid] && !manualOverrides[g.id] &&
           !coverCache[g.id]     && !coverCache[sid] &&
           !g.igdbNoArt;
  });

  if (!needsArt.length) {
    console.log('[Nexus] All covers cached — skipping fetch.');
    hideStatus();
    return;
  }
  console.log('[Nexus] Fetching covers for', needsArt.length, '/', games.length, 'games');

  // Phase 1: Steam CDN + IGDB exact batch — fast
  var totalBatches = Math.ceil(needsArt.length / 50);
  var batchNum = 0;
  showStatus('Fetching cover art... (0/' + totalBatches + ' batches)', 0);

  window.nexusEvents.onCoverFuzzyProgress(function(data) {
    if (data.finished) {
      showStatus('\u2713 Cover art complete — fuzzy matched ' + data.total + ' titles.', 100);
      setTimeout(hideStatus, 4000);
      window.nexusEvents.offCoverFuzzyProgress();
      // Persist the full cache now that fuzzy pass is done
      window.nexus.covers.saveCache(coverCache).catch(function(e) { console.warn("Cover cache save failed:", e.message); });
      renderLibrary();
      updateCounts();
    } else {
      var pct = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0;
      showStatus('Fuzzy cover search: ' + data.done + ' / ' + data.total + (data.title ? '  \u2014  ' + data.title : ''), pct);
      if (data.done % 20 === 0) renderLibrary();
    }
  });

  var batchSize = 50;
  for (var i = 0; i < needsArt.length; i += batchSize) {
    batchNum++;
    var batch = needsArt.slice(i, i + batchSize);
    showStatus('Fetching cover art... (' + batchNum + '/' + totalBatches + ' batches)', Math.round((batchNum / totalBatches) * 40));
    try {
      var results = await window.nexus.covers.fetchBatch(batch, igdbClientId, igdbClientSecret);
      var updated = false;
      for (var id in results) {
        // Never overwrite a manually chosen cover
        if (results[id] && !manualOverrides[id] && !manualOverrides[String(id)]) {
          coverCache[id] = results[id]; updated = true;
        }
      }
      if (updated) {
        renderLibrary();
        // Persist incrementally so a crash mid-fetch doesn't lose everything
        window.nexus.covers.saveCache(coverCache).catch(function(e) { console.warn("Cover cache save failed:", e.message); });
      }
    } catch(e) {
      console.error('Cover batch failed:', e);
    }
  }
  // Phase 2 (fuzzy) runs in main process — status bar updates via IPC events above
  // If no fuzzy games, clear the bar now
  showStatus('Batch complete. Running fuzzy search for unmatched titles...', 45);
}

// Called when a cover <img> fails to load (e.g. Steam CDN 404)
// Marks the cached URL as bad, then tries IGDB as fallback
var coverErrorPending = new Set();
window.nexusCoverError = async function(img) {
  var gameId = parseInt(img.dataset.gameid);
  if (!gameId || coverErrorPending.has(gameId)) return;
  coverErrorPending.add(gameId);

  // Protect manually chosen covers — a 404 may just be a network blip
  try {
    var overrides = await window.nexus.store.get('coverOverrides') || {};
    if (overrides[String(gameId)] || overrides[gameId]) {
      coverErrorPending.delete(gameId);
      return;
    }
  } catch(e) {}

  // Remove the broken auto-fetched URL from cache so we don't keep trying it
  delete coverCache[gameId];
  delete coverCache[String(gameId)];

  // Replace broken img with gradient placeholder immediately
  var game = games.find(function(g) { return g.id === gameId; });
  if (!game) return;
  var pal = COVER_PALETTES[(game.pal || 0) % COVER_PALETTES.length];
  var gradBg = 'linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')';
  img.parentNode.innerHTML = '<div class="cover-art" style="background:' + gradBg + '">'
    + '<div class="cover-gradient"></div>'
    + '<div class="cover-title-overlay">' + escHtml(game.title) + '</div>'
    + '</div>';

  // Try IGDB as fallback (works for Steam games too via title search)
  if (!igdbClientId || !igdbClientSecret) { coverErrorPending.delete(gameId); return; }
  try {
    var url = await window.nexus.covers.fetchOne({ id: gameId, title: game.title, steamAppId: null }, igdbClientId, igdbClientSecret);
    if (url) {
      coverCache[gameId] = url;
      // Update the card in the DOM directly without full re-render
      var coverDiv = document.querySelector('[data-gameid="' + gameId + '"]');
      if (coverDiv && coverDiv.parentNode) {
        coverDiv.parentNode.innerHTML = '<img src="' + url + '" class="cover-img" alt="' + escHtml(game.title) + '" data-gameid="' + gameId + '" onerror="nexusCoverError(this)">';
      } else {
        renderLibrary(); // fallback: full re-render
      }
    }
  } catch(e) {
    console.error('[cover fallback] failed for', game.title, ':', e.message);
  } finally {
    coverErrorPending.delete(gameId);
  }
};

// ── WISHLIST COVER FETCHING ──
var wishCoverPending = new Set();

async function nexusWishCoverError(img, wishIdStr, title) {
  var wishId = parseInt(wishIdStr);
  if (wishCoverPending.has(wishId)) { img.style.display = 'none'; return; }
  wishCoverPending.add(wishId);
  img.style.display = 'none'; // hide broken image immediately

  // Show placeholder in its place
  var placeholder = document.createElement('div');
  placeholder.className = 'wish-cover-placeholder';
  placeholder.textContent = '🎮';
  img.parentNode.insertBefore(placeholder, img);

  if (!igdbClientId || !igdbClientSecret) { wishCoverPending.delete(wishId); return; }
  try {
    var url = await window.nexus.covers.fetchOne({ id: 0, title: title, steamAppId: null }, igdbClientId, igdbClientSecret);
    if (url) {
      wishCoverCache[wishId] = url;
      // Update DOM directly
      var card = document.querySelector('[data-wishid="' + wishId + '"]');
      if (card && card.parentNode) {
        var newImg = document.createElement('img');
        newImg.src = url;
        newImg.className = 'wish-cover';
        newImg.alt = title;
        card.parentNode.replaceChild(newImg, card);
        // Also remove the placeholder we added
        if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
      }
    }
  } catch(e) {
    console.error('[wish cover fallback] failed for', title, ':', e.message);
  } finally {
    wishCoverPending.delete(wishId);
  }
};

// Fetch covers for wishlist items without steamAppId (non-Steam) on page load
async function fetchWishlistCoversInBackground() {
  if (!igdbClientId || !igdbClientSecret) return;
  var needsCover = wishlist.filter(function(w) {
    return !wishCoverCache[w.id] && !w.steamAppId
      && !games.find(function(g) { return g.title.toLowerCase() === w.title.toLowerCase() && (coverCache[g.id] || coverCache[String(g.id)]); });
  });
  if (!needsCover.length) return;
  for (var i = 0; i < needsCover.length; i++) {
    var w = needsCover[i];
    try {
      var url = await window.nexus.covers.fetchOne({ id: 0, title: w.title, steamAppId: null }, igdbClientId, igdbClientSecret);
      if (url) {
        wishCoverCache[w.id] = url;
        // Update any rendered card
        var placeholder = document.querySelector('.wish-cover-placeholder[data-wishid="' + w.id + '"]');
        if (placeholder) {
          var img = document.createElement('img');
          img.src = url; img.className = 'wish-cover'; img.alt = w.title;
          placeholder.parentNode.replaceChild(img, placeholder);
        }
      }
    } catch(e) { /* skip */ }
  }
}



// ── GAME DETAIL MODAL ──
var currentDetailGame = null;

function openGameDetailById(id) {
  var g = games.find(function(gm) { return gm.id === id || gm.id === parseInt(id); });
  if (g) openGameDetail(g);
}

function navigateDetail(dir) {
  if (!currentDetailGame) return;
  var list = getFiltered();
  var idx  = list.findIndex(function(g) { return g.id === currentDetailGame.id; });
  if (idx === -1) return;
  var next = list[idx + dir];
  if (next) openGameDetail(next);
}
function openGameDetail(game) {
  currentDetailGame = game;
  var overlay = document.getElementById('gameDetailOverlay');

  // Cover + backdrop
  var coverDiv = document.getElementById('gameDetailCover');
  var url = coverCache[game.id] || coverCache[String(game.id)];
  coverDiv.innerHTML = url
    ? '<img src="' + url + '" alt="' + escHtml(game.title) + '" style="width:100%;height:100%;object-fit:cover">'
    : '<div style="width:100%;height:100%;background:linear-gradient(145deg,' + COVER_PALETTES[(game.pal||0)%COVER_PALETTES.length].join(',') + ');display:flex;align-items:center;justify-content:center;font-size:12px;color:rgba(255,255,255,0.5);text-align:center;padding:8px;box-sizing:border-box">' + escHtml(game.title) + '</div>';
  // Set blurred backdrop
  var backdrop = document.getElementById('gameDetailBackdrop');
  if (backdrop) {
    var pal = COVER_PALETTES[(game.pal||0)%COVER_PALETTES.length];
    backdrop.style.backgroundImage = url
      ? 'url("' + url + '")'
      : 'linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')';
  }

  // Title
  document.getElementById('gameDetailTitle').textContent = game.title;

  // Platforms
  document.getElementById('gameDetailPlatforms').innerHTML = (game.platforms || []).map(function(p) {
    return '<span class="plat-pill plat-' + p + '">' + (PLAT_LABEL[p] || p) + '</span>';
  }).join('');

  // Playtime
  var ptEl = document.getElementById('gameDetailPlaytime');
  if (game.playtimeHours && game.playtimeHours > 0) {
    var ptText = fmtHrs(game.playtimeHours) + ' hours played';
    ptEl.textContent = ptText;
  } else {
    ptEl.textContent = 'No playtime recorded';
  }

  // Genre — set primary + show all current genres
  var genreSel = document.getElementById('gameDetailGenre');
  genreSel.value = game.genre || 'Other';
  if (!genreSel.value) genreSel.value = 'Other';
  // Update the secondary genre tags display
  renderDetailGenres(game.genres || (game.genre ? [game.genre] : []));

  // Status
  document.querySelectorAll('.status-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.status === (game.status || ''));
  });

  // Intent — show/hide based on eligibility, set active state
  var intentRow = document.getElementById('gameDetailIntentRow');
  if (intentRow) {
    intentRow.style.display = INTENT_ELIGIBLE(game) ? '' : 'none';
    renderIntentButtons(game.intent || null);
  }

  // Tags
  renderDetailTags(game.tags || []);

  // Notes
  document.getElementById('gameDetailNotes').value = game.notes || '';
  document.getElementById('gameDetailSavedLabel').textContent = '';

  // Also Known As — merged titles
  var aliasSection = document.getElementById('gameDetailAliasesSection');
  var aliasContainer = document.getElementById('gameDetailAliases');
  if (aliasSection && aliasContainer) {
    var aliases = game.mergedTitles || [];
    if (aliases.length) {
      aliasSection.style.display = '';
      aliasContainer.innerHTML = aliases.map(function(a, idx) {
        return '<div style="display:flex;align-items:center;gap:4px;background:var(--surface3);border:1px solid var(--border2);border-radius:6px;padding:3px 8px 3px 10px;font-size:11px;color:var(--text2)">' +
          '<span>' + escHtml(a) + '</span>' +
          '<button onclick="removeGameAlias(' + idx + ')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:11px;padding:0 0 0 4px;line-height:1" title="Remove alias">✕</button>' +
        '</div>';
      }).join('');
    } else {
      aliasSection.style.display = 'none';
      aliasContainer.innerHTML = '';
    }
  }
  updateHideBtnLabel(game);
  // Update Open in Store button label to show the right platform
  var storeBtn = document.getElementById('gameDetailOpenStore');
  if (storeBtn) {
    var label = game.steamAppId ? '🎮 Open in Steam'
      : (game.platforms && game.platforms.includes('gog'))   ? '👾 Open on GOG'
      : (game.platforms && game.platforms.includes('epic'))  ? '🟣 Open on Epic'
      : (game.platforms && game.platforms.includes('amazon'))? '📦 Open Amazon Gaming'
      : '🔍 Search Store';
    storeBtn.textContent = label;
  }
  // Date acquired
  var acqEl = document.getElementById('gameDetailAcquired');
  if (acqEl) acqEl.value = game.acquiredAt ? game.acquiredAt.slice(0,10) : (game.addedAt ? game.addedAt.slice(0,10) : '');
  var wishBtn = document.getElementById('gameDetailWishlistBtn');
  var inWishlist = wishlist.find(function(w) { return w.title.toLowerCase() === game.title.toLowerCase(); });
  // Wishlist is for unowned games — hide if owned; show wishlist status if tracked
  if (game.platforms && game.platforms.length > 0) {
    // Game is in the library = owned. Only show wishlist btn if they somehow also wishlisted it
    wishBtn.style.display = inWishlist ? 'inline-flex' : 'none';
    wishBtn.textContent = '♥ On Wishlist';
    wishBtn.style.color = '#f472b6';
  } else {
    wishBtn.style.display = 'inline-flex';
    wishBtn.textContent = inWishlist ? '♥ On Wishlist' : '♡ Add to Wishlist';
    wishBtn.style.color = inWishlist ? '#f472b6' : '';
  }

  overlay.classList.add('open');

  // Render enriched data panel if available
  renderDetailEnrichedPanel(game);
  // Render personal rating stars
  renderStarRating(game.userRating || 0);
  // Render existing feedback (reaction + short review)
  renderDetailFeedback(game);
  // Render session timer
  renderSessionPanel(game);
}

function closeGameDetail() {
  document.getElementById('gameDetailOverlay').classList.remove('open');
  var ocEl = document.getElementById('ocResult'); if (ocEl) { ocEl.style.display = 'none'; ocEl.innerHTML = ''; }
  var ssEl = document.getElementById('steamStoreResult'); if (ssEl) { ssEl.style.display = 'none'; ssEl.innerHTML = ''; }
  var enEl = document.getElementById('gameDetailEnriched'); if (enEl) { enEl.style.display = 'none'; enEl.innerHTML = ''; }
  currentDetailGame = null;
  stopSessionTimer();
}

function renderDetailGenres(genres) {
  var container = document.getElementById('gameDetailGenreList');
  if (!container) return;
  container.innerHTML = '';
  (genres || []).filter(function(genre) { return genre && typeof genre === 'string'; }).forEach(function(genre) {
    var span = document.createElement('span');
    span.className = 'tag-pill genre-pill';
    span.innerHTML = escHtml(genre);
    if (genre !== (currentDetailGame && currentDetailGame.genre)) {
      // Non-primary genre: add remove button
      var btn = document.createElement('button');
      btn.className = 'tag-pill-remove';
      btn.innerHTML = '&times;';
      btn.addEventListener('click', function() { removeDetailGenre(genre); });
      span.appendChild(btn);
    }
    container.appendChild(span);
  });
}

async function removeDetailGenre(genre) {
  if (!currentDetailGame) return;
  var genres = (currentDetailGame.genres || []).filter(function(g) { return g !== genre; });
  if (!genres.length) genres = ['Other'];
  var primaryGenre = genres[0];
  await window.nexus.games.update(currentDetailGame.id, { genre: primaryGenre, genres });
  currentDetailGame.genre = primaryGenre; currentDetailGame.genres = genres;
  var g = games.find(function(g2) { return g2.id === currentDetailGame.id; });
  if (g) { g.genre = primaryGenre; g.genres = genres; }
  document.getElementById('gameDetailGenre').value = primaryGenre;
  renderDetailGenres(genres);
  updateGenreDropdown(); updateTagDropdown(); renderLibrary();
}

async function addDetailGenre(genre) {
  if (!currentDetailGame || !genre) return;
  var genres = currentDetailGame.genres ? [...currentDetailGame.genres] : [currentDetailGame.genre || 'Other'];
  if (genres.includes(genre)) return;
  genres.push(genre);
  await window.nexus.games.update(currentDetailGame.id, { genres });
  currentDetailGame.genres = genres;
  var g = games.find(function(g2) { return g2.id === currentDetailGame.id; });
  if (g) g.genres = genres;
  renderDetailGenres(genres);
  updateGenreDropdown(); updateTagDropdown(); renderLibrary();
}

async function removeGameAlias(idx) {
  if (!currentGame) return;
  var aliases = (currentGame.mergedTitles || []).filter(function(_, i) { return i !== idx; });
  await window.nexus.games.update(currentGame.id, { mergedTitles: aliases });
  currentGame.mergedTitles = aliases;
  var game = games.find(function(g) { return g.id === currentGame.id; });
  if (game) game.mergedTitles = aliases;
  // Re-render just the alias section
  var aliasSection = document.getElementById('gameDetailAliasesSection');
  var aliasContainer = document.getElementById('gameDetailAliases');
  if (aliasSection && aliasContainer) {
    if (aliases.length) {
      aliasContainer.innerHTML = aliases.map(function(a, i) {
        return '<div style="display:flex;align-items:center;gap:4px;background:var(--surface3);border:1px solid var(--border2);border-radius:6px;padding:3px 8px 3px 10px;font-size:11px;color:var(--text2)">' +
          '<span>' + escHtml(a) + '</span>' +
          '<button onclick="removeGameAlias(' + i + ')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:11px;padding:0 0 0 4px;line-height:1" title="Remove alias">✕</button>' +
        '</div>';
      }).join('');
    } else {
      aliasSection.style.display = 'none';
      aliasContainer.innerHTML = '';
    }
  }
}

function renderDetailTags(tags) {  var container = document.getElementById('gameDetailTags');
  container.innerHTML = '';
  tags.forEach(function(tag) {
    var span = document.createElement('span');
    span.className = 'tag-pill';
    span.innerHTML = escHtml(tag) + '<button class="tag-pill-remove">&times;</button>';
    span.querySelector('button').addEventListener('click', function() { window.removeGameDetailTag(tag); });
    container.appendChild(span);
  });
}

async function saveGameDetailGenre() {
  if (!currentDetailGame) return;
  var genre = document.getElementById('gameDetailGenre').value;
  // Update primary genre; if genres array exists, replace primary slot
  var genres = currentDetailGame.genres ? [...currentDetailGame.genres] : [currentDetailGame.genre || 'Other'];
  if (!genres.includes(genre)) genres.unshift(genre);
  else { genres.splice(genres.indexOf(genre), 1); genres.unshift(genre); }
  await window.nexus.games.update(currentDetailGame.id, { genre, genres });
  currentDetailGame.genre = genre; currentDetailGame.genres = genres;
  var g = games.find(function(g) { return g.id === currentDetailGame.id; });
  if (g) { g.genre = genre; g.genres = genres; }
  renderDetailGenres(genres);
  document.getElementById('gameDetailGenreSave').textContent = '✓ Saved';
  setTimeout(function() { document.getElementById('gameDetailGenreSave').textContent = 'Save'; }, 1500);
  updateGenreDropdown(); updateTagDropdown();
  renderLibrary();
}

async function setGameStatus(status) {
  if (!currentDetailGame) return;
  await window.nexus.games.update(currentDetailGame.id, { status });
  currentDetailGame.status = status;
  var g = games.find(function(g) { return g.id === currentDetailGame.id; });
  if (g) g.status = status;
  document.querySelectorAll('.status-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.status === status);
  });
  // Hide intent for finished/not-for-me, clear it if needed
  var intentRow = document.getElementById('gameDetailIntentRow');
  if (intentRow) {
    var eligible = INTENT_ELIGIBLE(currentDetailGame);
    intentRow.style.display = eligible ? '' : 'none';
    if (!eligible && currentDetailGame.intent) {
      await window.nexus.games.update(currentDetailGame.id, { intent: null });
      currentDetailGame.intent = null;
      if (g) g.intent = null;
      renderIntentButtons(null);
    }
    // Clear momentum boost on finished/not-for-me
    if (!eligible && currentDetailGame.momentumAt) {
      await window.nexus.games.update(currentDetailGame.id, { momentumAt: null });
      currentDetailGame.momentumAt = null;
      if (g) g.momentumAt = null;
    }
  }
  renderLibrary();

  // Trigger feedback overlay when marking finished
  if (status === 'finished') {
    var gameForFeedback = Object.assign({}, currentDetailGame);
    setTimeout(function() { openGameFeedback(gameForFeedback, false); }, 200);
  }
}

async function addGameDetailTag() {
  if (!currentDetailGame) return;
  var input = document.getElementById('gameDetailTagInput');
  var tag = input.value.trim().toLowerCase();
  if (!tag) return;
  var tags = currentDetailGame.tags ? [...currentDetailGame.tags] : [];
  if (tags.includes(tag)) { input.value = ''; return; }
  tags.push(tag);
  await window.nexus.games.update(currentDetailGame.id, { tags });
  currentDetailGame.tags = tags;
  var g = games.find(function(g) { return g.id === currentDetailGame.id; });
  if (g) g.tags = tags;
  input.value = '';
  renderDetailTags(tags);
  updateTagDropdown();
  renderLibrary();
}

window.removeGameDetailTag = async function(tag) {
  if (!currentDetailGame) return;
  var tags = (currentDetailGame.tags || []).filter(function(t) { return t !== tag; });
  await window.nexus.games.update(currentDetailGame.id, { tags });
  currentDetailGame.tags = tags;
  var g = games.find(function(g) { return g.id === currentDetailGame.id; });
  if (g) g.tags = tags;
  renderDetailTags(tags);
  updateTagDropdown();
  renderLibrary();
};

async function saveGameDetailNotes() {
  if (!currentDetailGame) return;
  var notes = document.getElementById('gameDetailNotes').value;
  var acqEl = document.getElementById('gameDetailAcquired');
  var fields = { notes };
  if (acqEl && acqEl.value) fields.acquiredAt = acqEl.value;
  await window.nexus.games.update(currentDetailGame.id, fields);
  Object.assign(currentDetailGame, fields);
  var g = games.find(function(g) { return g.id === currentDetailGame.id; });
  if (g) Object.assign(g, fields);
  var label = document.getElementById('gameDetailSavedLabel');
  label.textContent = '✓ Saved';
  setTimeout(function() { label.textContent = ''; }, 2000);
}

// ── STEAM GENRE AUTO-FETCH ──
// Quiet background version — only shows status bar if there's actual work to do
async function fetchSteamGenresInBackground(quiet) {
  var missing = games.filter(function(g) {
    return g.platforms.includes('steam') && g.steamAppId && (!g.genres || !g.genres.length);
  });
  if (!missing.length) return; // nothing to do
  if (!quiet) showStatus('Auto-fetching genres & tags…', -1);
  await fetchSteamGenresForOtherGames();
}

async function fetchSteamGenresForOtherGames() {
  var steamOther = games.filter(function(g) {
    return g.platforms.includes('steam') && g.steamAppId
      && (!g.genres || !g.genres.length); // fetch for any game missing the genres array
  });
  if (!steamOther.length) return;

  var batchSize = 50;
  for (var i = 0; i < steamOther.length; i += batchSize) {
    var batch = steamOther.slice(i, i + batchSize);
    var appIds = batch.map(function(g) { return g.steamAppId; });
    var pct = Math.round((i / steamOther.length) * 100);
    showStatus('Fetching genres from Steam... ' + i + '/' + steamOther.length, pct);
    try {
      var results = await window.nexus.games.fetchSteamGenres(appIds);
      var updated = false;
      for (var appId in results) {
        var result = results[appId];
        var game   = batch.find(function(gm) { return String(gm.steamAppId) === String(appId); });
        if (!game || !result) continue;
        var fields = {};
        if (result.genres && result.genres.length) {
          var mappedGenres = mapSteamGenres(result.genres);
          fields.genre  = mappedGenres[0];
          fields.genres = mappedGenres;
        }
        if (result.tags && result.tags.length) {
          var existingTags = (game.tags || []).filter(function(t) { return t && typeof t === 'string'; });
          var steamTags    = result.tags.filter(function(t) { return t && typeof t === 'string'; }).map(function(t) { return t.toLowerCase(); });
          fields.tags = [...new Set([...existingTags, ...steamTags])];
        }
        if (result.metacriticScore && !game.metacriticScore) fields.metacriticScore = result.metacriticScore;
        if (result.description    && !game.description)    fields.description    = result.description;
        if (result.releaseDate    && !game.releaseDate)    fields.releaseDate    = result.releaseDate;
        if (result.developer      && !game.developer)      fields.developer      = result.developer;
        if (result.publisher      && !game.publisher)      fields.publisher      = result.publisher;
        if (Object.keys(fields).length) {
          await window.nexus.games.update(game.id, fields);
          Object.assign(game, fields);
          var gObj = games.find(function(g2) { return g2.id === game.id; });
          if (gObj) Object.assign(gObj, fields);
          updated = true;
        }
      }
      if (updated) { updateGenreDropdown(); updateTagDropdown(); renderLibrary(); }
    } catch(e) {
      console.error('Steam genre fetch failed:', e.message);
    }
  }
  showStatus('✓ Steam genres updated', 100);
  setTimeout(hideStatus, 3000);
  updateCounts();
}

function mapSteamGenre(steamGenre) {
  var map = {
    'Action': 'Action', 'Adventure': 'Adventure', 'RPG': 'RPG',
    'Strategy': 'Strategy', 'Simulation': 'Simulation', 'Sports': 'Sports',
    'Racing': 'Racing', 'Puzzle': 'Puzzle', 'Horror': 'Horror',
    'Casual': 'Casual', 'Indie': 'Indie',
    'Massively Multiplayer': 'Massively Multiplayer',
    'Free to Play': 'Free to Play',
    'Early Access': 'Other',
    'Shooter': 'FPS', 'Fighting': 'Fighting',
    'Platformer': 'Platformer', 'Stealth': 'Stealth',
    'Survival': 'Survival',
  };
  return map[steamGenre] || steamGenre;
}

// Map a full array of Steam genres to our normalized list (filters out pure noise)
function mapSteamGenres(steamGenres) {
  var skipAlone = new Set(['Early Access']); // only skip if it's the ONLY genre
  var mapped = steamGenres.filter(function(g) { return g && typeof g === 'string'; }).map(mapSteamGenre).filter(function(g) { return g && g !== 'Other'; });
  if (!mapped.length) return ['Other'];
  // If the only result is something skip-alone, return Other
  if (mapped.length === 1 && skipAlone.has(steamGenres[0])) return ['Other'];
  return [...new Set(mapped)]; // deduplicate
}

var coverSearchGameId = null;
var coverSearchFromDetail = false;


function cleanTitleForSearch(title) {
  if (!title) return title;
  return title
    // Strip trademark/copyright symbols (replace with space to avoid joining words)
    // Also catch @ used as ersatz ® (e.g. "Diablo@ IV")
    .replace(/\s*[\u2122\u00ae\u00a9@]\s*/g, ' ')
    // Strip Amazon/Epic/GOG/Prime service suffixes
    .replace(/\s*[-–]\s*Amazon\s*(Prime\s*(Gaming)?|Luna|Gaming)?\s*$/i, '')
    .replace(/\s*\(Amazon\s*(Prime\s*(Gaming)?|Luna|Gaming)?\)\s*$/i, '')
    .replace(/\s*[-–]\s*Prime\s*(Gaming|Giveaway)?\s*$/i, '')
    .replace(/\s*\(Prime\s*(Gaming|Giveaway)?\)\s*$/i, '')
    .replace(/\s*[-–]\s*Epic\s*Games?\s*$/i, '')
    .replace(/\s*[-–]\s*GOG\.?CO?M?\s*$/i, '')
    // Strip Xbox platform suffixes
    .replace(/\s+for\s+Xbox\b.*$/i, '')
    .replace(/\s*[-–]\s*Xbox\b.*$/i, '')
    .replace(/\s+Xbox\s+Series\s+X[\|\/\s]?I?S?\s*$/i, '')
    .replace(/\s+Xbox\s+(One|360|Series\s*X?\s*S?)?\s*$/i, '')
    // Additional platform suffixes seen in imports
    .replace(/\s*[-–]\s*(Xbox Game Pass|PC Game Pass|Game Pass|Ubisoft Connect|Battle\.net|Heroic|Steam)\s*$/i, '')
    // Strip platform/OS suffixes — including bare trailing "PC", "(WIN)", "Windows Edition"
    .replace(/\s*[-–]\s*Windows\s*(Edition|Version|10|11)?\s*$/i, '')
    .replace(/\s+Windows\s+Edition\s*$/i, '')
    .replace(/\s*[:\-–]\s*Windows\s*Edition\s*$/i, '')
    .replace(/\s*\(Windows\s*Edition\)\s*$/i, '')
    .replace(/\s*\((WIN|Windows|PC)\)\s*$/i, '')
    .replace(/\s*\[(WIN|Windows|PC)\]\s*$/i, '')
    .replace(/\s+PC\s*$/i, '')
    // Strip (Game Preview) and similar early-access labels
    .replace(/\s*\(Game\s*Preview\)\s*$/i, '')
    .replace(/\s*\(Early\s*Access\)\s*$/i, '')
    .replace(/\s*\(Beta\)\s*$/i, '')
    // Strip collector's/special edition shorthands
    .replace(/\s*[-–]\s*(CE|SE|GE|VE)\s*$/i, '')
    // Strip edition/version noise
    .replace(/\s*[:\-–]\s*(Complete|Gold|GOTY|Definitive|Enhanced|Remaster(ed)?|Standard|Premium|Deluxe|Ultimate|Anniversary|Special|Legacy|Directors? Cut)\s+(Edition|Version|Cut)?\s*$/i, '')
    .replace(/\s*[:\-–]\s*(Complete|Gold|GOTY|Definitive|Enhanced|Remaster(ed)?|Standard|Premium|Deluxe|Ultimate|Anniversary|Special|Legacy|Directors? Cut)\s*$/i, '')
    .replace(/\s*\(GOTY\)\s*$/i, '')
    .replace(/\s+(Edition|Version)\s*$/i, '')
    .replace(/^ARCADE GAME SERIES:\s*/i, '')
    // Strip parenthesised or bracketed platform tags
    .replace(/\s*\((PC|Windows|Win|Mac|Steam|GOG|Epic|Amazon|Prime Gaming|Heroic)\)\s*$/i, '')
    .replace(/\s*\[(PC|Windows|Win|Mac|Steam|GOG|Epic|Amazon|Prime Gaming)\]\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[:\-–,;]+\s*$/, '')
    .trim();
}

window.openCoverSearch = function(gameId) {
  coverSearchGameId = gameId;
  // coverSearchFromDetail is set before calling openCoverSearch when opened from detail
  var game = games.find(function(g) { return g.id === gameId; });
  document.getElementById('coverSearchGameLabel').textContent = game ? 'Finding art for: ' + game.title : '';
  document.getElementById('coverSearchInput').value = game ? cleanTitleForSearch(game.title) : '';
  document.getElementById('coverSearchResults').innerHTML = '';
  document.getElementById('coverSearchStatus').textContent = 'Enter a title and click Search.';
  document.getElementById('coverSearchOverlay').classList.add('open');
  // Auto-search with the game title
  runCoverSearch();
};

function closeCoverSearch() {
  document.getElementById('coverSearchOverlay').classList.remove('open');
  coverSearchGameId = null;
  coverSearchFromDetail = false; // reset — no reopen on manual close
}

async function runCoverSearch() {
  var query = document.getElementById('coverSearchInput').value.trim();
  if (!query) return;
  var status = document.getElementById('coverSearchStatus');
  var results = document.getElementById('coverSearchResults');
  status.textContent = 'Searching IGDB...';
  results.innerHTML = '';

  if (!igdbClientId || !igdbClientSecret) {
    status.textContent = 'No IGDB credentials saved. Add them in Settings first.';
    return;
  }

  try {
    var hits = await window.nexus.covers.search(query, igdbClientId, igdbClientSecret);
    if (!hits || !hits.length) {
      status.textContent = 'No results found. Try a different search term.';
      return;
    }
    status.textContent = hits.length + ' result' + (hits.length === 1 ? '' : 's') + ' — click one to use it.';
    results.innerHTML = '';
    hits.forEach(function(h) {
      var el = document.createElement('div');
      el.className = 'cover-search-result';
      el.title = h.name;
      el.dataset.coverUrl = h.coverUrl;
      el.innerHTML = '<img src="' + h.thumbUrl + '" alt="' + escHtml(h.name) + '" loading="lazy">'
        + '<div class="cover-search-result-label">' + escHtml(h.name) + '</div>'
        + (h.year ? '<div class="cover-search-result-year">' + h.year + '</div>' : '');
      el.addEventListener('click', function() { window.pickCoverResult(h.coverUrl); });
      results.appendChild(el);
    });
  } catch(e) {
    status.textContent = 'Error: ' + e.message;
  }
}

window.pickCoverResult = async function(coverUrl) {
  if (!coverSearchGameId || !coverUrl) return;
  var gameId = coverSearchGameId;
  var reopenGame = coverSearchFromDetail; // game object or false
  coverCache[gameId] = coverUrl;
  coverCache[String(gameId)] = coverUrl;
  closeCoverSearch();
  renderLibrary();
  // Reopen detail modal if Find Art was triggered from there
  if (reopenGame && reopenGame.id === gameId) {
    var fresh = games.find(function(g) { return g.id === gameId; });
    if (fresh) openGameDetail(fresh);
  }
  // Persist to both overrides (manual) and main cache
  var overrides = await window.nexus.store.get('coverOverrides') || {};
  overrides[String(gameId)] = coverUrl;
  await window.nexus.store.set('coverOverrides', overrides);
  window.nexus.covers.saveCache(coverCache).catch(function(e) { console.warn("Cover cache save failed:", e.message); });
};


async function saveIGDBAndFetch() {
  // Use typed values if provided, otherwise fall back to what's already saved in memory
  var clientId     = document.getElementById('igdbClientId').value.trim()     || igdbClientId;
  var clientSecret = document.getElementById('igdbClientSecret').value.trim() || igdbClientSecret;
  var feedback     = document.getElementById('igdbFeedback');
  var btn          = document.getElementById('igdbSaveBtn');

  if (!clientId || !clientSecret) {
    feedback.textContent = 'Please enter your IGDB Client ID and Client Secret (or save them once — they\'ll be remembered).';
    feedback.className = 'settings-feedback err';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Fetching\u2026';
  feedback.textContent = 'Fetching cover art\u2026';
  feedback.className = 'settings-feedback';

  try {
    // Only save to store if BOTH fields have newly typed values
    var typedId     = document.getElementById('igdbClientId').value.trim();
    var typedSecret = document.getElementById('igdbClientSecret').value.trim();
    if (typedId && typedSecret) {
      // Both typed — save both
      await window.nexus.covers.saveIGDBCredentials(typedId, typedSecret);
      igdbClientId     = typedId;
      igdbClientSecret = typedSecret;
      document.getElementById('igdbClientId').value = '';
      document.getElementById('igdbClientSecret').value = '';
      document.getElementById('igdbClientId').placeholder    = 'Client ID saved \u2713';
      document.getElementById('igdbClientSecret').placeholder = 'Client Secret saved \u2713';
    } else if (typedId || typedSecret) {
      // Only one typed — warn instead of saving partial credentials
      throw new Error('Please enter both Client ID and Client Secret together.');
    }
    // If neither typed, use the already-saved credentials (igdbClientId/Secret already loaded)

    // Clear old cache and refetch everything
    coverCache = {};
    await fetchCoversInBackground();

    var nonSteam = games.filter(function(g) { return !g.steamAppId; }).length;
    feedback.textContent = '\u2713 Cover art refreshed for ' + nonSteam + ' non-Steam games.';
    feedback.className = 'settings-feedback ok';
  } catch(e) {
    feedback.textContent = 'Error: ' + e.message;
    feedback.className = 'settings-feedback err';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & Fetch Art';
  }
}

// ── BOOT ──
init();

// ── WISHLIST MODAL ──

var wishModalSelectedAppId = null;
var wishModalSearchDebounce = null;
var wishModalFocusIdx = 0;

function openWishModal() {
  wishModalSelectedAppId = null;
  document.getElementById('wishGameTitle').value = '';
  document.getElementById('wishPrice').value = '';
  var wd = document.getElementById('wishDiscount'); if (wd) wd.value = '';
  document.getElementById('wishOwnedAlert').style.display = 'none';
  hideWishDropdown();
  updateWishSelectedCard(null);
  document.getElementById('wishOverlay').classList.add('open');
  setTimeout(function() { document.getElementById('wishGameTitle').focus(); }, 150);
  // Kick off cache warm if needed
  window.nexus.steam.getCacheStatus().then(function(s) {
    if (!s.ready) {
      document.getElementById('wishSearchHint').textContent = 'Downloading Steam game database in background... search will work shortly.';
    } else {
      var d = new Date(s.fetchedAt);
      document.getElementById('wishSearchHint').textContent = 'Search across ' + s.count.toLocaleString() + ' Steam titles. Select one to link its App ID for gg.deals pricing.';
    }
  });
}

function closeWishModal() {
  document.getElementById('wishOverlay').classList.remove('open');
  hideWishDropdown();
}

function hideWishDropdown() {
  var d = document.getElementById('wishDropdown');
  if (d) d.classList.remove('open');
}

function checkWishOwned() {
  var val = document.getElementById('wishGameTitle').value.trim().toLowerCase();
  var owned = games.find(function(g) { return g.title.toLowerCase() === val; });
  var alertEl = document.getElementById('wishOwnedAlert');
  var textEl  = document.getElementById('wishOwnedText');
  if (owned && val.length > 1) {
    alertEl.style.display = 'flex';
    textEl.innerHTML = 'You already own <strong>' + escHtml(owned.title) + '</strong> on ' +
      owned.platforms.map(function(p) { return '<strong>' + (PLAT_LABEL[p]||p) + '</strong>'; }).join(' + ') +
      '. You can still wishlist it to track prices.';
  } else {
    alertEl.style.display = 'none';
  }
  // Trigger search
  clearTimeout(wishModalSearchDebounce);
  var q = document.getElementById('wishGameTitle').value.trim();
  if (q.length < 2) { hideWishDropdown(); updateWishSelectedCard(null); return; }
  wishModalSearchDebounce = setTimeout(function() { runWishSearch(q); }, 280);
}

async function runWishSearch(q) {
  var dropdown = document.getElementById('wishDropdown');
  dropdown.innerHTML = '<div class="wish-search-loading"><div class="wish-spinner" style="display:inline-block"></div> Searching...</div>';
  dropdown.classList.add('open');
  wishModalFocusIdx = 0;

  try {
    var resp = await window.nexus.steam.searchApps(q);
    if (!resp.cacheReady) {
      dropdown.innerHTML = '<div class="wish-search-empty">Steam database is downloading in the background. Try again in a moment.</div>';
      return;
    }
    if (!resp.results.length) {
      dropdown.innerHTML = '<div class="wish-search-empty">No Steam titles found for "' + escHtml(q) + '"</div>';
      return;
    }
    dropdown.innerHTML = '';
    resp.results.forEach(function(r, i) {
      var item = document.createElement('div');
      item.className = 'wish-search-item' + (i === 0 ? ' focused' : '');
      item.innerHTML =
        '<span class="wish-search-item-title">' + escHtml(r.name) + '</span>' +
        '<span class="wish-search-item-appid">App ' + r.appid + '</span>';
      item.addEventListener('click', function() {
        selectWishApp(r.name, r.appid);
        dropdown.classList.remove('open');
      });
      dropdown.appendChild(item);
    });
  } catch(e) {
    dropdown.innerHTML = '<div class="wish-search-empty">Search error: ' + escHtml(e.message) + '</div>';
  }
}

function onWishTitleKeydown(e) {
  var dropdown = document.getElementById('wishDropdown');
  if (!dropdown.classList.contains('open')) return;
  var items = dropdown.querySelectorAll('.wish-search-item');
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    wishModalFocusIdx = Math.min(wishModalFocusIdx + 1, items.length - 1);
    items.forEach(function(el, i) { el.classList.toggle('focused', i === wishModalFocusIdx); });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    wishModalFocusIdx = Math.max(wishModalFocusIdx - 1, 0);
    items.forEach(function(el, i) { el.classList.toggle('focused', i === wishModalFocusIdx); });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (items[wishModalFocusIdx]) items[wishModalFocusIdx].click();
  } else if (e.key === 'Escape') {
    hideWishDropdown();
  }
}

function selectWishApp(name, appid) {
  wishModalSelectedAppId = appid;
  document.getElementById('wishGameTitle').value = name;
  updateWishSelectedCard({ name: name, appid: appid });
  checkWishOwned();
  document.getElementById('wishPrice').focus();
}

function updateWishSelectedCard(game) {
  var card = document.getElementById('wishSelectedCard');
  if (!card) return;
  if (!game) {
    card.style.display = 'none';
    card.innerHTML = '';
    return;
  }
  card.style.display = 'flex';
  card.innerHTML =
    '<span style="font-size:18px">&#127918;</span>' +
    '<span class="wish-selected-title">' + escHtml(game.name) + '</span>' +
    '<span class="wish-deal-hist" style="margin-left:auto">App ID: ' + game.appid + '</span>' +
    '<button class="wish-selected-clear" id="clearWishSelected">Clear</button>';
  var clearWishSel = document.getElementById('clearWishSelected');
  if (clearWishSel) clearWishSel.addEventListener('click', function() {
    wishModalSelectedAppId = null;
    document.getElementById('wishGameTitle').value = '';
    document.getElementById('wishGameTitle').focus();
    updateWishSelectedCard(null);
    hideWishDropdown();
  });
}

async function addToWishlist() {
  var title = document.getElementById('wishGameTitle').value.trim();
  if (!title) { document.getElementById('wishGameTitle').focus(); return; }
  var targetPrice = parseFloat(document.getElementById('wishPrice').value);

  // Use the App ID selected from search; fall back to checking the user's Steam library
  var appId = wishModalSelectedAppId;
  if (!appId) {
    var steamGame = games.find(function(g) {
      return g.title.toLowerCase() === title.toLowerCase() && g.platforms.includes('steam') && g.steamAppId;
    });
    if (steamGame) appId = steamGame.steamAppId;
  }

  async function silentPriceCheck() {
  if (!wishlist.length) return;
  try {
    var results = await window.nexus.prices.check(wishlist);
    var updates = [];
    wishlist.forEach(function(w) {
      var info = results[w.id];
      if (!info) return;
      var update = { id: w.id, retailPrice: info.retailPrice, keyshopPrice: info.keyshopPrice,
        bestPrice: info.bestPrice, ggdealsUrl: info.ggdealsUrl, lastChecked: info.lastChecked,
        noApiData: info.noApiData || false };
      if (info.histRetail !== undefined) update.histRetail = info.histRetail;
      if (info.histKeyshop !== undefined) update.histKeyshop = info.histKeyshop;
      if (info.bestPrice !== null && info.bestPrice !== undefined) {
        if (!w.lowestPrice || info.bestPrice < w.lowestPrice) update.lowestPrice = info.bestPrice;
      }
      updates.push(update);
    });
    if (updates.length) {
      wishlist = await window.nexus.wishlist.updatePrices(updates);
      renderWishlist();
    }
  } catch(e) { /* silent fail */ }
}

  var result = await window.nexus.wishlist.add({
    title: title,
    steamAppId: appId || null,
    targetPrice:       isNaN(targetPrice) ? null : targetPrice,
    discountThreshold: (() => { var d = parseFloat(document.getElementById('wishDiscount') && document.getElementById('wishDiscount').value); return isNaN(d) ? null : Math.min(99, Math.max(1, d)); })(),
  });
  if (result.exists) {
    alert(title + ' is already in your wishlist.');
    return;
  }
  wishlist = await window.nexus.wishlist.getAll();
  closeWishModal();
  renderWishlist();
  updateNavWishPip();
  setTimeout(silentPriceCheck, 800);
}

async function removeFromWishlist(id) {
  console.log('removeFromWishlist called with id:', id, typeof id);
  if (confirm('Remove this game from your wishlist?')) {
    await window.nexus.wishlist.delete(id);
    wishlist = await window.nexus.wishlist.getAll();
    renderWishlist();
    updateNavWishPip();
  }
}



async function autoRefreshWishlistPrices() {
  if (!wishlist.length) return;
  var staleThreshold = 6 * 60 * 60 * 1000;
  var needsRefresh = wishlist.some(function(w) {
    return !w.lastChecked || (Date.now() - new Date(w.lastChecked).getTime()) > staleThreshold;
  });
  if (needsRefresh) setTimeout(silentPriceCheck, 1500);
}

function updateNavWishPip() {
  var pip = document.getElementById('navWishPip');
  if (pip) pip.style.display = wishlist.length > 0 ? 'block' : 'none';
}

// ── RENDER WISHLIST ──
function renderWishlist() {
  var area = document.getElementById('wishlistArea');
  if (!area) return;
  var q = (document.getElementById('wishSearchInput') ? document.getElementById('wishSearchInput').value : '').toLowerCase();
  var list = wishlist.filter(function(w) {
    if (q && !w.title.toLowerCase().includes(q)) return false;
    if (wishFilterOwned === 'owned' && !games.find(function(g) { return normalizeTitle(g.title) === normalizeTitle(w.title); })) return false;
    if (wishFilterOwned === 'unowned' && games.find(function(g) { return normalizeTitle(g.title) === normalizeTitle(w.title); })) return false;
    return true;
  });
  // Sort wishlist
  list.sort(function(a, b) {
    if (wishSort === 'price') {
      var ap = a.bestPrice !== null && a.bestPrice !== undefined ? a.bestPrice : Infinity;
      var bp = b.bestPrice !== null && b.bestPrice !== undefined ? b.bestPrice : Infinity;
      return ap - bp;
    }
    if (wishSort === 'savings') {
      var as = (a.retailPrice && a.bestPrice !== null) ? a.retailPrice - a.bestPrice : 0;
      var bs = (b.retailPrice && b.bestPrice !== null) ? b.retailPrice - b.bestPrice : 0;
      return bs - as;
    }
    if (wishSort === 'owned') {
      var ao = games.find(function(g) { return normalizeTitle(g.title) === normalizeTitle(a.title); }) ? 0 : 1;
      var bo = games.find(function(g) { return normalizeTitle(g.title) === normalizeTitle(b.title); }) ? 0 : 1;
      return ao - bo;
    }
    return a.title.localeCompare(b.title); // alpha
  });

  if (!list.length) {
    area.innerHTML =
      '<div class="wish-empty">' +
        '<div class="wish-empty-icon">\u2764\uFE0F</div>' +
        '<h3>' + (q ? 'No results' : 'Nothing on the radar yet') + '</h3>' +
        '<p>' + (q ? 'Try a different search.' : 'Add games to your wishlist to track prices and get notified when they drop.') + '</p>'
      '</div>';
    return;
  }

  var grid = document.createElement('div');
  grid.className = 'wish-grid';

  list.forEach(function(w, i) {
    var owned = games.find(function(g) { return normalizeTitle(g.title) === normalizeTitle(w.title); });
    // Cover priority: 1) owned game's cached cover  2) Steam CDN via steamAppId  3) wishCoverCache (IGDB)  4) placeholder
    var coverUrl = (owned ? (coverCache[owned.id] || coverCache[String(owned.id)]) : null)
      || (w.steamAppId ? 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + w.steamAppId + '/library_600x900.jpg' : null)
      || wishCoverCache[w.id]
      || null;
    var bestPrice = (w.bestPrice !== null && w.bestPrice !== undefined) ? w.bestPrice : null;
    var hitTarget = (w.targetPrice && bestPrice !== null && bestPrice <= w.targetPrice) ||
      (w.discountThreshold && w.retailPrice && bestPrice !== null &&
       w.retailPrice > 0 && ((w.retailPrice - bestPrice) / w.retailPrice * 100) >= w.discountThreshold);
    var hasRetailDiscount = w.histRetail && w.retailPrice && w.retailPrice < w.histRetail;
    var ggUrl = w.ggdealsUrl || ('https://gg.deals/search/?title=' + encodeURIComponent(w.title));

    var card = document.createElement('div');
    card.className = 'wish-card' + (hasRetailDiscount ? ' on-sale' : '') + (owned ? ' owned' : '');
    card.style.animationDelay = (i * 0.04) + 's';

    var coverHtml = coverUrl
      ? '<img src="' + coverUrl + '" class="wish-cover" alt="' + escHtml(w.title) + '" data-wishid="' + w.id + '" data-title="' + escHtml(w.title) + '">'
      : '<div class="wish-cover-placeholder" data-wishid="' + w.id + '" data-title="' + escHtml(w.title) + '">&#127918;</div>';

    var priceHtml;
    if (w.lastChecked && !w.noApiData) {
      var checkedTime = new Date(w.lastChecked).toLocaleString();
      var priceRows = '';
      if (w.retailPrice !== null && w.retailPrice !== undefined) {
        var retailSaleClass = hasRetailDiscount ? ' on-sale' : '';
        priceRows +=
          '<div class="wish-deal-row-inner">' +
            '<span class="wish-deal-label">Official stores</span>' +
            '<span class="wish-deal-price' + retailSaleClass + '">$' + w.retailPrice.toFixed(2) + '</span>' +
            (w.histRetail ? '<span class="wish-deal-hist">Historical low: $' + w.histRetail.toFixed(2) + '</span>' : '') +
          '</div>';
      }
      if (w.keyshopPrice !== null && w.keyshopPrice !== undefined) {
        priceRows +=
          '<div class="wish-deal-row-inner">' +
            '<span class="wish-deal-label">Key resellers</span>' +
            '<span class="wish-deal-price on-sale">$' + w.keyshopPrice.toFixed(2) + '</span>' +
            (w.histKeyshop ? '<span class="wish-deal-hist">Historical low: $' + w.histKeyshop.toFixed(2) + '</span>' : '') +
          '</div>';
      }
      priceHtml =
        '<div class="wish-price-section">' +
          (priceRows
            ? '<div class="wish-price-rows">' + priceRows + '</div>'
            : '<div class="wish-not-checked">No pricing data available yet</div>') +
          (hitTarget ? '<div class="wish-target-hit">\uD83D\uDCB0 Below your target price!</div>' : '') +
          (w.lowestPrice ? '<div class="wish-last-checked">All-time best: $' + w.lowestPrice.toFixed(2) + '</div>' : '') +
          '<div class="wish-last-checked">Checked: ' + checkedTime + '</div>' +
        '</div>';
    } else if (w.lastChecked && w.noApiData) {
      priceHtml = '<div class="wish-price-section"><div class="wish-not-checked">No Steam App ID \u2014 click View on gg.deals to browse prices</div></div>';
    } else {
      priceHtml = '<div class="wish-price-section"><div class="wish-not-checked">Not checked yet \u2014 click \u201cCheck Prices\u201d above</div></div>';
    }

    card.innerHTML =
      '<div class="wish-card-header">' +
        coverHtml +
        '<div class="wish-info">' +
          '<div class="wish-title">' + escHtml(w.title) + '</div>' +
          (owned ? '<div class="wish-owned-badge">&#x2713; Owned on ' + owned.platforms.map(function(p) { return PLAT_LABEL[p] || p; }).join(', ') + '</div>' : '<div class="wish-owned-badge" style="visibility:hidden">-</div>') +
          (w.targetPrice || w.discountThreshold
            ? '<div class="wish-target">' +
                (w.targetPrice ? 'Alert at <span>$' + w.targetPrice.toFixed(2) + '</span>' : '') +
                (w.targetPrice && w.discountThreshold ? ' &middot; ' : '') +
                (w.discountThreshold ? '<span>' + w.discountThreshold + '% off</span>' : '') +
              '</div>'
            : '<div class="wish-target">No price target set</div>') +
          '<div class="wish-sparkline-wrap">' + makeSparkline(w.priceHistory) + '</div>' +
        '</div>' +
        '<button class="wish-delete" data-id="' + w.id + '">' +
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>' +
        '</button>' +
      '</div>' +
      priceHtml +
      '<div class="wish-actions">' +
        '<button class="wish-action-btn primary gg-btn">View on gg.deals</button>' +
        (w.priceHistory && w.priceHistory.length >= 2 ? '<button class="wish-action-btn hist-btn">&#x1F4C8; History</button>' : '') +
        '<button class="wish-action-btn" data-action="remove">Remove</button>' +
      '</div>';

    (function(id, url) {
      card.querySelector('.wish-delete').addEventListener('click', function() { removeFromWishlist(id); });
      card.querySelector('[data-action="remove"]').addEventListener('click', function() { removeFromWishlist(id); });
      card.querySelector('.gg-btn').addEventListener('click', function() { window.open(url, '_blank'); });
      var histBtn = card.querySelector('.hist-btn');
      if (histBtn) histBtn.addEventListener('click', function() { showPriceHistory(w); });
    })(w.id, ggUrl);
    var histBtn = card.querySelector('.hist-btn');
    if (histBtn) histBtn.addEventListener('click', function() { showPriceHistory(w); });

    grid.appendChild(card);
  });

    area.innerHTML = '';
    area.appendChild(grid);
    var footer = document.createElement('div');
    footer.innerHTML = BRAND_FOOTER_HTML;
    area.appendChild(footer.firstChild);

  // Attach onerror handlers to wish cover images
  grid.querySelectorAll('img.wish-cover[data-wishid]').forEach(function(img) {
    img.addEventListener('error', function() {
      nexusWishCoverError(img, img.dataset.wishid, img.dataset.title || '');
    });
  });
}

// ── CHECK ALL PRICES ──
async function checkAllPrices() {
  if (!wishlist.length) { alert('Your wishlist is empty.'); return; }
  var btn = document.getElementById('checkAllPricesBtn');
  btn.disabled = true;
  btn.innerHTML = '<div class="wish-spinner" style="display:inline-block;margin-right:6px"></div> Checking...';

  try {
    // Pass full items so main.js can use steamAppId for gg.deals API
    showStatus('Checking prices on gg.deals…', -1);
    var results = await window.nexus.prices.check(wishlist);
    var updates = [];

    wishlist.forEach(function(w) {
      var info = results[w.id];
      if (!info) return;
      var update = {
        id:           w.id,
        retailPrice:  info.retailPrice,
        keyshopPrice: info.keyshopPrice,
        bestPrice:    info.bestPrice,
        ggdealsUrl:   info.ggdealsUrl,
        lastChecked:  info.lastChecked,
        noApiData:    info.noApiData || false,
      };
      if (info.histRetail !== undefined)  update.histRetail  = info.histRetail;
      if (info.histKeyshop !== undefined) update.histKeyshop = info.histKeyshop;
      if (info.bestPrice !== null && info.bestPrice !== undefined) {
        if (!w.lowestPrice || info.bestPrice < w.lowestPrice) update.lowestPrice = info.bestPrice;
      }
      updates.push(update);
    });

    if (updates.length) {
      wishlist = await window.nexus.wishlist.updatePrices(updates);
    }
    renderWishlist();
  } catch(err) {
    var msg = err.message || '';
    if (msg.includes('Invalid key') || msg.includes('400')) {
      alert('gg.deals API key is invalid or expired.\n\nPlease go to Settings → Price Tracking, paste your key again, and click Save Key.\n\nGet a fresh key at gg.deals/api');
    } else {
      alert('Price check failed: ' + msg);
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Check Prices';
  }
}

// ── STEAM APP DATABASE (for wishlist search) ──
async function updateSteamCacheStatusDisplay() {
  var el = document.getElementById('steamCacheStatus');
  if (!el) return;
  try {
    var s = await window.nexus.steam.getCacheStatus();
    if (!s.ready) {
      el.textContent = 'Not downloaded yet. Click Refresh Database to download it (~10 MB, one-time).';
    } else {
      var age = Math.round((Date.now() - new Date(s.fetchedAt).getTime()) / (1000 * 60 * 60 * 24));
      var staleNote = s.stale ? ' (over 7 days old — consider refreshing)' : '';
      el.textContent = s.count.toLocaleString() + ' games cached \u2014 last updated ' + age + ' day' + (age !== 1 ? 's' : '') + ' ago' + staleNote;
    }
  } catch(e) {
    el.textContent = 'Could not check cache status.';
  }
}

async function refreshSteamCache() {
  var btn = document.getElementById('refreshSteamCacheBtn');
  var feedback = document.getElementById('steamCacheFeedback');
  var progress = document.getElementById('steamDlProgress');
  var barFill = document.getElementById('steamDlBarFill');
  var barLabel = document.getElementById('steamDlLabel');

  btn.disabled = true;
  btn.textContent = 'Downloading...';
  feedback.textContent = '';
  feedback.className = 'settings-feedback';
  progress.style.display = 'block';
  barFill.style.width = '0%';
  barFill.classList.remove('indeterminate');
  barLabel.textContent = 'Connecting to Steam...';

  // Listen for progress events from main process
  window.nexusEvents.onSteamAppListProgress(function(data) {
    if (data.stage === 'downloading') {
      if (data.pct >= 0) {
        barFill.classList.remove('indeterminate');
        barFill.style.width = data.pct + '%';
        barLabel.textContent = 'Fetching game list... ' + data.mb + ' (' + data.pct + '%)';
      } else {
        barFill.classList.add('indeterminate');
        barLabel.textContent = 'Fetching game list... ' + data.mb;
      }
    } else if (data.stage === 'parsing') {
      barFill.classList.remove('indeterminate');
      barFill.style.width = '85%';
      barLabel.textContent = 'Parsing game list...';
    } else if (data.stage === 'indexing') {
      barFill.style.width = '90%';
      barLabel.textContent = 'Building search index...';
    } else if (data.stage === 'saving') {
      barFill.style.width = '97%';
      barLabel.textContent = 'Saving to disk...';
    } else if (data.stage === 'done') {
      barFill.style.width = '100%';
      barLabel.textContent = data.count.toLocaleString() + ' games indexed \u2014 done!';
    }
  });

  try {
    var result = await window.nexus.steam.refreshAppList();
    barFill.style.width = '100%';
    feedback.textContent = '\u2713 Downloaded ' + result.count.toLocaleString() + ' Steam titles.';
    feedback.className = 'settings-feedback ok';
    updateSteamCacheStatusDisplay();
    // Update the wishlist search hint if it's open
    var hint = document.getElementById('wishSearchHint');
    if (hint) hint.textContent = 'Search across ' + result.count.toLocaleString() + ' Steam titles.';
  } catch(e) {
    barFill.style.width = '0%';
    barFill.classList.remove('indeterminate');
    barLabel.textContent = 'Download failed';
    feedback.textContent = 'Download failed: ' + e.message;
    feedback.className = 'settings-feedback err';
    console.error('Steam cache refresh error:', e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh Database';
    window.nexusEvents.offSteamAppListProgress();
    // Hide progress bar after a short delay on success
    setTimeout(function() {
      if (feedback.className.includes('ok')) progress.style.display = 'none';
    }, 3000);
  }
}

// ── SAVE GG.DEALS KEY ──
async function saveRawgKey() {
  var key      = document.getElementById('rawgApiKey').value.trim();
  var feedback = document.getElementById('rawgFeedback');
  var btn      = document.getElementById('rawgSaveBtn');
  if (!key) { feedback.textContent = 'Please enter your RAWG API key.'; feedback.className = 'settings-feedback err'; return; }
  btn.disabled = true;
  btn.textContent = 'Testing…';
  feedback.textContent = 'Validating key…';
  feedback.className = 'settings-feedback';
  try {
    var results = await window.nexus.rawg.search('Hades', key);
    if (!results || !results.length) throw new Error('Test search returned no results');
    await window.nexus.store.set('rawgApiKey', key);
    rawgApiKey = key;
    document.getElementById('rawgApiKey').value = '';
    document.getElementById('rawgApiKey').placeholder = 'RAWG API Key saved ✓';
    feedback.textContent = '✓ Key saved! RAWG will now enrich non-Steam games with descriptions and Metacritic scores.';
    feedback.className = 'settings-feedback ok';
  } catch(e) {
    feedback.textContent = '✗ ' + e.message;
    feedback.className = 'settings-feedback err';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Key';
  }
}

// ── OPENXBL / XBOX ──

async function saveOpenXBLKey() {
  var key      = document.getElementById('openxblApiKey').value.trim();
  var feedback = document.getElementById('xboxFeedback');
  if (!key) { feedback.textContent = 'Please enter your OpenXBL API key.'; feedback.className = 'settings-feedback err'; return; }
  try {
    // Test the key by fetching account info via main process (bypasses CSP)
    var result = await window.nexus.xbox.request('/api/v2/account', key);
    if (result.error) throw new Error('API key invalid or request failed (HTTP ' + result.status + ')');
    var data = result.data;
    var gamertag = '';
    if (data && data.profileUsers && data.profileUsers[0] && data.profileUsers[0].settings) {
      var gtSetting = data.profileUsers[0].settings.find(function(s) { return s.id === 'Gamertag'; });
      if (gtSetting) gamertag = gtSetting.value;
    }
    await window.nexus.store.set('openxblApiKey', key);
    openxblApiKey = key;
    document.getElementById('openxblApiKey').value = '';
    document.getElementById('openxblApiKey').placeholder = 'API Key saved \u2713';
    feedback.textContent = '\u2713 Connected' + (gamertag ? ' as ' + gamertag : '') + '! You can now import your Xbox library and Game Pass catalog.';
    feedback.className = 'settings-feedback ok';
    // Enable import buttons
    document.getElementById('xboxImportBtn').disabled = false;
    document.getElementById('gamepassImportBtn').disabled = false;
  } catch(e) {
    feedback.textContent = '\u2717 ' + e.message;
    feedback.className = 'settings-feedback err';
  }
}

async function importXboxLibrary() {
  var feedback = document.getElementById('xboxFeedback');
  var btn = document.getElementById('xboxImportBtn');
  if (!openxblApiKey) { feedback.textContent = '\u2717 Please save your OpenXBL API key first.'; feedback.className = 'settings-feedback err'; return; }
  btn.disabled = true;
  btn.textContent = 'Importing…';
  feedback.textContent = 'Fetching your Xbox achievement history…';
  feedback.className = 'settings-feedback';
  showStatus('Importing Xbox library…', -1);
  try {
    var result = await window.nexus.xbox.request('/api/v2/achievements', openxblApiKey);
    if (result.error) throw new Error('OpenXBL request failed (HTTP ' + result.status + ')');
    var data = result.data;

    // Response shape: { titles: [...] } or { achievementTitles: [...] }
    var titles = data.titles || data.achievementTitles || [];
    if (!Array.isArray(titles)) throw new Error('Unexpected API response format');

    var added = 0, updated = 0, skipped = 0;
    for (var i = 0; i < titles.length; i++) {
      var t = titles[i];
      // Skip non-game entries (apps, system items, DLC-only entries)
      if (!t.name || t.name.trim() === '') { skipped++; continue; }
      // Skip entries with 0 achievements and looks like system/app
      if (t.currentAchievements === 0 && t.totalAchievements === 0) { skipped++; continue; }

      var existing = games.find(function(g) {
        return g.platforms.includes('xbox') && (
          g.xboxTitleId === t.titleId ||
          normalizeTitle(g.title) === normalizeTitle(t.name)
        );
      });

      if (existing) {
        // Update playtime-adjacent data (gamerscore, last played)
        var updates = { xboxTitleId: t.titleId };
        if (t.lastPlayed || t.lastUnlock) updates.lastPlayed = t.lastPlayed || t.lastUnlock;
        if (t.currentGamerscore) updates.xboxGamerscore = t.currentGamerscore;
        if (t.currentAchievements) updates.xboxAchievements = t.currentAchievements + '/' + (t.totalAchievements || '?');
        await window.nexus.games.update(existing.id, updates);
        updated++;
      } else {
        // Check if this game exists on another platform (cross-platform ownership)
        var crossPlat = games.find(function(g) {
          return !g.platforms.includes('xbox') && normalizeTitle(g.title) === normalizeTitle(t.name);
        });
        if (crossPlat) {
          // Add xbox to existing game's platforms
          var newPlats = crossPlat.platforms.concat(['xbox']);
          await window.nexus.games.update(crossPlat.id, {
            platforms: newPlats,
            xboxTitleId: t.titleId,
            xboxGamerscore: t.currentGamerscore,
            xboxAchievements: t.currentAchievements + '/' + (t.totalAchievements || '?')
          });
          updated++;
        } else {
          // New Xbox-exclusive entry
          var newGame = {
            title: t.name,
            platforms: ['xbox'],
            xboxTitleId: t.titleId,
            xboxGamerscore: t.currentGamerscore || 0,
            xboxAchievements: (t.currentAchievements || 0) + '/' + (t.totalAchievements || '?'),
            addedAt: new Date().toISOString(),
            gpCatalog: false
          };
          if (t.lastPlayed || t.lastUnlock) newGame.lastPlayed = t.lastPlayed || t.lastUnlock;
          await window.nexus.games.add(newGame);
          added++;
        }
      }
    }

    games = await window.nexus.games.getAll();
    renderAll();
    var syncLabel = document.getElementById('xboxLastSyncLabel');
    if (syncLabel) syncLabel.textContent = 'Last sync: ' + new Date().toLocaleString();
    await window.nexus.store.set('xboxLastSync', Date.now());
    feedback.textContent = '\u2713 Xbox library imported! ' + added + ' new games added, ' + updated + ' updated, ' + skipped + ' skipped.';
    feedback.className = 'settings-feedback ok';
    showStatus('✓ Xbox import complete — ' + added + ' added, ' + updated + ' updated', 100, {type:'success'});
    // Update sidebar sync status
    var xboxSyncSt = document.getElementById('xbox-sync-status');
    if (xboxSyncSt) { xboxSyncSt.textContent = 'Synced · ' + added + ' games'; xboxSyncSt.className = 'account-status status-ok'; }
    var xboxSt = document.getElementById('xbox-status');
    if (xboxSt) xboxSt.textContent = 'Connected via OpenXBL';
  } catch(e) {
    feedback.textContent = '\u2717 Import failed: ' + e.message;
    feedback.className = 'settings-feedback err';
    showStatus('✗ Xbox import failed: ' + e.message, 100, {type:'error'});
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import Xbox Library';
  }
}

async function importGamePassCatalog() {
  var feedback = document.getElementById('xboxFeedback');
  var btn = document.getElementById('gamepassImportBtn');
  if (!openxblApiKey) { feedback.textContent = '\u2717 Please save your OpenXBL API key first.'; feedback.className = 'settings-feedback err'; return; }
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  feedback.textContent = 'Fetching PC Game Pass catalog…';
  feedback.className = 'settings-feedback';
  feedback.textContent = 'Fetching PC Game Pass catalog from Microsoft… this may take 30–60 seconds.';
  showStatus('Syncing Game Pass catalog…', -1);
  try {
    var list = await window.nexus.xbox.gamepassCatalog();
    if (!Array.isArray(list) || !list.length) throw new Error('No titles returned from Game Pass catalog API');

    // Remove stale GP catalog entries that are no longer on Game Pass
    var existingGP = games.filter(function(g) { return g.gpCatalog; });
    for (var e = 0; e < existingGP.length; e++) {
      var stillOnPass = list.some(function(item) {
        var itemTitle = item.title || item.name || item.productTitle || '';
        return normalizeTitle(existingGP[e].title) === normalizeTitle(itemTitle);
      });
      if (!stillOnPass) {
        // Game left Game Pass — remove the catalog entry
        await window.nexus.games.delete(existingGP[e].id);
      }
    }

    var added = 0, skipped = 0;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var title = item.title || item.name || item.productTitle || '';
      if (!title) { skipped++; continue; }
      var productId = item.productId || item.id || '';

      // Check if already in catalog
      var alreadyCatalog = games.find(function(g) {
        return g.gpCatalog && (
          g.gpProductId === productId ||
          normalizeTitle(g.title) === normalizeTitle(title)
        );
      });
      if (alreadyCatalog) { skipped++; continue; }

      // Check if the user already OWNS this game (don't create a duplicate catalog entry)
      var owned = games.find(function(g) {
        return !g.gpCatalog && normalizeTitle(g.title) === normalizeTitle(title);
      });
      if (owned) {
        // Just mark it as available on Game Pass — don't create separate entry
        await window.nexus.games.update(owned.id, { availableOnGamePass: true });
        skipped++;
        continue;
      }

      // New Game Pass catalog entry
      var newEntry = {
        title: title,
        platforms: ['gamepass'],
        gpCatalog: true,       // ← THE KEY FLAG: this is catalog, not owned
        gpProductId: productId,
        addedAt: new Date().toISOString(),
        genre: item.category || ''
      };
      if (item.imageUrl || item.thumbnailUrl) newEntry.gpImageUrl = item.imageUrl || item.thumbnailUrl;
      await window.nexus.games.add(newEntry);
      added++;
    }

    games = await window.nexus.games.getAll();
    renderAll();
    var syncLabel = document.getElementById('gamepassLastSyncLabel');
    if (syncLabel) syncLabel.textContent = 'Last sync: ' + new Date().toLocaleString();
    await window.nexus.store.set('gamepassLastSync', Date.now());
    feedback.textContent = '\u2713 Game Pass catalog synced! ' + added + ' titles added to the catalog. ' +
      'They appear only when filtering by "Game Pass" in the sidebar — never mixed with your owned games.';
    feedback.className = 'settings-feedback ok';
    showStatus('✓ Game Pass synced — ' + added + ' titles', 100, {type:'success'});
  } catch(e) {
    feedback.textContent = '\u2717 Catalog sync failed: ' + e.message;
    feedback.className = 'settings-feedback err';
    showStatus('✗ Game Pass sync failed: ' + e.message, 100, {type:'error'});
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync Game Pass Catalog';
  }
}

async function saveGgdealsKey() {
  var key = document.getElementById('ggdealsApiKey').value.trim();
  var feedback = document.getElementById('ggdealsFeedback');
  if (!key) { feedback.textContent = 'Please enter your gg.deals API key.'; feedback.className = 'settings-feedback err'; return; }
  await window.nexus.prices.saveKey(key);
  ggdealsApiKey = key;
  document.getElementById('ggdealsApiKey').value = '';
  document.getElementById('ggdealsApiKey').placeholder = 'API Key saved \u2713';
  feedback.textContent = '\u2713 Key saved! Head to the Wishlist page and click Check Prices.';
  feedback.className = 'settings-feedback ok';
}

// ── CHECK ALL PRICES ──


// ── STEAM APP DATABASE (for wishlist search) ──
function renderStatusPanel() {
  var el = document.getElementById('statsExtraPanels');
  if (!el) return;
  el.innerHTML = '';

  var statusCounts = { exploring: 0, finished: 0, 'not-for-me': 0, none: 0 };
  games.forEach(function(g) {
    if (g.status && statusCounts[g.status] !== undefined) statusCounts[g.status]++;
    else statusCounts.none++;
  });

  var playedCount    = games.filter(function(g){ return (g.playtimeHours||0) > 0; }).length;
  var backlogCount   = games.filter(function(g){ return (g.playtimeHours||0) === 0 && g.status !== 'not-for-me' && !g.gpCatalog; }).length;
  var totalHrs       = games.reduce(function(s,g){ return s+(g.playtimeHours||0); }, 0);
  var avgPlaytime    = playedCount ? Math.round(totalHrs / playedCount) : 0;
  var completionRate = games.length ? Math.round((statusCounts.finished / games.length) * 100) : 0;
  var backlogRate    = games.length ? Math.round((backlogCount / games.length) * 100) : 0;

  var tagCounts = {};
  games.forEach(function(g) {
    (g.tags||[]).forEach(function(t) { if(t) tagCounts[t] = (tagCounts[t]||0)+1; });
  });
  var topTags = Object.entries(tagCounts).sort(function(a,b){return b[1]-a[1];}).slice(0,20);

  var statusRows = [
    ['▶ Exploring',  'exploring',   'var(--status-playing)',   statusCounts.exploring],
    ['✓ Finished',   'finished',    'var(--status-completed)', statusCounts.finished],
    ['x Not for Me', 'not-for-me',  'var(--status-abandoned)', statusCounts['not-for-me']],
    ['— Untracked',  '',            'var(--text3)',             statusCounts.none],
  ];

  // Status panel
  var statusEl = document.createElement('div');
  statusEl.className = 'stats-cols';

  var leftPanel = document.createElement('div');
  leftPanel.className = 'stats-panel';
  leftPanel.innerHTML = '<div class="stat-bar-title">Library Status</div>';

  var barsEl = document.createElement('div');
  barsEl.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:10px';

  // Status rows
  statusRows.forEach(function(row) {
    var pct = games.length ? Math.round((row[3]/games.length)*100) : 0;
    var bar = document.createElement('div');
    bar.style.cursor = 'pointer';
    if (row[1]) bar.onclick = function() { setFilter('status:' + row[1]); showPage('library'); };
    bar.innerHTML =
      '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">' +
        '<span style="color:' + row[2] + ';font-weight:600">' + row[0] + '</span>' +
        '<span style="color:var(--text3)">' + row[3] + ' (' + pct + '%)</span>' +
      '</div>' +
      '<div style="height:4px;background:var(--surface2);border-radius:2px">' +
        '<div style="height:4px;width:' + pct + '%;background:' + row[2] + ';border-radius:2px;transition:width 0.4s"></div>' +
      '</div>';
    barsEl.appendChild(bar);
  });

  // Divider before progress bars
  var divider = document.createElement('div');
  divider.style.cssText = 'border-top:1px solid var(--border);margin:10px 0 8px';
  barsEl.appendChild(divider);

  // Completion Rate bar
  var compBar = document.createElement('div');
  compBar.style.cursor = 'pointer';
  compBar.onclick = function() { setFilter('status:finished'); showPage('library'); };
  compBar.innerHTML =
    '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">' +
      '<span style="color:#4ade80;font-weight:600">Completion Rate</span>' +
      '<span style="color:var(--text3)">' + completionRate + '%</span>' +
    '</div>' +
    '<div style="height:6px;background:var(--surface2);border-radius:3px">' +
      '<div style="height:6px;width:' + completionRate + '%;background:linear-gradient(90deg,#4ade80,#a3e635);border-radius:3px;transition:width 0.4s"></div>' +
    '</div>';
  barsEl.appendChild(compBar);

  // Avg Playtime bar (capped at 100h for visual)
  var ptPct = Math.min(100, Math.round((avgPlaytime / 100) * 100));
  var avgBar = document.createElement('div');
  avgBar.style.marginTop = '8px';
  avgBar.innerHTML =
    '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">' +
      '<span style="color:var(--steam);font-weight:600">Avg Playtime</span>' +
      '<span style="color:var(--text3)">' + avgPlaytime + 'h per game</span>' +
    '</div>' +
    '<div style="height:6px;background:var(--surface2);border-radius:3px">' +
      '<div style="height:6px;width:' + ptPct + '%;background:linear-gradient(90deg,var(--steam),#7fc8f8);border-radius:3px;transition:width 0.4s"></div>' +
    '</div>';
  barsEl.appendChild(avgBar);

  // Backlog bar — counts DOWN to zero (red when high, green when cleared)
  var bzColor = backlogRate <= 10 ? '#4ade80' : backlogRate <= 40 ? '#facc15' : '#f87171';
  var bzBar = document.createElement('div');
  bzBar.style.cssText = 'margin-top:8px;cursor:pointer';
  bzBar.onclick = function() { setFilter('unplayed'); showPage('library'); };
  bzBar.innerHTML =
    '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">' +
      '<span style="color:' + bzColor + ';font-weight:600">Backlog</span>' +
      '<span style="color:var(--text3)">' + backlogRate + '% of library · ' + backlogCount + ' unplayed</span>' +
    '</div>' +
    '<div style="height:6px;background:var(--surface2);border-radius:3px">' +
      '<div style="height:6px;width:' + backlogRate + '%;background:linear-gradient(90deg,' + bzColor + ',#fbbf24);border-radius:3px;transition:width 0.4s"></div>' +
    '</div>';
  barsEl.appendChild(bzBar);

  leftPanel.appendChild(barsEl);

  // Tag cloud panel
  var rightPanel = document.createElement('div');
  rightPanel.className = 'stats-panel';
  rightPanel.innerHTML = '<div class="stat-bar-title">Top Tags</div>';

  if (topTags.length) {
    var tagCloud = document.createElement('div');
    tagCloud.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:10px';
    topTags.forEach(function(t) {
      var size = Math.max(10, Math.min(14, 10 + Math.round((t[1]/(topTags[0][1]||1))*4)));
      var chip = document.createElement('span');
      chip.style.cssText = 'font-size:' + size + 'px;padding:3px 8px;background:var(--surface2);border:1px solid var(--border2);border-radius:20px;color:var(--text2);cursor:pointer';
      chip.innerHTML = escHtml(t[0]) + ' <span style="font-size:9px;color:var(--text3)">×' + t[1] + '</span>';
      chip.onclick = function() {
        document.getElementById('searchInput').value = t[0];
        showPage('library');
        renderLibrary();
      };
      tagCloud.appendChild(chip);
    });
    rightPanel.appendChild(tagCloud);
  } else {
    rightPanel.innerHTML += '<div style="font-size:11px;color:var(--text3);margin-top:8px">No tags yet. Add tags to your games.</div>';
  }

  statusEl.appendChild(leftPanel);
  statusEl.appendChild(rightPanel);

  // Library Health panel (third column)
  var healthPanel = document.createElement('div');
  healthPanel.className = 'stats-panel';

  var noArtGames    = games.filter(function(g) { return !g.gpCatalog && !coverCache[g.id] && !coverCache[String(g.id)]; });
  var noMetaGames   = games.filter(function(g) { return !g.gpCatalog && (!g.genres || !g.genres.length) && (!g.tags || !g.tags.length) && !g.description; });
  var noTagGames    = games.filter(function(g) { return !g.gpCatalog && (!g.tags || !g.tags.length); });
  var noStatusGames = games.filter(function(g) { return !g.gpCatalog && !g.status; });
  var dupeGames     = getDupes ? getDupes() : [];
  var noTimeGames   = games.filter(function(g) { return !g.gpCatalog && !g.playtimeHours && g.platforms.includes('steam'); });
  var totalIssues   = noArtGames.length + noMetaGames.length + noTagGames.length + noStatusGames.length;
  var healthScore   = games.length ? Math.max(0, Math.round(100 - (totalIssues / (games.length * 4)) * 100)) : 0;
  var scoreColor    = healthScore >= 80 ? '#4ade80' : healthScore >= 60 ? '#facc15' : '#f87171';

  var healthRows = [
    { label: '🖼 Missing Cover Art',  count: noArtGames.length,    filter: 'noart',  action: noArtGames.length > 0 ? '<button onclick="fetchCoversInBackground();this.textContent=\'Fetching…\';this.disabled=true" style="font-size:9px;padding:1px 7px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text3);cursor:pointer;margin-left:auto">Auto Fetch</button>' : '' },
    { label: '📋 Missing Metadata',   count: noMetaGames.length,   filter: 'nometa', action: '' },
    { label: '🔖 No Tags',            count: noTagGames.length,    filter: 'notags', action: '' },
    { label: '📊 No Play Status',     count: noStatusGames.length, filter: 'all',    action: '' },
    { label: '⚠️ Duplicates',         count: dupeGames.length,     filter: 'dupes',  action: '' },
    { label: '⏱ No Playtime (Steam)', count: noTimeGames.length,   filter: 'steam',  action: '' },
  ];

  healthPanel.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">' +
      '<div class="stat-bar-title">Library Health</div>' +
      '<div style="font-family:\'Syne\',sans-serif;font-size:20px;font-weight:900;color:' + scoreColor + '">' + healthScore + '<span style="font-size:11px;font-weight:400;color:var(--text3)">/100</span></div>' +
    '</div>' +
    healthRows.map(function(row) {
      var clickable = row.filter ? 'cursor:pointer' : '';
      var onclick   = row.filter ? 'onclick="setFilter(\'' + row.filter + '\');showPage(\'library\')"' : '';
      var countColor = row.count === 0 ? '#4ade80' : row.count > 50 ? '#f87171' : '#facc15';
      return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);' + clickable + '" ' + onclick + '>' +
        '<div style="font-size:11px;color:var(--text2);flex:1">' + row.label + '</div>' +
        row.action +
        '<div style="font-size:11px;font-weight:700;color:' + countColor + ';flex-shrink:0">' + (row.count === 0 ? '✓' : row.count) + '</div>' +
      '</div>';
    }).join('') +
    '<div style="font-size:10px;color:var(--text3);margin-top:8px">Click any row to filter your library</div>';

  statusEl.appendChild(healthPanel);
  el.appendChild(statusEl);
}


// ── OPENCRITIC ──
async function lookupOpenCritic() {
  if (!currentDetailGame) return;
  var btn = document.getElementById('gameDetailOC');
  var resultEl = document.getElementById('ocResult');
  if (!resultEl) return;

  btn.disabled = true;
  btn.textContent = '⏳ Loading…';
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<span style="font-size:11px;color:var(--text3)">Searching OpenCritic…</span>';

  try {
    // Step 1: search for the game
    var results = await window.nexus.oc.search(currentDetailGame.title);
    if (!results || !results.length) {
      resultEl.innerHTML = '<span style="font-size:11px;color:var(--text3)">No results found on OpenCritic.</span>';
      return;
    }

    // Pick best match by name similarity
    var title = currentDetailGame.title.toLowerCase();
    var best = results.reduce(function(prev, cur) {
      var ps = prev.name ? prev.name.toLowerCase().includes(title) || title.includes(prev.name.toLowerCase()) : false;
      var cs = cur.name  ? cur.name.toLowerCase().includes(title)  || title.includes(cur.name.toLowerCase())  : false;
      if (cs && !ps) return cur;
      return prev;
    }, results[0]);

    // Step 2: fetch full game details
    var game = await window.nexus.oc.game(best.id);
    if (!game) { resultEl.innerHTML = '<span style="font-size:11px;color:var(--text3)">Could not load game details.</span>'; return; }

    // Score tier color
    var score = game.topCriticScore != null ? Math.round(game.topCriticScore) : null;
    var scoreColor = score == null ? '#888'
      : score >= 85 ? '#4ade80'
      : score >= 70 ? '#facc15'
      : '#f87171';
    var tier = game.tier || '';
    var tierLabel = tier === 'Mighty' ? '⚡ Mighty' : tier === 'Strong' ? '💪 Strong' : tier === 'Fair' ? '👍 Fair' : tier === 'Weak' ? '👎 Weak' : '';

    // Percent recommended
    var pct = game.percentRecommended != null ? Math.round(game.percentRecommended) : null;

    // Critics reviewed
    var numReviews = game.numReviews || 0;

    // Platforms
    var platforms = (game.Platforms || []).map(function(p) { return p.name; }).join(', ');

    // First release date
    var releaseDate = '';
    if (game.firstReleaseDate) {
      releaseDate = new Date(game.firstReleaseDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    var ocUrl = 'https://opencritic.com/game/' + game.id + '/' + (game.url || best.id);

    resultEl.innerHTML =
      '<div style="display:flex;align-items:flex-start;gap:14px">' +

        // Score circle
        '<div style="text-align:center;flex-shrink:0">' +
          '<div style="width:56px;height:56px;border-radius:50%;border:3px solid ' + scoreColor + ';display:flex;align-items:center;justify-content:center;flex-direction:column">' +
            '<div style="font-size:18px;font-weight:900;color:' + scoreColor + '">' + (score != null ? score : '—') + '</div>' +
          '</div>' +
          (tierLabel ? '<div style="font-size:9px;color:var(--text3);margin-top:4px;white-space:nowrap">' + tierLabel + '</div>' : '') +
        '</div>' +

        // Info
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:12px;font-weight:700;margin-bottom:6px">' + escHtml(game.name || best.name) + '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:6px">' +
            (pct != null ? '<div style="font-size:11px"><span style="color:var(--text3)">Recommended</span> <strong style="color:#4ade80">' + pct + '%</strong></div>' : '') +
            (numReviews ? '<div style="font-size:11px"><span style="color:var(--text3)">Reviews</span> <strong>' + numReviews + '</strong></div>' : '') +
            (releaseDate ? '<div style="font-size:11px"><span style="color:var(--text3)">Released</span> <strong>' + releaseDate + '</strong></div>' : '') +
          '</div>' +
          (platforms ? '<div style="font-size:10px;color:var(--text3);margin-bottom:6px">' + escHtml(platforms) + '</div>' : '') +
          '<a href="' + escHtml(ocUrl) + '" target="_blank" style="font-size:10px;color:var(--steam);text-decoration:none">View on OpenCritic ↗</a>' +
        '</div>' +

      '</div>';

  } catch(e) {
    resultEl.innerHTML = '<span style="font-size:11px;color:#f87171">Lookup failed: ' + escHtml(e.message) + '</span>';
  } finally {
    btn.disabled = false;
    btn.textContent = '🎯 Critic Score';
  }
}

// ── STEAM STORE PANEL ──
async function lookupSteamStore() {
  if (!currentDetailGame) return;
  var btn = document.getElementById('gameDetailSteamStore');
  var ssEl = document.getElementById('steamStoreResult');
  if (ssEl) { ssEl.style.display = 'none'; ssEl.innerHTML = ''; }

  // Find Steam App ID
  var appId = currentDetailGame.steamAppId || currentDetailGame.appid || null;

  if (!appId) {
    // No Steam App ID — use RAWG
    await lookupRawg(currentDetailGame.title);
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Loading…';

  try {
    var d = await window.nexus.steamStore.get(appId);
    if (!d) {
      btn.disabled = false;
      btn.textContent = '📋 Fetch Game Info';
      await lookupRawg(currentDetailGame.title);
      return;
    }

    // Review summary — use verdict text if available, fall back to count
    var reviewText = '';
    if (d.reviews && d.reviews.review_score_desc) {
      reviewText = d.reviews.review_score_desc;
      if (d.recommendations && d.recommendations.total)
        reviewText += ' (' + d.recommendations.total.toLocaleString() + ' reviews)';
    } else if (d.recommendations && d.recommendations.total) {
      reviewText = d.recommendations.total.toLocaleString() + ' reviews';
    }

    var updates = {
      steamEnriched:      true,
      rawgEnriched:       false,   // clear any stale RAWG data
      description:        d.short_description || '',
      developer:          (d.developers || []).join(', '),
      publisher:          (d.publishers || []).join(', '),
      releaseDate:        d.release_date ? d.release_date.date : '',
      metacriticScore:    d.metacritic ? d.metacritic.score : null,
      steamReviewSummary: reviewText,
      steamTags:          (d.categories || []).slice(0, 8).map(function(c) { return c.description; }),
    };
    // Always save full genres array; only overwrite primary genre if currently unset/generic
    if (d.genres && d.genres.length) {
      var fullGenres = d.genres.map(function(g) { return g.description; }).filter(Boolean);
      var mappedFull = mapSteamGenres(fullGenres);
      updates.genres = mappedFull;
      if (!currentDetailGame.genre || currentDetailGame.genre === 'Other') updates.genre = mappedFull[0];
    }
    // Populate tags field from categories (for picker scoring) — merge with existing
    if (d.categories && d.categories.length) {
      var skipCats = new Set([
        'Steam Achievements', 'Steam Cloud', 'Steam Leaderboards',
        'Steam Trading Cards', 'Steam Workshop', 'Full controller support',
        'Partial Controller Support', 'SteamVR Collectibles', 'Stats',
        'In-App Purchases', 'Includes level editor', 'Downloadable Content',
      ]);
      var catTags = d.categories
        .map(function(c) { return c.description; })
        .filter(function(c) { return c && !skipCats.has(c); })
        .map(function(t) { return t.toLowerCase(); });
      var existingTags = (currentDetailGame.tags || []).filter(function(t) { return t && typeof t === 'string'; });
      updates.tags = [...new Set([...existingTags, ...catTags])];
    }

    var idx = games.findIndex(function(g) { return g.id === currentDetailGame.id; });
    if (idx !== -1) {
      Object.assign(games[idx], updates);
      Object.assign(currentDetailGame, updates);
      window.nexus.games.update(currentDetailGame.id, updates).catch(function(){});
      renderLeftPanel(currentDetailGame);
    }

  } catch(e) {
    showStatus('⚠ Steam fetch failed: ' + e.message, 100);
    setTimeout(hideStatus, 3000);
  } finally {
    btn.disabled = false;
    btn.textContent = '📋 Fetch Game Info';
  }
}

// ── RAWG STORE PANEL ──
async function lookupRawg(title) {
  var btn = document.getElementById('gameDetailSteamStore');
  if (!rawgApiKey) {
    showStatus('⚠ Add a RAWG API key in Settings for non-Steam games', 100);
    setTimeout(hideStatus, 3000);
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Searching RAWG…'; }

  try {
    var results = await window.nexus.rawg.search(title, rawgApiKey);
    if (!results || !results.length) {
      showStatus('No RAWG results for "' + title + '"', 100);
      setTimeout(hideStatus, 3000);
      return;
    }

    var titleLower = title.toLowerCase();
    var best = results.reduce(function(prev, cur) {
      var ps = prev.name && prev.name.toLowerCase() === titleLower;
      var cs = cur.name  && cur.name.toLowerCase()  === titleLower;
      if (cs && !ps) return cur;
      return prev;
    }, results[0]);

    var d = await window.nexus.rawg.game(best.id, rawgApiKey);
    if (!d) throw new Error('Could not load game details');

    var score    = d.metacritic || null;
    var rawgScore = d.rating ? Math.round(d.rating * 20) : null;

    var updates = {
      rawgEnriched:   true,
      steamEnriched:  false,  // clear stale Steam data
      description:    d.description_raw || d.description || '',
      developer:      (d.developers || []).map(function(x){ return x.name; }).join(', '),
      releaseDate:    d.released || '',
      metacriticScore: score || rawgScore || null,
      rawgId:         d.id,
      rawgSlug:       d.slug,
      steamTags:      (d.tags || []).slice(0, 8).map(function(t){ return t.name; }),
    };
    if (currentDetailGame && currentDetailGame.genre === 'Other' && d.genres && d.genres.length)
      updates.genre = d.genres[0].name;

    if (currentDetailGame) {
      var idx = games.findIndex(function(g) { return g.id === currentDetailGame.id; });
      if (idx !== -1) {
        Object.assign(games[idx], updates);
        Object.assign(currentDetailGame, updates);
        window.nexus.games.update(currentDetailGame.id, updates).catch(function(){});
        renderLeftPanel(currentDetailGame);
      }
    }

  } catch(e) {
    showStatus('⚠ RAWG fetch failed: ' + e.message, 100);
    setTimeout(hideStatus, 3000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📋 Fetch Game Info'; }
  }
}
// ── ENRICHED DETAIL PANEL ──
// Shows stored Steam/RAWG data inline in the detail view without needing to click the button.
// Called every time a game detail opens, and again after a Steam/RAWG fetch completes.
function renderDetailEnrichedPanel(game) {
  // Left panel now handles display — just hide the old right-side divs
  var el = document.getElementById('gameDetailEnriched');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  renderLeftPanel(game);
}

function renderLeftPanel(game) {
  var panel = document.getElementById('gameDetailLeftPanel');
  if (!panel) return;

  var hasDesc    = game.description  && game.description.trim().length > 0;
  var hasDev     = game.developer    && game.developer.trim().length > 0;
  var hasPub     = game.publisher    && game.publisher.trim().length > 0;
  var hasRelease = game.releaseDate  && game.releaseDate.trim().length > 0;
  var hasScore   = game.metacriticScore != null && game.metacriticScore > 0;
  var hasTags    = (game.steamTags && game.steamTags.length > 0) || (game.tags && game.tags.length > 0);
  var hasReview  = game.steamReviewSummary && game.steamReviewSummary.trim().length > 0;

  if (!hasDesc && !hasDev && !hasRelease && !hasScore && !hasReview) {
    panel.innerHTML = '';
    return;
  }

  // Metacritic color
  var mcClass = !hasScore ? 'gray'
    : game.metacriticScore >= 80 ? 'green'
    : game.metacriticScore >= 60 ? 'yellow'
    : 'red';

  // Review sentiment color
  var reviewColor = 'var(--text2)';
  if (hasReview) {
    var rv = game.steamReviewSummary.toLowerCase();
    if (rv.includes('overwhelmingly positive') || rv.includes('very positive')) reviewColor = '#4ade80';
    else if (rv.includes('positive') || rv.includes('mostly positive')) reviewColor = '#86efac';
    else if (rv.includes('mixed')) reviewColor = '#facc15';
    else if (rv.includes('negative')) reviewColor = '#f87171';
  }

  var html = '<div class="left-panel-divider"></div>';

  // Description
  if (hasDesc) {
    var desc = game.description.length > 300
      ? game.description.slice(0, 297) + '…'
      : game.description;
    html += '<p class="left-desc">' + escHtml(desc) + '</p>';
    html += '<div class="left-panel-divider"></div>';
  }

  // Metacritic + Review row
  if (hasScore || hasReview) {
    html += '<div style="width:100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
    if (hasScore) {
      html += '<div class="left-mc-badge ' + mcClass + '">' +
        game.metacriticScore +
        '<span style="font-size:9px;font-weight:500;opacity:0.7">MC</span>' +
      '</div>';
    }
    if (hasReview) {
      html += '<div style="font-size:11px;font-weight:600;color:' + reviewColor + '">' +
        escHtml(game.steamReviewSummary) +
      '</div>';
    }
    html += '</div>';
    html += '<div class="left-panel-divider"></div>';
  }

  // Info rows — Release, Developer, Publisher
  var rows = [];
  if (hasRelease) rows.push(['RELEASE DATE', game.releaseDate, false]);
  if (hasDev)     rows.push(['DEVELOPER',    game.developer,  true]);
  if (hasPub && game.publisher !== game.developer)
                  rows.push(['PUBLISHER',    game.publisher,  true]);

  if (rows.length) {
    html += '<div class="left-info-row">';
    rows.forEach(function(r) {
      html += '<div class="left-info-label">' + r[0] + '</div>';
      html += '<div class="left-info-value' + (r[2] ? '' : ' plain') + '">' + escHtml(r[1]) + '</div>';
    });
    html += '</div>';
  }

  // Tags — prefer Steam categories, fall back to user tags
  if (hasTags) {
    var displayTags = (game.steamTags && game.steamTags.length > 0)
      ? game.steamTags.slice(0, 8)
      : game.tags.slice(0, 8);
    html += '<div class="left-panel-divider"></div>';
    html += '<div style="width:100%">';
    html += '<div class="left-info-label" style="margin-bottom:6px">Popular Tags</div>';
    html += '<div class="left-tags-row">';
    displayTags.forEach(function(t) {
      html += '<span class="left-tag">' + escHtml(t) + '</span>';
    });
    html += '</div></div>';
  }

  // View on RAWG link — only for non-Steam games with a saved slug
  if (game.rawgSlug) {
    html += '<div class="left-panel-divider"></div>';
    html += '<a href="https://rawg.io/games/' + encodeURIComponent(game.rawgSlug) + '" target="_blank" class="left-rawg-btn">View full page on RAWG ↗</a>';
  }

  panel.innerHTML = html;
}

// ── CHECK ALL PRICES ──
// ══════════════════════════════════════════════════════
// DEAL BADGE — nav pip showing count of active deals
// ══════════════════════════════════════════════════════
function updateDealBadge() {
  var pip = document.getElementById('navWishPip');
  if (!pip) return;
  var deals = wishlist.filter(function(w) {
    var bestPrice = (w.bestPrice !== null && w.bestPrice !== undefined) ? w.bestPrice : null;
    if (bestPrice === null) return false;
    var hitTarget = w.targetPrice && bestPrice <= w.targetPrice;
    var hitDiscount = w.discountThreshold && w.retailPrice && w.retailPrice > 0 &&
      ((w.retailPrice - bestPrice) / w.retailPrice * 100) >= w.discountThreshold;
    return hitTarget || hitDiscount;
  }).length;
  if (deals > 0) {
    pip.textContent = deals;
    pip.style.display = 'flex';
  } else {
    pip.style.display = 'none';
  }
}

// ══════════════════════════════════════════════════════
// PLATFORM SYNC HEALTH
// ══════════════════════════════════════════════════════
async function renderPlatformSyncHealth() {
  var el = document.getElementById('platformSyncHealth');
  if (!el) return;

  var steamSync  = await window.nexus.store.get('steamLastSync');
  var gogSync    = await window.nexus.store.get('gogLastSync');
  var epicSync   = await window.nexus.store.get('epicLastSync');
  var amazonSync = await window.nexus.store.get('amazonLastSync');

  var steamCount  = games.filter(function(g) { return g.platforms && g.platforms.includes('steam'); }).length;
  var gogCount    = games.filter(function(g) { return g.platforms && g.platforms.includes('gog'); }).length;
  var epicCount   = games.filter(function(g) { return g.platforms && g.platforms.includes('epic'); }).length;
  var amazonCount = games.filter(function(g) { return g.platforms && g.platforms.includes('amazon'); }).length;

  function syncCard(name, icon, lastSync, count, autoSync) {
    var age = lastSync ? Math.floor((Date.now() - new Date(lastSync)) / (1000 * 60 * 60 * 24)) : null;
    var status = !lastSync ? 'Never' : age === 0 ? 'Today' : age === 1 ? 'Yesterday' : age <= 7 ? age + 'd ago' : age <= 30 ? Math.floor(age/7) + 'w ago' : Math.floor(age/30) + 'mo ago';
    var health = !lastSync ? '#6a6a80' : age <= 7 ? '#4ade80' : age <= 30 ? '#facc15' : '#f87171';
    return '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
        '<span style="font-size:15px">' + icon + '</span>' +
        '<span style="font-size:12px;font-weight:700">' + name + '</span>' +
        '<span style="margin-left:auto;font-size:10px;font-weight:700;color:' + health + '">' + status + '</span>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--text3)">' + count + ' games \u00B7 ' + (autoSync ? 'auto-sync' : 'manual import') + '</div>' +
    '</div>';
  }

  var xboxSync     = await window.nexus.store.get('xboxLastSync');
  var gamepassSync = await window.nexus.store.get('gamepassLastSync');
  var xboxCount     = games.filter(function(g) { return g.platforms && g.platforms.includes('xbox'); }).length;
  var gamepassCount = games.filter(function(g) { return g.gpCatalog; }).length;

  el.innerHTML =
    syncCard('Steam',      '\uD83D\uDFE6', steamSync,    steamCount,    true)  +
    syncCard('GOG',        '\uD83C\uDFAE', gogSync,      gogCount,      false) +
    syncCard('Epic',       '\u26AB', epicSync,     epicCount,     false) +
    syncCard('Amazon',     '\uD83D\uDCE6', amazonSync,   amazonCount,   false) +
    syncCard('Xbox',       '\uD83D\uDFE9', xboxSync,     xboxCount,     false) +
    syncCard('Game Pass',  '\u2139', gamepassSync, gamepassCount, false);
}

// ══════════════════════════════════════════════════════
// RAWG BACKGROUND ENRICHMENT (for non-Steam games)
// ══════════════════════════════════════════════════════
async function enrichWithRawgData(gameList) {
  if (!gameList || !gameList.length || !rawgApiKey) return;
  var rawgTotal = gameList.length;
  console.log('[Nexus] RAWG enrichment starting for', rawgTotal, 'games');
  showEnrichProgress('rawg', 0, rawgTotal);
  for (var i = 0; i < gameList.length; i++) {
    var game = gameList[i];
    try {
      var results = await window.nexus.rawg.search(game.title, rawgApiKey);
      if (!results || !results.length) {
        var idx0 = games.findIndex(function(g) { return g.id === game.id; });
        if (idx0 !== -1) { games[idx0].rawgEnriched = true; }
        await window.nexus.games.update(game.id, { rawgEnriched: true });
      } else {
        var titleLower = game.title.toLowerCase();
        var best = results.reduce(function(prev, cur) {
          return (cur.name && cur.name.toLowerCase() === titleLower && !(prev.name && prev.name.toLowerCase() === titleLower)) ? cur : prev;
        }, results[0]);
        var d = await window.nexus.rawg.game(best.id, rawgApiKey);
        if (d) {
          var updates = {
            rawgEnriched: true, rawgId: d.id, rawgSlug: d.slug,
            description: d.description_raw || '',
            developer: (d.developers || []).map(function(x) { return x.name; }).join(', '),
            releaseDate: d.released || '',
            metacriticScore: d.metacritic || null,
          };
          // Always write full genres array — richer than our defaults
          if (d.genres && d.genres.length) {
            updates.genres = d.genres.map(function(g) { return g.name; });
            if (!game.genre || game.genre === 'Other') updates.genre = d.genres[0].name;
          }
          // Save RAWG tags — merge with existing user tags so nothing is lost
          if (d.tags && d.tags.length) {
            var rawgTags = d.tags.slice(0, 12).map(function(t) { return t.name.toLowerCase(); });
            var existingTags = (game.tags || []).filter(function(t) { return t && typeof t === 'string'; });
            updates.tags = [...new Set([...existingTags, ...rawgTags])];
          }
          var idx = games.findIndex(function(g) { return g.id === game.id; });
          if (idx !== -1) { Object.assign(games[idx], updates); }
          await window.nexus.games.update(game.id, updates);
        }
      }









    } catch(e) {
      console.warn('[RAWGEnrich] Failed for', game.title, ':', e.message);
    }
    showEnrichProgress('rawg', i + 1, rawgTotal);
    if (i < gameList.length - 1) await new Promise(function(r) { setTimeout(r, 3000); });
  }
  hideEnrichProgress('rawg');
  console.log('[Nexus] RAWG enrichment complete');
}

async function enrichRawgGamesInBackground() {
  if (!rawgApiKey) return;
  var needsEnrich = games.filter(function(g) {
    return !g.steamAppId && !g.rawgEnriched && !g.steamEnriched;
  });
  if (!needsEnrich.length) return;
  console.log('[Nexus]', needsEnrich.length, 'non-Steam games need RAWG enrichment');
  setTimeout(function() { enrichWithRawgData(needsEnrich); }, 5000);
}

// ── FILL MISSING METADATA (on-demand, for picker quality) ──
async function fillMissingMetadata()      { await _fillMetadata(true,  true,  'fillMetadataBtn'); }
async function fillMissingMetadataSteam() { await _fillMetadata(true,  false, 'fillMetadataSteamBtn'); }
async function fillMissingMetadataRawg()  { await _fillMetadata(false, true,  'fillMetadataRawgBtn'); }

async function _fillMetadata(doSteam, doRawg, btnId) {
  var btn = btnId ? document.getElementById(btnId) : null;
  var fb  = document.getElementById('fillMetadataFeedback');
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }

  var steamTargets = doSteam ? games.filter(function(g) {
    return g.steamAppId; // always re-fetch — old tags may be wrong category-based ones
  }) : [];
  var rawgTargets = doRawg ? games.filter(function(g) {
    return !g.steamAppId; // always re-process — tags may be missing or from old source
  }) : [];

  var total = steamTargets.length + rawgTargets.length;
  if (!total) {
    showStatus('✓ All games already have genres & tags', 100, {type:'success'});
    setTimeout(hideStatus, 3000);
    return;
  }

  showStatus('Filling metadata for ' + total + ' games…', 0);

  // Steam games — process one at a time to respect SteamSpy rate limit (1 req/sec)
  if (steamTargets.length) {
    for (var i = 0; i < steamTargets.length; i++) {
      var sGame = steamTargets[i];
      var pct = Math.round((i / steamTargets.length) * (doRawg ? 50 : 100));
      showStatus('Steam metadata: ' + (i + 1) + '/' + steamTargets.length + ' — ' + sGame.title, pct);
      try {
        var sResults = await window.nexus.games.fetchSteamGenres([sGame.steamAppId]);
        var sResult = sResults[String(sGame.steamAppId)];
        if (!sResult) { console.log('[FillMetadata] Steam Store returned no data for', sGame.title, '(appId ' + sGame.steamAppId + ') — may be DLC, removed, or region-locked'); continue; }
        console.log('[FillMetadata]', sGame.title, '| tags:', sResult.tags);
        var fields = {};
        if (sResult.genres && sResult.genres.length) {
          var mapped = mapSteamGenres(sResult.genres);
          fields.genres = mapped;
          fields.genre  = mapped[0]; // always update primary from Steam — most reliable source
        }
        if (sResult.tags && sResult.tags.length) {
          fields.tags = sResult.tags
            .filter(function(t) { return t && typeof t === 'string'; })
            .map(function(t) { return t.toLowerCase(); });
        }
        if (sResult.metacriticScore) fields.metacriticScore = sResult.metacriticScore;
        if (sResult.description)     fields.description     = sResult.description;
        if (sResult.releaseDate && !sGame.releaseDate) fields.releaseDate = sResult.releaseDate;
        if (sResult.developer   && !sGame.developer)   fields.developer   = sResult.developer;
        if (sResult.publisher   && !sGame.publisher)   fields.publisher   = sResult.publisher;
        if (Object.keys(fields).length) {
          await window.nexus.games.update(sGame.id, fields);
          var gObj = games.find(function(g2) { return g2.id === sGame.id; });
          if (gObj) Object.assign(gObj, fields);
        }
      } catch(e) { console.warn('[FillMetadata] Failed for', sGame.title, ':', e.message); }
    }
  }
  // Non-Steam games — try Steam search first, fall back to RAWG
  if (rawgTargets.length) {
    for (var j = 0; j < rawgTargets.length; j++) {
      var rGame = rawgTargets[j];
      var pct2 = doSteam
        ? Math.round(50 + (j / rawgTargets.length) * 50)
        : Math.round((j / rawgTargets.length) * 100);
      showStatus('Non-Steam metadata: ' + (j + 1) + '/' + rawgTargets.length + ' — ' + rGame.title, pct2);

      var enriched = false;

      // ── ATTEMPT 1: Steam search by name ──
      try {
        var steamMatch = await window.nexus.games.steamSearchByName(rGame.title);
        if (steamMatch && steamMatch.appId) {
          // Found on Steam — fetch genres + SteamSpy tags
          var nsResults = await window.nexus.games.fetchSteamGenres([steamMatch.appId]);
          var nsResult  = nsResults[String(steamMatch.appId)];
          if (nsResult && (nsResult.genres.length || nsResult.tags.length)) {
            var nsFields = { lookedUpSteamAppId: steamMatch.appId };
            if (nsResult.genres && nsResult.genres.length) {
              var nsMapped = mapSteamGenres(nsResult.genres);
              nsFields.genres = nsMapped;
              if (!rGame.genre || rGame.genre === 'Other') nsFields.genre = nsMapped[0];
            }
            if (nsResult.tags && nsResult.tags.length) {
              nsFields.tags = nsResult.tags
                .filter(function(t) { return t && typeof t === 'string'; })
                .map(function(t) { return t.toLowerCase(); });
            }
            if (nsResult.metacriticScore) nsFields.metacriticScore = nsResult.metacriticScore;
            if (nsResult.description && !rGame.description) nsFields.description = nsResult.description;
            if (nsResult.releaseDate  && !rGame.releaseDate) nsFields.releaseDate  = nsResult.releaseDate;
            if (nsResult.developer    && !rGame.developer)   nsFields.developer    = nsResult.developer;
            if (nsResult.publisher    && !rGame.publisher)   nsFields.publisher    = nsResult.publisher;
            await window.nexus.games.update(rGame.id, nsFields);
            var nsObj = games.find(function(g2) { return g2.id === rGame.id; });
            if (nsObj) Object.assign(nsObj, nsFields);
            enriched = true;
            console.log('[FillMetadata] Steam match for "' + rGame.title + '" -> appId ' + steamMatch.appId + ' | tags:', nsResult.tags);
          }
        }
      } catch(e) {
        console.warn('[FillMetadata] Steam search failed for "' + rGame.title + '":', e.message);
      }

      // ── ATTEMPT 2: RAWG fallback ──
      if (!enriched && rawgApiKey) {
        try {
          var rResults = await window.nexus.rawg.search(rGame.title, rawgApiKey);
          if (rResults && rResults.length) {
            var rBest = rResults[0];
            var rD    = await window.nexus.rawg.game(rBest.id, rawgApiKey);
            if (rD) {
              var rFields = { rawgEnriched: true };
              if (rD.genres && rD.genres.length) {
                rFields.genres = rD.genres.map(function(g) { return g.name; });
                if (!rGame.genre || rGame.genre === 'Other') rFields.genre = rD.genres[0].name;
              }
              if (rD.tags && rD.tags.length) {
                rFields.tags = rD.tags.slice(0, 12).map(function(t) { return t.name.toLowerCase(); });
              }
              if (!rGame.description && rD.description_raw) rFields.description = rD.description_raw;
              if (!rGame.metacriticScore && rD.metacritic)  rFields.metacriticScore = rD.metacritic;
              await window.nexus.games.update(rGame.id, rFields);
              var rObj = games.find(function(g2) { return g2.id === rGame.id; });
              if (rObj) Object.assign(rObj, rFields);
              enriched = true;
              console.log('[FillMetadata] RAWG fallback for "' + rGame.title + '" | tags:', rFields.tags);
            }
          }
        } catch(e) { console.warn('[FillMetadata] RAWG failed for "' + rGame.title + '":', e.message); }
        // Throttle RAWG calls
        if (j < rawgTargets.length - 1) await new Promise(function(r) { setTimeout(r, 3000); });
      } else if (!enriched) {
        // Steam search got no match and no RAWG key — throttle anyway for next Steam search
        await new Promise(function(r) { setTimeout(r, 1500); });
      }

      if (!enriched) console.log('[FillMetadata] No source found for "' + rGame.title + '"');
    }

    if (!rawgApiKey && rawgTargets.length) {
      console.log('[FillMetadata] Note: Add a RAWG API key in Settings for better coverage of titles not found on Steam');
    }
  }

  // Restore button and show completion
  if (btn) {
    btn.disabled = false;
    btn.textContent = '✦ Fill Missing Metadata';
  }
  var total2 = steamTargets.length + rawgTargets.length;
  showStatus('✓ Metadata updated for ' + total2 + ' game' + (total2 !== 1 ? 's' : '') + '.', 100, {type:'success'});
  setTimeout(hideStatus, 4000);
  renderAll();
}
async function removeOwnedFromWishlist() {
  var owned = wishlist.filter(function(w) {
    return games.some(function(g) { return normalizeTitle(g.title) === normalizeTitle(w.title); });
  });
  if (!owned.length) {
    alert('No owned games found on your wishlist.');
    return;
  }
  if (!confirm('Remove ' + owned.length + ' owned game' + (owned.length !== 1 ? 's' : '') + ' from your wishlist?\n\n' + owned.map(function(w) { return w.title; }).join('\n'))) return;
  for (var i = 0; i < owned.length; i++) {
    await window.nexus.wishlist.delete(owned[i].id);
    wishlist = wishlist.filter(function(w) { return w.id !== owned[i].id; });
  }
  renderWishlist();
  updateDealBadge();
  showStatus('Removed ' + owned.length + ' owned game' + (owned.length !== 1 ? 's' : '') + ' from wishlist', 100);
  setTimeout(hideStatus, 3000);
}

// ── ENRICHMENT PROGRESS INDICATOR ──
var enrichState = { steam: { done: 0, total: 0 }, rawg: { done: 0, total: 0 } };

function showEnrichProgress(source, done, total) {
  enrichState[source] = { done, total };
  var pip = document.getElementById('enrichPip');
  if (!pip) return;

  var steamActive = enrichState.steam.total > 0 && enrichState.steam.done < enrichState.steam.total;
  var rawgActive  = enrichState.rawg.total  > 0 && enrichState.rawg.done  < enrichState.rawg.total;

  if (!steamActive && !rawgActive) { pip.style.display = 'none'; return; }

  pip.style.display = 'flex';
  var parts = [];
  if (steamActive) parts.push('Steam ' + enrichState.steam.done + '/' + enrichState.steam.total);
  if (rawgActive)  parts.push('RAWG '  + enrichState.rawg.done  + '/' + enrichState.rawg.total);
  pip.querySelector('.enrich-label').textContent = 'Enriching: ' + parts.join(' · ');

  var totalDone  = enrichState.steam.done  + enrichState.rawg.done;
  var totalGames = enrichState.steam.total + enrichState.rawg.total;
  var pct = totalGames > 0 ? Math.round((totalDone / totalGames) * 100) : 0;
  pip.querySelector('.enrich-bar-fill').style.width = pct + '%';
}

function hideEnrichProgress(source) {
  enrichState[source] = { done: enrichState[source].total, total: enrichState[source].total };
  showEnrichProgress(source, enrichState[source].done, enrichState[source].total);
}

// ── WISHLIST IMPORT MATCH NOTIFICATION ──
async function checkWishlistMatchesAfterImport() {
  try {
    var freshWishlist = await window.nexus.wishlist.getAll();
    wishlist = freshWishlist || [];
    var matches = wishlist.filter(function(w) {
      return games.some(function(g) { return normalizeTitle(g.title) === normalizeTitle(w.title); });
    });
    if (!matches.length) return;
    var pip = document.getElementById('navWishPip');
    // Flash the wishlist icon and show a status message
    showStatus('\u2713 ' + matches.length + ' wishlist game' + (matches.length !== 1 ? 's' : '') + ' now in your library — click Wishlist to review', 100);
    setTimeout(hideStatus, 6000);
    if (pip) {
      pip.style.display = 'flex';
      pip.textContent = '!';
      pip.style.background = '#4ade80';
      setTimeout(function() {
        pip.style.background = '#f472b6';
        updateDealBadge();
      }, 4000);
    }
  } catch(e) { /* silent */ }
}

// ════════════════════════════════════════════════════════
// PERSONAL RATING SYSTEM
// ════════════════════════════════════════════════════════
const RATING_LABELS = ['','Terrible','Bad','Below Average','Average','Decent','Good','Great','Excellent','Outstanding','Perfect'];

function renderDetailFeedback(game) {
  var el    = document.getElementById('gameDetailFeedbackArea');
  var addEl = document.getElementById('gameDetailAddFeedback');
  if (!el) return;
  var hasAny = game.reaction || game.shortReview;
  if (!hasAny) {
    el.style.display = 'none';
    if (addEl) addEl.style.display = '';
    return;
  }

  var reactionLabel = { loved: '😍 Loved it', liked: '👍 Pretty good', mixed: '😐 Mixed feelings', disappointed: '😞 Disappointed' };
  el.style.display = '';
  if (addEl) addEl.style.display = 'none';
  el.innerHTML =
    (game.reaction ? '<div style="margin-bottom:6px"><span style="font-size:11px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:3px 10px;color:var(--text2)">' + (reactionLabel[game.reaction]||game.reaction) + '</span></div>' : '') +
    (game.shortReview ? '<div style="font-size:11px;color:var(--text2);font-style:italic;line-height:1.5">"' + escHtml(game.shortReview) + '"</div>' : '') +
    '<button onclick="openGameFeedback(currentDetailGame)" style="margin-top:8px;background:none;border:none;color:var(--accent);font-size:10px;cursor:pointer;padding:0">Edit feedback ✎</button>';
}

function renderStarRating(rating) {
  var stars = document.querySelectorAll('.star-btn');
  var label = document.getElementById('ratingLabel');
  var clearBtn = document.getElementById('clearRatingBtn');
  stars.forEach(function(s) {
    var v = parseInt(s.dataset.value);
    s.classList.toggle('active', v <= rating);
    s.classList.toggle('dim', v > rating);
  });
  if (label) label.textContent = rating > 0 ? rating + '/10 — ' + RATING_LABELS[rating] : 'Not rated';
  if (clearBtn) clearBtn.style.display = rating > 0 ? 'block' : 'none';

  // Wire hover + click events (re-applied each open)
  stars.forEach(function(s) {
    s.onmouseenter = function() {
      var v = parseInt(s.dataset.value);
      stars.forEach(function(st) { st.classList.toggle('hovered', parseInt(st.dataset.value) <= v); });
      if (label) label.textContent = v + '/10 — ' + RATING_LABELS[v];
    };
    s.onmouseleave = function() {
      stars.forEach(function(st) { st.classList.remove('hovered'); });
      var cur = currentDetailGame ? (currentDetailGame.userRating || 0) : 0;
      if (label) label.textContent = cur > 0 ? cur + '/10 — ' + RATING_LABELS[cur] : 'Not rated';
    };
    s.onclick = async function() {
      var v = parseInt(s.dataset.value);
      if (!currentDetailGame) return;
      // Toggle off if clicking same value
      var newRating = currentDetailGame.userRating === v ? 0 : v;
      currentDetailGame.userRating = newRating;
      var idx = games.findIndex(function(g) { return g.id === currentDetailGame.id; });
      if (idx !== -1) games[idx].userRating = newRating;
      await window.nexus.games.update(currentDetailGame.id, { userRating: newRating });
      renderStarRating(newRating);
      renderAll(); // refresh grid (star might show on card later)
    };
  });
}

async function clearRating() {
  if (!currentDetailGame) return;
  currentDetailGame.userRating = 0;
  var idx = games.findIndex(function(g) { return g.id === currentDetailGame.id; });
  if (idx !== -1) games[idx].userRating = 0;
  await window.nexus.games.update(currentDetailGame.id, { userRating: 0 });
  renderStarRating(0);
}

// ════════════════════════════════════════════════════════
// SESSION TIMER
// ════════════════════════════════════════════════════════
var sessionInterval  = null;
var sessionStartTime = null;
var sessionGameId    = null;

function renderSessionPanel(game) {
  var display  = document.getElementById('sessionTimerDisplay');
  var btn      = document.getElementById('sessionStartBtn');
  var lastDate = document.getElementById('sessionLastPlayedDate');
  if (!display || !btn) return;

  // Show last played date
  if (game.lastPlayedAt) {
    var d = new Date(game.lastPlayedAt);
    var diff = Math.max(0, Math.floor((Date.now() - d) / (1000*60*60*24)));
    lastDate.textContent = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff + ' days ago';
  } else {
    lastDate.textContent = '—';
  }

  // If this game has an active session running
  if (sessionInterval && sessionGameId === game.id) {
    display.classList.add('running');
    btn.textContent = '■ Stop';
    btn.className = 'session-btn stop';
    updateSessionDisplay();
  } else {
    display.textContent = '0:00:00';
    display.classList.remove('running');
    btn.textContent = '▶ Start';
    btn.className = 'session-btn start';
  }
}

function toggleSession() {
  if (sessionInterval && sessionGameId === currentDetailGame.id) {
    stopSessionTimer();
  } else {
    startSessionTimer();
  }
}

function startSessionTimer() {
  if (!currentDetailGame) return;
  if (sessionInterval) stopSessionTimer(); // stop any other running session
  sessionGameId    = currentDetailGame.id;
  sessionStartTime = Date.now();
  var display = document.getElementById('sessionTimerDisplay');
  var btn     = document.getElementById('sessionStartBtn');
  if (display) display.classList.add('running');
  if (btn)     { btn.textContent = '■ Stop'; btn.className = 'session-btn stop'; }
  sessionInterval = setInterval(updateSessionDisplay, 1000);
}

function updateSessionDisplay() {
  var display = document.getElementById('sessionTimerDisplay');
  if (!display || !sessionStartTime) return;
  var elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
  var h = Math.floor(elapsed / 3600);
  var m = Math.floor((elapsed % 3600) / 60);
  var s = elapsed % 60;
  display.textContent = h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
}

async function stopSessionTimer() {
  if (!sessionInterval) return;
  clearInterval(sessionInterval);
  sessionInterval = null;

  if (!sessionStartTime || !sessionGameId) return;
  var elapsed   = Math.floor((Date.now() - sessionStartTime) / 1000); // seconds
  var elapsedHrs = elapsed / 3600;
  var gameId    = sessionGameId;
  sessionStartTime = null;
  sessionGameId    = null;

  if (elapsed < 30) return; // ignore accidental clicks under 30s

  // Find game and update
  var idx = games.findIndex(function(g) { return g.id === gameId; });
  if (idx === -1) return;
  var game = games[idx];

  // Load existing sessions
  var sessions = await window.nexus.store.get('sessions:' + gameId) || [];
  sessions.push({ date: new Date().toISOString(), seconds: elapsed });
  // Keep last 100 sessions per game
  if (sessions.length > 100) sessions = sessions.slice(-100);
  await window.nexus.store.set('sessions:' + gameId, sessions);

  // Update last played and add to playtime
  var newPlaytime = Math.round(((game.playtimeHours || 0) + elapsedHrs) * 10) / 10;
  var updates = {
    lastPlayedAt:  new Date().toISOString(),
    playtimeHours: newPlaytime,
  };
  Object.assign(games[idx], updates);
  await window.nexus.games.update(gameId, updates);

  // Reset display
  var display = document.getElementById('sessionTimerDisplay');
  var btn     = document.getElementById('sessionStartBtn');
  if (display) { display.textContent = '0:00:00'; display.classList.remove('running'); }
  if (btn)     { btn.textContent = '▶ Start'; btn.className = 'session-btn start'; }

  // Update last played label if detail still open for this game
  if (currentDetailGame && currentDetailGame.id === gameId) {
    currentDetailGame.lastPlayedAt  = updates.lastPlayedAt;
    currentDetailGame.playtimeHours = updates.playtimeHours;
    document.getElementById('sessionLastPlayedDate').textContent = 'Today';
    var ptEl = document.getElementById('gameDetailPlaytime');
    if (ptEl) ptEl.textContent = newPlaytime + ' hours played';
  }

  showStatus('Session saved — ' + (elapsed >= 3600
    ? Math.floor(elapsed/3600) + 'h ' + Math.floor((elapsed%3600)/60) + 'm'
    : Math.floor(elapsed/60) + 'm') + ' logged for ' + game.title, 100);
  setTimeout(hideStatus, 4000);
  renderAll();
}

// ════════════════════════════════════════════════════════
// GAMING HABITS PAGE
// ════════════════════════════════════════════════════════
function renderFavoritePlaytime(sessions) {
  var windows = { Morning: 0, Afternoon: 0, Evening: 0, 'Late Night': 0 };
  sessions.forEach(function(s) {
    if (!s.startTime) return;
    var h = new Date(s.startTime).getHours();
    if (h >= 5 && h < 12)  windows['Morning']   += s.seconds || 0;
    else if (h >= 12 && h < 17) windows['Afternoon'] += s.seconds || 0;
    else if (h >= 17 && h < 22) windows['Evening']   += s.seconds || 0;
    else                         windows['Late Night'] += s.seconds || 0;
  });
  var total = Object.values(windows).reduce(function(a,b){return a+b;}, 0) || 1;
  var peak = Object.keys(windows).reduce(function(a,b){ return windows[a] > windows[b] ? a : b; });
  var peakLabel = { Morning: '6am – 11am', Afternoon: '12pm – 4pm', Evening: '5pm – 9pm', 'Late Night': '10pm – 2am' }[peak];
  var max = Math.max.apply(null, Object.values(windows)) || 1;

  var bars = Object.keys(windows).map(function(k) {
    var pct = Math.round((windows[k] / total) * 100);
    var w   = Math.round((windows[k] / max) * 100);
    return '<div class="habits-time-row">' +
      '<div class="habits-time-label">' + k + '</div>' +
      '<div class="habits-time-track"><div class="habits-time-fill" style="width:' + w + '%;opacity:' + (0.4 + (w/100)*0.6).toFixed(2) + '"></div></div>' +
      '<div class="habits-time-val">' + pct + '%</div>' +
    '</div>';
  }).join('');

  return '<div class="habits-panel">' +
    '<div class="habits-panel-title">⏰ Favorite Playtime</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-bottom:14px;line-height:1.5">When you actually sit down to play — based on your session history.</div>' +
    '<div class="habits-time-bars">' + (total > 1 ? bars : '<div style="font-size:11px;color:var(--text3)">No session data yet.</div>') + '</div>' +
    (total > 1 ? '<div class="habits-time-peak"><div class="habits-time-peak-label">Peak Window</div><div class="habits-time-peak-val">' + peakLabel + '</div></div>' : '') +
  '</div>';
}

function renderSessionConsistency(sessions) {
  if (!sessions.length) {
    return '<div class="habits-panel"><div class="habits-panel-title">📈 Session Consistency</div>' +
      '<div style="font-size:11px;color:var(--text3)">No sessions logged yet.</div></div>';
  }

  // Build day map
  var dayMap = {};
  sessions.forEach(function(s) {
    if (!s.startTime) return;
    var d = new Date(s.startTime).toDateString();
    dayMap[d] = (dayMap[d] || 0) + (s.seconds || 0);
  });

  // Streak calculation
  var today = new Date(); today.setHours(0,0,0,0);
  var currentStreak = 0, longestStreak = 0, tempStreak = 0;
  var allDays = [];
  for (var i = 0; i < 365; i++) {
    var d = new Date(today); d.setDate(d.getDate() - i);
    allDays.push(d.toDateString());
  }
  var counting = true;
  allDays.forEach(function(d) {
    if (dayMap[d]) {
      tempStreak++;
      if (counting) currentStreak++;
      longestStreak = Math.max(longestStreak, tempStreak);
    } else {
      counting = false;
      tempStreak = 0;
    }
  });

  // Sessions per week
  var weeks = Math.max(1, Math.ceil(sessions.length / 7));
  var avgPerWeek = (sessions.length / weeks).toFixed(1);

  // Longest gap
  var dates = Object.keys(dayMap).map(function(d){ return new Date(d); }).sort(function(a,b){return a-b;});
  var longestGap = 0;
  for (var i = 1; i < dates.length; i++) {
    var gap = Math.round((dates[i] - dates[i-1]) / (1000*60*60*24));
    longestGap = Math.max(longestGap, gap);
  }

  // 30-day dots
  var dots = '';
  for (var i = 29; i >= 0; i--) {
    var d = new Date(today); d.setDate(d.getDate() - i);
    var secs = dayMap[d.toDateString()] || 0;
    var cls = secs > 3600 ? 'habits-dot-active' : secs > 0 ? 'habits-dot-mid' : 'habits-dot-inactive';
    dots += '<div class="habits-dot ' + cls + '"></div>';
  }

  // Weekend vs weekday insight
  var weSecs = 0, wdSecs = 0, weCnt = 0, wdCnt = 0;
  sessions.forEach(function(s) {
    if (!s.startTime) return;
    var dow = new Date(s.startTime).getDay();
    if (dow === 0 || dow === 6) { weSecs += s.seconds||0; weCnt++; }
    else { wdSecs += s.seconds||0; wdCnt++; }
  });
  var weAvg = weCnt ? Math.round(weSecs/weCnt/60) : 0;
  var wdAvg = wdCnt ? Math.round(wdSecs/wdCnt/60) : 0;
  var insight = weAvg > wdAvg
    ? 'You play most on <strong>weekends</strong> — averaging <strong>' + weAvg + 'm</strong> per session vs <strong>' + wdAvg + 'm</strong> on weekdays.'
    : 'You play most on <strong>weekdays</strong> — averaging <strong>' + wdAvg + 'm</strong> per session vs <strong>' + weAvg + 'm</strong> on weekends.';
  if (longestGap > 0) insight += ' Longest gap: <strong>' + longestGap + ' days</strong>.';

  return '<div class="habits-panel">' +
    '<div class="habits-panel-title">📈 Session Consistency</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-bottom:14px;line-height:1.5">Your play rhythm — streaks, gaps, and weekly patterns.</div>' +
    '<div class="habits-consistency-grid">' +
      '<div class="habits-consistency-stat"><div class="habits-consistency-val" style="color:var(--accent)">' + currentStreak + '</div><div class="habits-consistency-label">Current streak (days)</div></div>' +
      '<div class="habits-consistency-stat"><div class="habits-consistency-val" style="color:#4ade80">' + longestStreak + '</div><div class="habits-consistency-label">Longest streak ever</div></div>' +
      '<div class="habits-consistency-stat"><div class="habits-consistency-val">' + avgPerWeek + '</div><div class="habits-consistency-label">Avg sessions / week</div></div>' +
      '<div class="habits-consistency-stat"><div class="habits-consistency-val" style="color:#f59e0b">' + longestGap + '</div><div class="habits-consistency-label">Longest gap (days)</div></div>' +
    '</div>' +
    '<div class="habits-dots-label">Last 30 days</div>' +
    '<div class="habits-streak-dots">' + dots + '</div>' +
    '<div class="habits-consistency-insight">' + insight + '</div>' +
  '</div>';
}

async function renderHabitsPage() {
  var el = document.getElementById('habitsContent');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">Loading habits…</div>';

  // ── Load sessions ──
  var allSessionData = {};
  try { allSessionData = await window.nexus.store.getByPrefix('sessions:') || {}; } catch(e) {}

  var allSessions = [];
  Object.entries(allSessionData).forEach(function(entry) {
    var gameId = entry[0].replace('sessions:', '');
    var game   = games.find(function(g) { return String(g.id) === String(gameId); });
    if (!game) return; // skip orphaned sessions from deleted/reset games
    (entry[1] || []).forEach(function(s) {
      var secs = Math.max(0, Number(s.seconds) || 0); // clamp negative/NaN
      if (secs === 0) return; // skip zero-length sessions
      allSessions.push({ gameId: gameId, title: game.title, game: game, date: new Date(s.date), seconds: secs });
    });
  });
  allSessions.sort(function(a,b) { return b.date - a.date; });

  // ── Time windows — 30-day rolling comparison ──
  var now           = Date.now();
  var thirtyAgo     = now - 30 * 24*60*60*1000;
  var sixtyAgo      = now - 60 * 24*60*60*1000;
  var fourWeeksAgo  = now - 28 * 24*60*60*1000;

  var thisMonthSessions = allSessions.filter(function(s) { return s.date.getTime() > thirtyAgo; });
  var lastMonthSessions = allSessions.filter(function(s) { return s.date.getTime() > sixtyAgo && s.date.getTime() <= thirtyAgo; });

  var thisMonthSecs = thisMonthSessions.reduce(function(t,s) { return t+s.seconds; }, 0);
  var lastMonthSecs = lastMonthSessions.reduce(function(t,s) { return t+s.seconds; }, 0);

  // ── Overall session stats ──
  var totalSessionSecs = allSessions.reduce(function(t,s) { return t+s.seconds; }, 0);
  var totalSessionHrs  = (totalSessionSecs/3600).toFixed(1);
  var avgSessionMins   = allSessions.length ? Math.round(totalSessionSecs/allSessions.length/60) : 0;
  var longestSession   = allSessions.reduce(function(max,s) { return s.seconds > max.seconds ? s : max; }, {seconds:0,title:''});

  // ── Trend helpers ──
  function trend(current, previous, unit) {
    if (!previous && !current) return '';
    var diff = current - previous;
    if (diff === 0) return '<div style="font-size:9px;color:var(--text3);margin-top:3px">same as last month</div>';
    var arrow = diff > 0 ? '▲' : '▼';
    var color = diff > 0 ? '#4ade80' : '#f87171';
    return '<div style="font-size:9px;color:' + color + ';margin-top:3px">' + arrow + ' ' + Math.abs(diff) + (unit||'') + ' vs last month</div>';
  }
  function trendHrs(currentSecs, previousSecs) {
    var diff = ((currentSecs - previousSecs)/3600).toFixed(1);
    if (parseFloat(diff) === 0) return '<div style="font-size:9px;color:var(--text3);margin-top:3px">same as last month</div>';
    var arrow = parseFloat(diff) > 0 ? '▲' : '▼';
    var color = parseFloat(diff) > 0 ? '#4ade80' : '#f87171';
    return '<div style="font-size:9px;color:' + color + ';margin-top:3px">' + arrow + ' ' + Math.abs(diff) + 'h vs last month</div>';
  }

  // ── Day-of-week data ──
  var dayTotals = [0,0,0,0,0,0,0];
  var dayGames  = [[],[],[],[],[],[],[]];
  var dayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  allSessions.forEach(function(s) {
    var d = s.date.getDay();
    dayTotals[d] += s.seconds;
    dayGames[d].push(s);
  });
  var maxDay = Math.max.apply(null, dayTotals) || 1;
  var peakDayIdx = dayTotals.indexOf(maxDay);

  var dayTopGame = dayGames.map(function(sessions) {
    var byGame = {};
    sessions.forEach(function(s) { byGame[s.title] = (byGame[s.title]||0)+s.seconds; });
    var top = Object.entries(byGame).sort(function(a,b){return b[1]-a[1];})[0];
    return top ? { title: top[0], hrs: (top[1]/3600).toFixed(1) } : null;
  });

  // Evening = sessions between 6pm-midnight
  var eveningSessions = allSessions.filter(function(s) {
    var h = s.date.getHours(); return h >= 18;
  });
  var isNightOwl = allSessions.length > 5 && (eveningSessions.length / allSessions.length) > 0.5;

  // ── Play Style analysis ──
  // Genre by time played vs by library count
  var genreByTime  = {};
  var genreByCount = {};
  games.filter(function(g){ return !g.gpCatalog; }).forEach(function(g) {
    var gList = (g.genres && g.genres.length) ? g.genres : (g.genre ? [g.genre] : []);
    gList.forEach(function(genre) {
      genreByCount[genre] = (genreByCount[genre]||0) + 1;
      genreByTime[genre]  = (genreByTime[genre]||0)  + (g.playtimeHours||0);
    });
  });
  var topByTime  = Object.entries(genreByTime).sort(function(a,b){return b[1]-a[1];})[0];
  var topByCount = Object.entries(genreByCount).sort(function(a,b){return b[1]-a[1];})[0];
  var genreMismatch = topByTime && topByCount && topByTime[0] !== topByCount[0];

  // Session style
  var isShortBurst  = avgSessionMins > 0 && avgSessionMins < 20;
  var isMarathoner  = avgSessionMins >= 60;
  var isMidSession  = avgSessionMins >= 20 && avgSessionMins < 60;

  // Build insight sentences
  var insights = [];
  if (isShortBurst)     insights.push('You play in short bursts — quick sessions under 20 minutes.');
  else if (isMarathoner) insights.push('You are a marathoner — your sessions run over an hour on average.');
  else if (isMidSession) insights.push('You tend toward focused sessions, usually 20–60 minutes.');

  if (isNightOwl) insights.push('Most of your sessions happen in the evening.');
  else if (allSessions.length > 5) insights.push('You play throughout the day, not just in the evening.');

  if (dayTotals[peakDayIdx] > 0) insights.push(dayLabels[peakDayIdx] + ' is your most active gaming day.');

  if (genreMismatch) insights.push('You own a lot of ' + topByCount[0] + ' games but spend most time in ' + topByTime[0] + '.');
  else if (topByTime) insights.push(topByTime[0] + ' gets the most of your time.');

  var playStyleHtml = insights.length
    ? insights.map(function(s) {
        return '<div style="font-size:12px;color:var(--text2);line-height:1.7;display:flex;gap:8px;align-items:flex-start">' +
          '<span style="color:var(--accent);flex-shrink:0">→</span>' + s +
        '</div>';
      }).join('')
    : '<div style="font-size:12px;color:var(--text3)">Log more sessions to see your play style insights.</div>';

  // ── Gaming DNA ──
  var dnaGenres = Object.keys(genreByTime).filter(function(g){ return genreByTime[g] > 0 || genreByCount[g] > 0; });
  var topDnaGenres = dnaGenres.sort(function(a,b){
    return (genreByTime[b]||0) - (genreByTime[a]||0);
  }).slice(0, 6);

  var maxTime  = Math.max.apply(null, topDnaGenres.map(function(g){ return genreByTime[g]||0; })) || 1;
  var maxCount = Math.max.apply(null, topDnaGenres.map(function(g){ return genreByCount[g]||0; })) || 1;
  var dnaColors = ['#7fc8f8','#a78bfa','#f472b6','#fb923c','#4ade80','#facc15'];

  var dnaHtml = topDnaGenres.length ? topDnaGenres.map(function(genre, i) {
    var timePct  = Math.round(((genreByTime[genre]||0) / maxTime)  * 100);
    var countPct = Math.round(((genreByCount[genre]||0) / maxCount) * 100);
    var timeHrs  = (genreByTime[genre]||0).toFixed(0);
    var col = dnaColors[i % dnaColors.length];
    return '<div style="margin-bottom:12px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
        '<span style="font-size:12px;font-weight:600;color:var(--text)">' + escHtml(genre) + '</span>' +
        '<span style="font-size:10px;color:var(--text3)">' + timeHrs + 'h played · ' + (genreByCount[genre]||0) + ' owned</span>' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:3px">' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          '<div style="font-size:9px;color:var(--text3);width:36px;text-align:right">played</div>' +
          '<div style="flex:1;height:5px;background:var(--surface2);border-radius:3px">' +
            '<div style="height:5px;width:' + timePct + '%;background:' + col + ';border-radius:3px;transition:width 0.4s"></div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          '<div style="font-size:9px;color:var(--text3);width:36px;text-align:right">owned</div>' +
          '<div style="flex:1;height:5px;background:var(--surface2);border-radius:3px">' +
            '<div style="height:5px;width:' + countPct + '%;background:' + col + ';opacity:0.35;border-radius:3px;transition:width 0.4s"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('') : '<div style="font-size:11px;color:var(--text3)">Play more games to see your DNA.</div>';

  // ── Recently played ──
  var recentlyPlayed = games
    .filter(function(g) { return g.lastPlayedAt; })
    .sort(function(a,b) { return new Date(b.lastPlayedAt) - new Date(a.lastPlayedAt); })
    .slice(0, 10);

  var recentHtml = recentlyPlayed.length
    ? recentlyPlayed.map(function(g) {
        var cover = coverCache[g.id] || coverCache[String(g.id)];
        var diff  = Math.max(0, Math.floor((now - new Date(g.lastPlayedAt)) / (1000*60*60*24)));
        var when  = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff + 'd ago';
        var stars = g.userRating > 0 ? '<span style="color:#facc15;letter-spacing:-1px">' + '★'.repeat(Math.round(g.userRating/2)) + '</span>' : '';
        var pal   = COVER_PALETTES[(g.pal||0)%COVER_PALETTES.length];
        return '<div class="session-history-row">' +
          (cover ? '<img src="' + cover + '" style="width:34px;height:45px;border-radius:4px;object-fit:cover;flex-shrink:0">'
                 : '<div style="width:34px;height:45px;border-radius:4px;flex-shrink:0;background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')"></div>') +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(g.title) + '</div>' +
            '<div style="font-size:10px;color:var(--text3);margin-top:2px">' + fmtHrs(g.playtimeHours) + 'h total' + (stars ? ' · ' + stars : '') + '</div>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--text3);flex-shrink:0">' + when + '</div>' +
        '</div>';
      }).join('')
    : '<div style="font-size:12px;color:var(--text3);padding:8px 0">No play history yet.</div>';

  // ── Session log ──
  var sessionLogHtml = allSessions.slice(0, 20).map(function(s) {
    var diff  = Math.max(0, Math.floor((now - s.date) / (1000*60*60*24)));
    var when  = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff + 'd ago';
    var dur   = s.seconds >= 3600 ? (s.seconds/3600).toFixed(1)+'h' : Math.round(s.seconds/60)+'m';
    var cover = s.game ? (coverCache[s.game.id] || coverCache[String(s.game.id)]) : null;
    var pal   = s.game ? COVER_PALETTES[(s.game.pal||0)%COVER_PALETTES.length] : COVER_PALETTES[0];
    return '<div class="session-history-row">' +
      (cover ? '<img src="' + cover + '" style="width:28px;height:37px;border-radius:3px;object-fit:cover;flex-shrink:0">'
             : '<div style="width:28px;height:37px;border-radius:3px;flex-shrink:0;background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')"></div>') +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(s.title) + '</div>' +
        '<div style="font-size:10px;color:var(--text3);margin-top:1px">' + s.date.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + '</div>' +
      '</div>' +
      '<div style="font-size:12px;font-weight:700;color:var(--steam);flex-shrink:0">' + dur + '</div>' +
    '</div>';
  }).join('') || '<div style="font-size:12px;color:var(--text3)">No sessions logged yet.</div>';

  // ── Ratings ──
  var ratedGames = games.filter(function(g) { return g.userRating > 0; })
    .sort(function(a,b) { return b.userRating - a.userRating; });
  var avgRating = ratedGames.length
    ? (ratedGames.reduce(function(t,g){ return t+g.userRating; },0)/ratedGames.length).toFixed(1) : null;
  var bothRated  = ratedGames.filter(function(g) { return g.metacriticScore; });
  var ratingDiff = bothRated.map(function(g) {
    return { title:g.title, yours:g.userRating*10, meta:g.metacriticScore, diff:(g.userRating*10)-g.metacriticScore };
  }).sort(function(a,b){ return Math.abs(b.diff)-Math.abs(a.diff); }).slice(0,5);

  var topRatedHtml = ratedGames.slice(0,6).map(function(g) {
    var stars = Math.round(g.userRating/2);
    return '<div class="session-history-row">' +
      '<div style="flex:1;font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(g.title) + '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">' +
        '<span style="color:#facc15;font-size:11px;letter-spacing:-1px">' + '★'.repeat(stars) + '<span style="opacity:0.25">' + '★'.repeat(5-stars) + '</span></span>' +
        '<span style="font-family:\'Syne\',sans-serif;font-size:12px;font-weight:800;color:#facc15">' + g.userRating + '</span>' +
      '</div>' +
    '</div>';
  }).join('');

  var vsMetaHtml = bothRated.length
    ? ratingDiff.map(function(r) {
        var color = r.diff > 15 ? '#4ade80' : r.diff < -15 ? '#f87171' : 'var(--text3)';
        var arrow = r.diff > 0 ? '▲' : r.diff < 0 ? '▼' : '=';
        return '<div class="session-history-row">' +
          '<div style="flex:1;font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(r.title) + '</div>' +
          '<div style="font-size:10px;color:var(--text3);flex-shrink:0;margin-right:6px">' + r.yours + ' vs ' + r.meta + '</div>' +
          '<div style="font-size:11px;font-weight:700;color:' + color + ';flex-shrink:0">' + arrow + Math.abs(r.diff) + '</div>' +
        '</div>';
      }).join('')
    : '<div style="font-size:11px;color:var(--text3);padding:6px 0">Rate games with Metacritic scores to see comparisons.</div>';

  var ratingsHtml = ratedGames.length
    ? '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">' +
        '<div class="habits-panel">' +
          '<div class="habits-panel-title">⭐ Your Top Rated</div>' +
          topRatedHtml +
          (avgRating ? '<div style="font-size:10px;color:var(--text3);margin-top:8px;border-top:1px solid var(--border);padding-top:6px">Avg rating: <strong style="color:#facc15">' + avgRating + ' / 10</strong> across ' + ratedGames.length + ' games</div>' : '') +
        '</div>' +
        '<div class="habits-panel">' +
          '<div class="habits-panel-title">📊 You vs Metacritic</div>' +
          vsMetaHtml +
        '</div>' +
      '</div>'
    : '';

  // ── Cost per hour ──
  var costGames = games.filter(function(g) {
    var w = wishlist.find(function(w) { return normalizeTitle(w.title) === normalizeTitle(g.title); });
    return g.playtimeHours > 0 && w && w.retailPrice;
  }).map(function(g) {
    var w = wishlist.find(function(w) { return normalizeTitle(w.title) === normalizeTitle(g.title); });
    return { title:g.title, cph:(w.retailPrice/g.playtimeHours).toFixed(2), hrs:g.playtimeHours, price:w.retailPrice };
  }).sort(function(a,b){ return a.cph-b.cph; }).slice(0,8);

  var cphHtml = '';
  if (costGames.length) {
    var maxCphInverse = 1 / Math.max(0.01, parseFloat(costGames[0].cph));
    cphHtml = '<div class="habits-panel">' +
      '<div class="habits-panel-title">💰 Best Value — Cost per Hour</div>' +
      '<div style="font-size:10px;color:var(--text3);margin-bottom:10px">Retail price ÷ hours played · lower is better</div>' +
      costGames.map(function(g) {
        var bar = Math.min(100, Math.round((1/Math.max(0.01,parseFloat(g.cph)))/maxCphInverse*100));
        return '<div style="margin-bottom:9px">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:3px">' +
            '<span style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%">' + escHtml(g.title) + '</span>' +
            '<span style="font-size:11px;font-weight:700;color:#4ade80;flex-shrink:0">$' + g.cph + '/hr</span>' +
          '</div>' +
          '<div style="height:3px;background:var(--surface2);border-radius:2px">' +
            '<div style="height:100%;width:' + bar + '%;background:linear-gradient(90deg,#4ade80,#7fc8f8);border-radius:2px"></div>' +
          '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  // ── Day of week chart ──
  var dowHtml = '';
  if (allSessions.length) {
    dowHtml = '<div class="habits-dow-grid">' +
      dayLabels.map(function(d,i) {
        var pct     = dayTotals[i]/maxDay;
        var hrs     = (dayTotals[i]/3600).toFixed(1);
        var barH    = Math.max(3, Math.round(pct*80));
        var opacity = dayTotals[i] > 0 ? (0.3+pct*0.7) : 0.12;
        var topGame = dayTopGame[i];
        var tooltip = dayTotals[i] > 0
          ? hrs + 'h total' + (topGame ? ' · ' + topGame.title.slice(0,18)+(topGame.title.length>18?'…':'') + ' (' + topGame.hrs + 'h)' : '')
          : 'No sessions';
        return '<div class="habits-dow-col">' +
          '<div class="habits-dow-bar-wrap">' +
            '<div class="habits-dow-tooltip">' + escHtml(tooltip) + '</div>' +
            '<div class="habits-dow-bar" style="height:' + barH + 'px;background:var(--steam);opacity:' + opacity.toFixed(2) + '"></div>' +
          '</div>' +
          '<div class="habits-dow-label">' + d + '</div>' +
          '<div class="habits-dow-hrs">' + (dayTotals[i] > 0 ? hrs+'h' : '') + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  // ── SECTION DIVIDER helper ──
  function sectionLabel(text) {
    return '<div style="font-size:9px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:2px;margin:20px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--border)">' + text + '</div>';
  }

  // ── BUILD PAGE ──
  el.innerHTML =

    el.innerHTML =

      // Brand stamp
      '<div class="habits-brand-stamp">' +
        '<img src="assets/bz_logo_circle_clean.svg" class="habits-brand-stamp-logo" alt="Backlog Zero">' +
        '<div class="habits-brand-stamp-name">Backlog Zero</div>' +
        '<div class="habits-brand-stamp-divider"></div>' +
        '<div class="habits-brand-stamp-tagline">B + Z = 0</div>' +
      '</div>' +
      

  // ══ TIER 1: HERO ══
  sectionLabel('Overview') +

    // Stat cards with trend indicators
    '<div class="habits-stat-row" style="margin-bottom:12px">' +
      habitStatTrend(allSessions.length || '—', 'Sessions Logged', '#4a9eed',
        trend(thisMonthSessions.length, lastMonthSessions.length, '')) +
      habitStatTrend(totalSessionHrs+'h', 'Total Session Time', COLOR.success,
        trendHrs(thisMonthSecs, lastMonthSecs)) +
      habitStatTrend(avgSessionMins > 0 ? avgSessionMins+'m' : '—', 'Avg Session', COLOR.backlog, '') +
      habitStatTrend(longestSession.seconds > 0 ? Math.round(longestSession.seconds/60)+'m' : '—', 'Longest Session', '#a78bfa', '') +
    '</div>' +

    // Play Style card
    '<div class="habits-panel" style="margin-bottom:12px">' +
      '<div class="habits-panel-title">🎮 Your Play Style</div>' +
      playStyleHtml +
    '</div>' +

    // ════ TIER 2: BEHAVIOR ════
    sectionLabel('Behavior Patterns') +

    (allSessions.length
      ? '<div class="habits-panel" style="margin-bottom:12px"><div class="habits-panel-title">📅 Play Activity by Day of Week</div>' + dowHtml + '</div>'
      : '') +

    '<div class="habits-pair-grid">' +
      renderFavoritePlaytime(allSessions) +
      renderSessionConsistency(allSessions) +
    '</div>' +

    '<div class="habits-pair-grid">' +
      '<div class="habits-panel"><div class="habits-panel-title">🎮 Recently Played</div>' + recentHtml + '</div>' +
      '<div class="habits-panel"><div class="habits-panel-title">📝 Session Log</div>' + sessionLogHtml + '</div>' +
    '</div>' +

    // ════ TIER 3: INSIGHTS ════
    sectionLabel('Insights') +

    // Gaming DNA
    '<div class="habits-panel" style="margin-bottom:12px">' +
      '<div class="habits-panel-title">🧬 Gaming DNA — What You Play vs What You Own</div>' +
      '<div style="font-size:10px;color:var(--text3);margin-bottom:14px">Solid bar = time played · faded bar = games owned · both scaled to their own max</div>' +
      dnaHtml +
    '</div>' +

    ratingsHtml +
    cphHtml +
    BRAND_FOOTER_HTML;
}


function renderHallOfFame() {
  var el = document.getElementById('goalsHallOfFame');
  if (!el) return;

  // Completed goals — detected live same as goals page does
  var completedGoals = goals.map(function(goal) {
    var game = games.find(function(g) { return g.id === goal.gameId; });
    if (!game) return null;
    var done = (game.playtimeHours || 0) >= goal.targetHours;
    return done ? { goal: goal, game: game } : null;
  }).filter(Boolean);

  // Also grab finished games as mini-achievements
  var finishedGames = games
    .filter(function(g) { return g.status === 'finished' && !g.gpCatalog; })
    .sort(function(a,b) { return new Date(b.lastPlayedAt||0) - new Date(a.lastPlayedAt||0); });

  var goalSection = '';
  if (completedGoals.length) {
    goalSection =
      '<div style="font-size:9px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:2px;margin-bottom:10px">🏆 Goals Reached</div>' +
      completedGoals.map(function(entry) {
        var g = entry.game;
        var goal = entry.goal;
        var cover = coverCache[g.id] || coverCache[String(g.id)];
        var pal   = COVER_PALETTES[(g.pal||0) % COVER_PALETTES.length];
        return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px;position:relative;overflow:hidden">' +
          '<div style="position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,#facc15,#4ade80)"></div>' +
          '<div style="display:flex;gap:10px;align-items:center">' +
            (cover
              ? '<img src="' + cover + '" style="width:40px;height:53px;border-radius:5px;object-fit:cover;flex-shrink:0">'
              : '<div style="width:40px;height:53px;border-radius:5px;flex-shrink:0;background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')"></div>') +
            '<div style="flex:1;min-width:0">' +
              '<div style="font-size:11px;font-weight:700;color:#facc15;margin-bottom:2px">🏆 ' + escHtml(goal.label) + '</div>' +
              '<div style="font-size:10px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(g.title) + '</div>' +
              '<div style="font-size:10px;color:var(--text3);margin-top:3px">' + fmtHrs(g.playtimeHours) + 'h played · target ' + goal.targetHours + 'h</div>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
  }

  var finishedSection = '';
  if (finishedGames.length) {
    finishedSection =
      '<div style="font-size:9px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:2px;margin:' + (completedGoals.length ? '20px' : '0') + ' 0 10px">✓ Finished Games</div>' +
      finishedGames.slice(0, 20).map(function(g) {
        var cover = coverCache[g.id] || coverCache[String(g.id)];
        var pal   = COVER_PALETTES[(g.pal||0) % COVER_PALETTES.length];
        var stars = g.userRating > 0 ? '<span style="color:#facc15;font-size:10px;letter-spacing:-1px">' + '★'.repeat(Math.round(g.userRating/2)) + '</span>' : '';
        var when  = g.lastPlayedAt ? (function(){
          var d = Math.floor((Date.now() - new Date(g.lastPlayedAt)) / (1000*60*60*24));
          return d === 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 30 ? d + 'd ago' : Math.floor(d/30) + 'mo ago';
        })() : '';
        return '<div style="display:flex;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">' +
          (cover
            ? '<img src="' + cover + '" style="width:28px;height:37px;border-radius:3px;object-fit:cover;flex-shrink:0">'
            : '<div style="width:28px;height:37px;border-radius:3px;flex-shrink:0;background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')"></div>') +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:11px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(g.title) + '</div>' +
            '<div style="font-size:10px;color:var(--text3);margin-top:1px;display:flex;align-items:center;gap:4px">' +
              (g.playtimeHours ? fmtHrs(g.playtimeHours) + 'h' : '') +
              (stars ? ' · ' + stars : '') +
            '</div>' +
          '</div>' +
          (when ? '<div style="font-size:9px;color:var(--text3);flex-shrink:0">' + when + '</div>' : '') +
        '</div>';
      }).join('');
  }

  var empty = !completedGoals.length && !finishedGames.length;

  el.innerHTML =
    '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px">' +
      '<div style="font-family:\'Syne\',sans-serif;font-size:13px;font-weight:800;color:var(--text);margin-bottom:16px;display:flex;align-items:center;gap:8px">' +
        '<span>Hall of Fame</span>' +
        '<span style="font-size:10px;font-weight:400;color:var(--text3);background:var(--surface2);padding:2px 8px;border-radius:20px">' + (completedGoals.length + finishedGames.length) + '</span>' +
      '</div>' +
      (empty
        ? '<div style="font-size:11px;color:var(--text3);line-height:1.7">Complete a goal or mark a game as Finished to see it here.</div>'
        : goalSection + finishedSection) +
    '</div>';
}



function habitStat(val, label, color) {
  return '<div class="habits-stat-card">' +
    '<div class="habits-stat-val" style="color:' + color + '">' + val + '</div>' +
    '<div class="habits-stat-label">' + label + '</div>' +
  '</div>';
}

function habitStatTrend(val, label, color, trendHtml) {
  return '<div class="habits-stat-card">' +
    '<div class="habits-stat-val" style="color:' + color + '">' + val + '</div>' +
    '<div class="habits-stat-label">' + label + '</div>' +
    (trendHtml || '') +
  '</div>';
}

function statMini(val, label, color) {
  return '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center">' +
    '<div style="font-family:\'Syne\',sans-serif;font-size:22px;font-weight:900;color:' + color + '">' + val + '</div>' +
    '<div style="font-size:10px;color:var(--text3);margin-top:4px;text-transform:uppercase;letter-spacing:0.5px">' + label + '</div>' +
  '</div>';
}
var IDENTITY_CARD_BG = 'data:image/jpeg;base64,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';
var IDENTITY_LOGO = 'data:image/png;base64,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EREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREBwP8DDDdUVwGIPWMAAAAASUVORK5CYII=';

// ── 5. IDENTITY SYSTEM ────────────────────────────────────────
// This system is responsible for:
// - determining player archetype
// - generating identity report data
// - rendering identity UI + card


var CARD_W = 200, CARD_H = 320, CARD_R = 16;

function rrPath(x,y,w,h,r) {
  return `M${x+r},${y} L${x+w-r},${y} Q${x+w},${y} ${x+w},${y+r} L${x+w},${y+h-r} Q${x+w},${y+h} ${x+w-r},${y+h} L${x+r},${y+h} Q${x},${y+h} ${x},${y+h-r} L${x},${y+r} Q${x},${y} ${x+r},${y} Z`;
}

function cardDiamonds(c) {
  const W=CARD_W,H=CARD_H;
  return `
  <rect x="${W/2-4.5}" y="-4.5" width="9" height="9" rx="1" transform="rotate(45 ${W/2} 0)" fill="#07101e" stroke="${c}" stroke-width="0.7" opacity="0.5"/>
  <rect x="${W/2-2}" y="-2" width="4" height="4" rx="0.5" transform="rotate(45 ${W/2} 0)" fill="${c}" opacity="0.3"/>
  <rect x="${W/2-4.5}" y="${H-4.5}" width="9" height="9" rx="1" transform="rotate(45 ${W/2} ${H})" fill="#07101e" stroke="${c}" stroke-width="0.7" opacity="0.5"/>
  <rect x="${W/2-2}" y="${H-2}" width="4" height="4" rx="0.5" transform="rotate(45 ${W/2} ${H})" fill="${c}" opacity="0.3"/>
  <line x1="${W/2-16}" y1="0.5" x2="${W/2-7}" y2="0.5" stroke="${c}" stroke-width="0.6" opacity="0.35"/>
  <line x1="${W/2+7}" y1="0.5" x2="${W/2+16}" y2="0.5" stroke="${c}" stroke-width="0.6" opacity="0.35"/>
  <line x1="${W/2-16}" y1="${H-0.5}" x2="${W/2-7}" y2="${H-0.5}" stroke="${c}" stroke-width="0.6" opacity="0.35"/>
  <line x1="${W/2+7}" y1="${H-0.5}" x2="${W/2+16}" y2="${H-0.5}" stroke="${c}" stroke-width="0.6" opacity="0.35"/>
  <line x1="0.5" y1="${H/2-16}" x2="0.5" y2="${H/2-7}" stroke="${c}" stroke-width="0.6" opacity="0.3"/>
  <line x1="0.5" y1="${H/2+7}" x2="0.5" y2="${H/2+16}" stroke="${c}" stroke-width="0.6" opacity="0.3"/>
  <line x1="${W-0.5}" y1="${H/2-16}" x2="${W-0.5}" y2="${H/2-7}" stroke="${c}" stroke-width="0.6" opacity="0.3"/>
  <line x1="${W-0.5}" y1="${H/2+7}" x2="${W-0.5}" y2="${H/2+16}" stroke="${c}" stroke-width="0.6" opacity="0.3"/>`;
}

function cardCornerBrackets(c, op) {
  const W=CARD_W,H=CARD_H,R=CARD_R;
  return `
  <path d="M${R+10},1 L${R},1 Q1,1 1,${R} L1,${R+10}" fill="none" stroke="${c}" stroke-width="0.9" opacity="${op}" stroke-linecap="round"/>
  <circle cx="${R}" cy="${R}" r="1.2" fill="${c}" opacity="${op+0.05}"/>
  <path d="M${W-R-10},1 L${W-R},1 Q${W-1},1 ${W-1},${R} L${W-1},${R+10}" fill="none" stroke="${c}" stroke-width="0.9" opacity="${op}" stroke-linecap="round"/>
  <circle cx="${W-R}" cy="${R}" r="1.2" fill="${c}" opacity="${op+0.05}"/>
  <path d="M${R+10},${H-1} L${R},${H-1} Q1,${H-1} 1,${H-R} L1,${H-R-10}" fill="none" stroke="${c}" stroke-width="0.9" opacity="${op}" stroke-linecap="round"/>
  <circle cx="${R}" cy="${H-R}" r="1.2" fill="${c}" opacity="${op+0.05}"/>
  <path d="M${W-R-10},${H-1} L${W-R},${H-1} Q${W-1},${H-1} ${W-1},${H-R} L${W-1},${H-R-10}" fill="none" stroke="${c}" stroke-width="0.9" opacity="${op}" stroke-linecap="round"/>
  <circle cx="${W-R}" cy="${H-R}" r="1.2" fill="${c}" opacity="${op+0.05}"/>`;
}

function cardBorderArchivist(c) {
  const W=CARD_W,H=CARD_H,R=CARD_R;
  let s = `<path d="${rrPath(0.5,0.5,W-1,H-1,R)}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.35"/>
  <path d="${rrPath(5,5,W-10,H-10,R-3)}" fill="none" stroke="${c}" stroke-width="0.4" opacity="0.1"/>`;
  for (let x=R+4; x<W-R-4; x+=6) { const i=Math.round((x-R)/6),th=i%5===0?6:i%2===0?4:2.5; s+=`<line x1="${x}" y1="0" x2="${x}" y2="${th}" stroke="${c}" stroke-width="0.5" opacity="${i%5===0?0.4:0.22}" stroke-linecap="round"/><line x1="${x}" y1="${H}" x2="${x}" y2="${H-th}" stroke="${c}" stroke-width="0.5" opacity="${i%5===0?0.4:0.22}" stroke-linecap="round"/>`; }
  for (let y=R+4; y<H-R-4; y+=8) { const i=Math.round((y-R)/8),tw=i%4===0?6:3; s+=`<line x1="0" y1="${y}" x2="${tw}" y2="${y}" stroke="${c}" stroke-width="0.5" opacity="${i%4===0?0.38:0.18}" stroke-linecap="round"/><line x1="${W}" y1="${y}" x2="${W-tw}" y2="${y}" stroke="${c}" stroke-width="0.5" opacity="${i%4===0?0.38:0.18}" stroke-linecap="round"/>`; }
  [60,100,140,180,220,260].filter(y=>y<H-R).forEach((y,i) => { s+=`<text x="9" y="${y+3}" font-family="Syne,sans-serif" font-size="5" font-weight="800" fill="${c}" opacity="0.2">${i+1}</text>`; });
  [[R,R],[W-R,R],[R,H-R],[W-R,H-R]].forEach(([cx,cy]) => { s+=`<circle cx="${cx}" cy="${cy}" r="3.5" fill="none" stroke="${c}" stroke-width="0.6" opacity="0.38"/><circle cx="${cx}" cy="${cy}" r="1.2" fill="${c}" opacity="0.45"/><line x1="${cx-7}" y1="${cy}" x2="${cx-4}" y2="${cy}" stroke="${c}" stroke-width="0.5" opacity="0.3"/><line x1="${cx+4}" y1="${cy}" x2="${cx+7}" y2="${cy}" stroke="${c}" stroke-width="0.5" opacity="0.3"/><line x1="${cx}" y1="${cy-7}" x2="${cx}" y2="${cy-4}" stroke="${c}" stroke-width="0.5" opacity="0.3"/><line x1="${cx}" y1="${cy+4}" x2="${cx}" y2="${cy+7}" stroke="${c}" stroke-width="0.5" opacity="0.3"/>`; });
  return s + cardDiamonds(c);
}

function cardBorderTerminus(c) {
  const W=CARD_W,H=CARD_H,R=CARD_R,gx1=144,gx2=164;
  return `
  <path d="M${gx2},0.5 L${W-R},0.5 Q${W-0.5},0.5 ${W-0.5},${R} L${W-0.5},${H-R} Q${W-0.5},${H-0.5} ${W-R},${H-0.5} L${R},${H-0.5} Q0.5,${H-0.5} 0.5,${H-R} L0.5,${R} Q0.5,0.5 ${R},0.5 L${gx1},0.5"
    fill="none" stroke="${c}" stroke-width="0.75" opacity="0.38" stroke-linecap="round"/>
  <line x1="${gx1}" y1="0.5" x2="${gx2}" y2="0.5" stroke="${c}" stroke-width="0.5" opacity="0.1" stroke-dasharray="2 3"/>
  <line x1="${gx1}" y1="0" x2="${gx1}" y2="8" stroke="${c}" stroke-width="0.8" opacity="0.6" stroke-linecap="round"/>
  <line x1="${gx2}" y1="0" x2="${gx2}" y2="8" stroke="${c}" stroke-width="0.8" opacity="0.6" stroke-linecap="round"/>
  <path d="${rrPath(5,5,W-10,H-10,R-3)}" fill="none" stroke="${c}" stroke-width="0.4" opacity="0.1"/>
  ${cardCornerBrackets(c,0.45)}${cardDiamonds(c)}`;
}

function cardBorderDevoted(c) {
  const W=CARD_W,H=CARD_H,R=CARD_R;
  let s=`<path d="${rrPath(0.5,0.5,W-1,H-1,R)}" fill="none" stroke="${c}" stroke-width="0.6" opacity="0.22"/>`;
  for (let x=60; x<=140; x+=5) { const dist=Math.abs(x-W/2),op=Math.max(0.05,0.45-dist*0.006),th=Math.max(2,6-dist*0.06); s+=`<line x1="${x}" y1="0" x2="${x}" y2="${th}" stroke="${c}" stroke-width="0.5" opacity="${op.toFixed(2)}" stroke-linecap="round"/>`; }
  [30,170].forEach(x => { s+=`<line x1="${x}" y1="0" x2="${x}" y2="3" stroke="${c}" stroke-width="0.4" opacity="0.12" stroke-linecap="round"/>`; });
  [60,100,140].forEach(x => { s+=`<line x1="${x}" y1="${H}" x2="${x}" y2="${H-3}" stroke="${c}" stroke-width="0.4" opacity="0.12" stroke-linecap="round"/>`; });
  return s + cardCornerBrackets(c,0.35) + cardDiamonds(c);
}

function cardBorderWanderer(c) {
  const W=CARD_W,H=CARD_H,R=CARD_R;
  let s=`<path d="${rrPath(0.5,0.5,W-1,H-1,R)}" fill="none" stroke="${c}" stroke-width="0.6" opacity="0.28"/>`;
  const tp=[22,30,36,50,58,64,82,90,96,112,126,134,148,160,172,178];
  const to=[0.35,0.2,0.18,0.38,0.22,0.15,0.3,0.18,0.25,0.2,0.32,0.15,0.28,0.25,0.18,0.2];
  const th=[4,2.5,2,5,2.5,2,3.5,2,3,2.5,4,2,2.5,3,2,2.5];
  tp.forEach((x,i) => { s+=`<line x1="${x}" y1="0" x2="${x}" y2="${th[i]}" stroke="${c}" stroke-width="0.5" opacity="${to[i]}" stroke-linecap="round"/>`; });
  [28,44,52,68,88,100,116,138,152,164].forEach((x,i) => { s+=`<line x1="${x}" y1="${H}" x2="${x}" y2="${H-[3,2,4,2.5,3,2,3.5,2,2.5,3][i]}" stroke="${c}" stroke-width="0.5" opacity="0.22" stroke-linecap="round"/>`; });
  [28,42,60,68,90,108,124,148,168,192,220,250,280,308].filter(y=>y<H-R).forEach((y,i) => { const tw=i%3===0?5:2.5; s+=`<line x1="0" y1="${y}" x2="${tw}" y2="${y}" stroke="${c}" stroke-width="0.5" opacity="${i%3===0?0.3:0.16}" stroke-linecap="round"/>`; });
  [36,58,78,100,120,144,172,200,230,262,290,312].filter(y=>y<H-R).forEach((y,i) => { const tw=i%4===0?5:2.5; s+=`<line x1="${W}" y1="${y}" x2="${W-tw}" y2="${y}" stroke="${c}" stroke-width="0.5" opacity="${i%4===0?0.3:0.15}" stroke-linecap="round"/>`; });
  s+=`<path d="M${R+10},1 L${R},1 Q1,1 1,${R} L1,${R+10}" fill="none" stroke="${c}" stroke-width="0.9" opacity="0.4" stroke-linecap="round"/>
  <path d="M${W-R-6},1 L${W-R},1 Q${W-1},1 ${W-1},${R} L${W-1},${R+14}" fill="none" stroke="${c}" stroke-width="0.9" opacity="0.38" stroke-linecap="round"/>
  <path d="M${R+14},${H-1} L${R},${H-1} Q1,${H-1} 1,${H-R} L1,${H-R-8}" fill="none" stroke="${c}" stroke-width="0.9" opacity="0.35" stroke-linecap="round"/>
  <path d="M${W-R-10},${H-1} L${W-R},${H-1} Q${W-1},${H-1} ${W-1},${H-R} L${W-1},${H-R-12}" fill="none" stroke="${c}" stroke-width="0.9" opacity="0.42" stroke-linecap="round"/>`;
  return s + cardDiamonds(c);
}

function cardBorderVolatile(c) {
  const W=CARD_W,H=CARD_H,R=CARD_R;
  const segs=[{x1:R,y1:0.5,x2:48,y2:0.5},{x1:58,y1:0.5,x2:82,y2:0.5},{x1:106,y1:0.5,x2:134,y2:0.5},{x1:140,y1:0.5,x2:W-R,y2:0.5},{x1:W-0.5,y1:R,x2:W-0.5,y2:60},{x1:W-0.5,y1:68,x2:W-0.5,y2:110},{x1:W-0.5,y1:124,x2:W-0.5,y2:H-R},{x1:R,y1:H-0.5,x2:62,y2:H-0.5},{x1:74,y1:H-0.5,x2:W-R,y2:H-0.5},{x1:0.5,y1:R,x2:0.5,y2:80},{x1:0.5,y1:92,x2:0.5,y2:140},{x1:0.5,y1:152,x2:0.5,y2:H-R}];
  let s=segs.map(seg=>`<line x1="${seg.x1}" y1="${seg.y1}" x2="${seg.x2}" y2="${seg.y2}" stroke="${c}" stroke-width="0.75" opacity="0.38" stroke-linecap="round"/>`).join('');
  s+=`<path d="M${R},0.5 Q0.5,0.5 0.5,${R}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.38"/>
  <path d="M${W-R},0.5 Q${W-0.5},0.5 ${W-0.5},${R}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.38"/>
  <path d="M0.5,${H-R} Q0.5,${H-0.5} ${R},${H-0.5}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.38"/>
  <path d="M${W-0.5},${H-R} Q${W-0.5},${H-0.5} ${W-R},${H-0.5}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.38"/>`;
  [[82,0],[100,0],[W,80],[W,116],[68,H],[0,92],[0,148]].forEach(([bx,by])=>{
    const isTop=by===0,isBot=by===H,isLeft=bx===0,isRight=bx===W;
    if(isTop) s+=`<line x1="${bx}" y1="0" x2="${bx-3}" y2="-6" stroke="${c}" stroke-width="0.6" opacity="0.35" stroke-linecap="round"/><line x1="${bx}" y1="0" x2="${bx+3}" y2="-6" stroke="${c}" stroke-width="0.6" opacity="0.35" stroke-linecap="round"/>`;
    else if(isBot) s+=`<line x1="${bx}" y1="${H}" x2="${bx-3}" y2="${H+6}" stroke="${c}" stroke-width="0.6" opacity="0.35" stroke-linecap="round"/>`;
    else if(isLeft) s+=`<line x1="0" y1="${by}" x2="-6" y2="${by-3}" stroke="${c}" stroke-width="0.6" opacity="0.3" stroke-linecap="round"/><line x1="0" y1="${by}" x2="-6" y2="${by+3}" stroke="${c}" stroke-width="0.6" opacity="0.3" stroke-linecap="round"/>`;
    else if(isRight) s+=`<line x1="${W}" y1="${by}" x2="${W+6}" y2="${by-3}" stroke="${c}" stroke-width="0.6" opacity="0.3" stroke-linecap="round"/><line x1="${W}" y1="${by}" x2="${W+6}" y2="${by+3}" stroke="${c}" stroke-width="0.6" opacity="0.3" stroke-linecap="round"/>`;
  });
  return s + cardDiamonds(c);
}

function cardBorderOperator(c) {
  const W=CARD_W,H=CARD_H,R=CARD_R,spacing=10;
  let s=`<path d="${rrPath(0.5,0.5,W-1,H-1,R)}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.35"/><path d="${rrPath(5,5,W-10,H-10,R-3)}" fill="none" stroke="${c}" stroke-width="0.4" opacity="0.1"/>`;
  for(let x=R+spacing;x<W-R;x+=spacing){const major=Math.round((x-R)/spacing)%5===0;s+=`<line x1="${x}" y1="0" x2="${x}" y2="${major?6:3}" stroke="${c}" stroke-width="0.5" opacity="${major?0.42:0.22}" stroke-linecap="round"/><line x1="${x}" y1="${H}" x2="${x}" y2="${H-(major?6:3)}" stroke="${c}" stroke-width="0.5" opacity="${major?0.42:0.22}" stroke-linecap="round"/>`;}
  for(let y=R+spacing;y<H-R;y+=spacing){const major=Math.round((y-R)/spacing)%5===0;s+=`<line x1="0" y1="${y}" x2="${major?6:3}" y2="${y}" stroke="${c}" stroke-width="0.5" opacity="${major?0.42:0.22}" stroke-linecap="round"/><line x1="${W}" y1="${y}" x2="${W-(major?6:3)}" y2="${y}" stroke="${c}" stroke-width="0.5" opacity="${major?0.42:0.22}" stroke-linecap="round"/>`;}
  [[R,R],[W-R,R],[R,H-R],[W-R,H-R]].forEach(([cx,cy])=>{s+=`<line x1="${cx-8}" y1="${cy}" x2="${cx+8}" y2="${cy}" stroke="${c}" stroke-width="0.5" opacity="0.28"/><line x1="${cx}" y1="${cy-8}" x2="${cx}" y2="${cy+8}" stroke="${c}" stroke-width="0.5" opacity="0.28"/><circle cx="${cx}" cy="${cy}" r="1.5" fill="${c}" opacity="0.4"/>`;});
  return s + cardDiamonds(c);
}

function cardBorderSovereign(c) {
  const W=CARD_W,H=CARD_H,R=CARD_R;
  let s=`<path d="${rrPath(0.5,0.5,W-1,H-1,R)}" fill="none" stroke="${c}" stroke-width="0.85" opacity="0.42"/><path d="${rrPath(4,4,W-8,H-8,R-3)}" fill="none" stroke="${c}" stroke-width="0.5" opacity="0.18"/><path d="${rrPath(7,7,W-14,H-14,R-5)}" fill="none" stroke="${c}" stroke-width="0.35" opacity="0.08"/>`;
  for(let x=R+5;x<W-R-5;x+=7){const i=Math.round((x-R)/7),th=i%6===0?7:i%3===0?5:i%2===0?3.5:2,op=i%6===0?0.45:i%3===0?0.32:0.2;s+=`<line x1="${x}" y1="0" x2="${x}" y2="${th}" stroke="${c}" stroke-width="${i%6===0?0.7:0.5}" opacity="${op}" stroke-linecap="round"/><line x1="${x}" y1="${H}" x2="${x}" y2="${H-th}" stroke="${c}" stroke-width="${i%6===0?0.7:0.5}" opacity="${op}" stroke-linecap="round"/>`;}
  for(let y=R+5;y<H-R-5;y+=9){const i=Math.round((y-R)/9),tw=i%5===0?7:i%2===0?4:2.5,op=i%5===0?0.4:0.2;s+=`<line x1="0" y1="${y}" x2="${tw}" y2="${y}" stroke="${c}" stroke-width="0.5" opacity="${op}" stroke-linecap="round"/><line x1="${W}" y1="${y}" x2="${W-tw}" y2="${y}" stroke="${c}" stroke-width="0.5" opacity="${op}" stroke-linecap="round"/>`;}
  [[R,R,1],[W-R,R,-1],[R,H-R,1],[W-R,H-R,-1]].forEach(([cx,cy])=>{s+=`<circle cx="${cx}" cy="${cy}" r="5" fill="none" stroke="${c}" stroke-width="0.6" opacity="0.3"/><circle cx="${cx}" cy="${cy}" r="2" fill="none" stroke="${c}" stroke-width="0.5" opacity="0.4"/><circle cx="${cx}" cy="${cy}" r="1" fill="${c}" opacity="0.5"/><line x1="${cx-10}" y1="${cy}" x2="${cx-6}" y2="${cy}" stroke="${c}" stroke-width="0.5" opacity="0.3"/><line x1="${cx+6}" y1="${cy}" x2="${cx+10}" y2="${cy}" stroke="${c}" stroke-width="0.5" opacity="0.3"/><line x1="${cx}" y1="${cy-10}" x2="${cx}" y2="${cy-6}" stroke="${c}" stroke-width="0.5" opacity="0.3"/><line x1="${cx}" y1="${cy+6}" x2="${cx}" y2="${cy+10}" stroke="${c}" stroke-width="0.5" opacity="0.3"/>`;});
  s+=`<rect x="${W/2-5}" y="-5" width="10" height="10" rx="1" transform="rotate(45 ${W/2} 0)" fill="#07101e" stroke="${c}" stroke-width="0.8" opacity="0.55"/>
  <rect x="${W/2-2.5}" y="-2.5" width="5" height="5" rx="0.5" transform="rotate(45 ${W/2} 0)" fill="${c}" opacity="0.35"/>
  <rect x="${W/2-5}" y="${H-5}" width="10" height="10" rx="1" transform="rotate(45 ${W/2} ${H})" fill="#07101e" stroke="${c}" stroke-width="0.8" opacity="0.55"/>
  <rect x="${W/2-2.5}" y="${H-2.5}" width="5" height="5" rx="0.5" transform="rotate(45 ${W/2} ${H})" fill="${c}" opacity="0.35"/>`;
  return s;
}

function cardBorderRedacted(c) {
  const W=CARD_W,H=CARD_H,R=CARD_R;
  const rT=[[38,72],[90,110],[130,158]],rB=[[44,88],[106,140],[158,180]],rL=[[40,80],[120,160],[220,260]],rR=[[60,100],[140,180],[240,280]];
  let s='';
  let tp=[R,...rT.flatMap(([a,b])=>[a,b]),W-R];
  for(let i=0;i<tp.length-1;i+=2){const x1=tp[i],x2=tp[i+1];if(i%4===0)s+=`<line x1="${x1}" y1="0.5" x2="${x2}" y2="0.5" stroke="${c}" stroke-width="0.75" opacity="0.35" stroke-linecap="round"/>`;else s+=`<rect x="${x1}" y="-2" width="${x2-x1}" height="5" rx="1" fill="${c}" opacity="0.35"/>`;}
  let bp=[R,...rB.flatMap(([a,b])=>[a,b]),W-R];
  for(let i=0;i<bp.length-1;i+=2){const x1=bp[i],x2=bp[i+1];if(i%4===0)s+=`<line x1="${x1}" y1="${H-0.5}" x2="${x2}" y2="${H-0.5}" stroke="${c}" stroke-width="0.75" opacity="0.35" stroke-linecap="round"/>`;else s+=`<rect x="${x1}" y="${H-3}" width="${x2-x1}" height="5" rx="1" fill="${c}" opacity="0.28"/>`;}
  let lp=[R,...rL.filter(([a])=>a<H-R).flatMap(([a,b])=>[a,Math.min(b,H-R)]),H-R];
  for(let i=0;i<lp.length-1;i+=2){const y1=lp[i],y2=lp[i+1];if(i%4===0)s+=`<line x1="0.5" y1="${y1}" x2="0.5" y2="${y2}" stroke="${c}" stroke-width="0.75" opacity="0.35" stroke-linecap="round"/>`;else s+=`<rect x="-2" y="${y1}" width="5" height="${y2-y1}" rx="1" fill="${c}" opacity="0.25"/>`;}
  let rp=[R,...rR.filter(([a])=>a<H-R).flatMap(([a,b])=>[a,Math.min(b,H-R)]),H-R];
  for(let i=0;i<rp.length-1;i+=2){const y1=rp[i],y2=rp[i+1];if(i%4===0)s+=`<line x1="${W-0.5}" y1="${y1}" x2="${W-0.5}" y2="${y2}" stroke="${c}" stroke-width="0.75" opacity="0.35" stroke-linecap="round"/>`;else s+=`<rect x="${W-3}" y="${y1}" width="5" height="${y2-y1}" rx="1" fill="${c}" opacity="0.22"/>`;}
  s+=`<path d="M${R},0.5 Q0.5,0.5 0.5,${R}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.35"/>
  <path d="M${W-R},0.5 Q${W-0.5},0.5 ${W-0.5},${R}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.35"/>
  <path d="M0.5,${H-R} Q0.5,${H-0.5} ${R},${H-0.5}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.35"/>
  <path d="M${W-0.5},${H-R} Q${W-0.5},${H-0.5} ${W-R},${H-0.5}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.35"/>`;
  return s + cardDiamonds(c);
}

function cardBorderGhost(c) {
  const W=CARD_W,H=CARD_H,R=CARD_R;
  const tS=[{x1:R,x2:40,op:0.35},{x1:40,x2:60,op:0.12},{x1:60,x2:90,op:0.28},{x1:90,x2:110,op:0.06},{x1:110,x2:140,op:0.22},{x1:140,x2:160,op:0.08},{x1:160,x2:W-R,op:0.3}];
  const bS=[{x1:R,x2:50,op:0.28},{x1:50,x2:72,op:0.08},{x1:72,x2:108,op:0.32},{x1:108,x2:130,op:0.1},{x1:130,x2:160,op:0.25},{x1:160,x2:W-R,op:0.07}];
  const lS=[{y1:R,y2:50,op:0.3},{y1:50,y2:80,op:0.08},{y1:80,y2:130,op:0.25},{y1:130,y2:180,op:0.1},{y1:180,y2:H-R,op:0.28}];
  const rS=[{y1:R,y2:60,op:0.12},{y1:60,y2:100,op:0.32},{y1:100,y2:150,op:0.08},{y1:150,y2:210,op:0.28},{y1:210,y2:H-R,op:0.15}];
  let s='';
  tS.forEach(sg=>s+=`<line x1="${sg.x1}" y1="0.5" x2="${sg.x2}" y2="0.5" stroke="${c}" stroke-width="0.75" opacity="${sg.op}" stroke-linecap="round"/>`);
  bS.forEach(sg=>s+=`<line x1="${sg.x1}" y1="${H-0.5}" x2="${sg.x2}" y2="${H-0.5}" stroke="${c}" stroke-width="0.75" opacity="${sg.op}" stroke-linecap="round"/>`);
  lS.forEach(sg=>s+=`<line x1="0.5" y1="${sg.y1}" x2="0.5" y2="${sg.y2}" stroke="${c}" stroke-width="0.75" opacity="${sg.op}" stroke-linecap="round"/>`);
  rS.forEach(sg=>s+=`<line x1="${W-0.5}" y1="${sg.y1}" x2="${W-0.5}" y2="${sg.y2}" stroke="${c}" stroke-width="0.75" opacity="${sg.op}" stroke-linecap="round"/>`);
  s+=`<path d="M${R},0.5 Q0.5,0.5 0.5,${R}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.22"/>
  <path d="M${W-R},0.5 Q${W-0.5},0.5 ${W-0.5},${R}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.12"/>
  <path d="M0.5,${H-R} Q0.5,${H-0.5} ${R},${H-0.5}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.18"/>
  <path d="M${W-0.5},${H-R} Q${W-0.5},${H-0.5} ${W-R},${H-0.5}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.28"/>`;
  [[R,R],[W-R,R],[R,H-R],[W-R,H-R]].forEach(([cx,cy])=>s+=`<circle cx="${cx}" cy="${cy}" r="1" fill="${c}" opacity="0.15"/>`);
  return s + cardDiamonds(c);
}

function cardBorderReturner(c) {
  const W=CARD_W,H=CARD_H,R=CARD_R;
  const tB=[{x1:R,x2:36,op:0.38},{x1:64,x2:88,op:0.32},{x1:112,x2:140,op:0.38},{x1:164,x2:W-R,op:0.28}];
  const lS=[{y1:R,y2:40,op:0.15},{y1:40,y2:80,op:0.08},{y1:80,y2:120,op:0.22},{y1:120,y2:180,op:0.38},{y1:180,y2:H-R,op:0.5}];
  const rS=[{y1:R,y2:50,op:0.1},{y1:50,y2:90,op:0.18},{y1:90,y2:140,op:0.28},{y1:140,y2:190,op:0.42},{y1:190,y2:H-R,op:0.52}];
  let s='';
  [36,64,88,112,140,164].forEach((x,i)=>{const isClose=i%2===1;s+=`<line x1="${x}" y1="0" x2="${x}" y2="${isClose?10:7}" stroke="${c}" stroke-width="0.8" opacity="${isClose?0.55:0.4}" stroke-linecap="round"/>`;if(isClose)s+=`<path d="M${x-4},8 L${x},4 L${x+4},8" fill="none" stroke="${c}" stroke-width="0.6" opacity="0.35" stroke-linecap="round" stroke-linejoin="round"/>`;});
  tB.forEach(sg=>s+=`<line x1="${sg.x1}" y1="0.5" x2="${sg.x2}" y2="0.5" stroke="${c}" stroke-width="0.75" opacity="${sg.op}" stroke-linecap="round"/>`);
  s+=`<line x1="${R}" y1="${H-0.5}" x2="${W-R}" y2="${H-0.5}" stroke="${c}" stroke-width="0.85" opacity="0.48" stroke-linecap="round"/>`;
  s+=`<line x1="${R+8}" y1="${H-4}" x2="${W-R-8}" y2="${H-4}" stroke="${c}" stroke-width="0.5" opacity="0.18" stroke-linecap="round"/>`;
  lS.forEach(sg=>s+=`<line x1="0.5" y1="${sg.y1}" x2="0.5" y2="${sg.y2}" stroke="${c}" stroke-width="0.75" opacity="${sg.op}" stroke-linecap="round"/>`);
  rS.forEach(sg=>s+=`<line x1="${W-0.5}" y1="${sg.y1}" x2="${W-0.5}" y2="${sg.y2}" stroke="${c}" stroke-width="0.75" opacity="${sg.op}" stroke-linecap="round"/>`);
  s+=`<path d="M${R},0.5 Q0.5,0.5 0.5,${R}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.15"/>
  <path d="M${W-R},0.5 Q${W-0.5},0.5 ${W-0.5},${R}" fill="none" stroke="${c}" stroke-width="0.75" opacity="0.12"/>
  <path d="M0.5,${H-R} Q0.5,${H-0.5} ${R},${H-0.5}" fill="none" stroke="${c}" stroke-width="0.85" opacity="0.5"/>
  <path d="M${W-0.5},${H-R} Q${W-0.5},${H-0.5} ${W-R},${H-0.5}" fill="none" stroke="${c}" stroke-width="0.85" opacity="0.5"/>`;
  [[R,H-R],[W-R,H-R]].forEach(([cx,cy])=>s+=`<circle cx="${cx}" cy="${cy}" r="2.5" fill="none" stroke="${c}" stroke-width="0.6" opacity="0.45"/><circle cx="${cx}" cy="${cy}" r="1" fill="${c}" opacity="0.55"/>`);
  [[R,R],[W-R,R]].forEach(([cx,cy])=>s+=`<circle cx="${cx}" cy="${cy}" r="1" fill="${c}" opacity="0.18"/>`);
  return s + cardDiamonds(c);
}

// Symbol art per archetype
var CARD_SYMBOLS = {
  archivist: c => `<svg viewBox="0 0 200 200" fill="none" width="100%" height="100%">
    <defs><radialGradient id="czag" cx="50%" cy="60%" r="55%"><stop offset="0%" stop-color="${c}" stop-opacity="0.10"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="100" cy="110" rx="80" ry="65" fill="url(#czag)"/>
    <line x1="10" y1="165" x2="190" y2="165" stroke="${c}" stroke-width="0.5" opacity="0.12"/><line x1="10" y1="130" x2="190" y2="130" stroke="${c}" stroke-width="0.5" opacity="0.08"/><line x1="10" y1="95" x2="190" y2="95" stroke="${c}" stroke-width="0.5" opacity="0.06"/>
    <rect x="20" y="140" width="138" height="20" rx="2.5" fill="${c}" opacity="0.92"/><rect x="20" y="140" width="138" height="3" rx="1" fill="rgba(255,255,255,0.12)"/>
    <line x1="44" y1="140" x2="44" y2="160" stroke="rgba(0,0,0,0.35)" stroke-width="1.5"/><line x1="68" y1="140" x2="68" y2="160" stroke="rgba(0,0,0,0.35)" stroke-width="1.5"/><line x1="92" y1="140" x2="92" y2="160" stroke="rgba(0,0,0,0.35)" stroke-width="1.5"/><line x1="116" y1="140" x2="116" y2="160" stroke="rgba(0,0,0,0.35)" stroke-width="1.5"/>
    <rect x="26" y="116" width="122" height="20" rx="2.5" fill="${c}" opacity="0.72"/><rect x="26" y="116" width="122" height="3" rx="1" fill="rgba(255,255,255,0.09)"/>
    <line x1="52" y1="116" x2="52" y2="136" stroke="rgba(0,0,0,0.3)" stroke-width="1.5"/><line x1="78" y1="116" x2="78" y2="136" stroke="rgba(0,0,0,0.3)" stroke-width="1.5"/><line x1="104" y1="116" x2="104" y2="136" stroke="rgba(0,0,0,0.3)" stroke-width="1.5"/>
    <rect x="32" y="92" width="106" height="20" rx="2.5" fill="${c}" opacity="0.52"/><rect x="38" y="68" width="90" height="20" rx="2.5" fill="${c}" opacity="0.34"/><rect x="44" y="44" width="74" height="20" rx="2.5" fill="${c}" opacity="0.18"/><rect x="50" y="22" width="58" height="18" rx="2.5" fill="${c}" opacity="0.1"/>
    <rect x="162" y="145" width="22" height="14" rx="2" fill="${c}" opacity="0.85" transform="rotate(22 173 152)"/>
    <rect x="148" y="14" width="44" height="22" rx="4" fill="rgba(7,16,30,0.85)" stroke="${c}" stroke-width="1" opacity="0.7"/>
    <text x="170" y="29" text-anchor="middle" font-family="Syne,sans-serif" font-size="11" font-weight="800" fill="${c}" opacity="0.9">2,099</text>
  </svg>`,
  terminus: c => `<svg viewBox="0 0 200 200" fill="none" width="100%" height="100%">
    <defs><radialGradient id="cztg" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${c}" stop-opacity="0.10"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="100" cy="100" rx="85" ry="85" fill="url(#cztg)"/>
    <text x="28" y="34" font-family="Instrument Sans,sans-serif" font-size="8" fill="${c}" opacity="0.07" font-style="italic">Hollow Knight</text>
    <text x="116" y="50" font-family="Instrument Sans,sans-serif" font-size="8" fill="${c}" opacity="0.055" font-style="italic">Celeste</text>
    <text x="20" y="172" font-family="Instrument Sans,sans-serif" font-size="8" fill="${c}" opacity="0.065" font-style="italic">Dead Cells</text>
    <text x="116" y="182" font-family="Instrument Sans,sans-serif" font-size="8" fill="${c}" opacity="0.055" font-style="italic">Hades</text>
    <circle cx="100" cy="100" r="80" stroke="${c}" stroke-width="0.75" opacity="0.1"/>
    <circle cx="100" cy="100" r="66" stroke="${c}" stroke-width="1" opacity="0.16" stroke-dasharray="5 4"/>
    <circle cx="100" cy="100" r="52" stroke="${c}" stroke-width="8" stroke-dasharray="296 327" stroke-dashoffset="82" stroke-linecap="round" opacity="0.85"/>
    <circle cx="100" cy="100" r="36" stroke="${c}" stroke-width="0.75" opacity="0.13"/>
    <text x="100" y="93" text-anchor="middle" font-family="Syne,sans-serif" font-size="22" font-weight="800" fill="${c}" opacity="0.88">85%</text>
    <text x="100" y="111" text-anchor="middle" font-family="Syne,sans-serif" font-size="8" font-weight="600" letter-spacing="2" fill="${c}" opacity="0.35">COMPLETE</text>
    <g transform="translate(162,50) rotate(-15)"><circle cx="0" cy="0" r="10" fill="rgba(7,16,30,0.8)" stroke="${c}" stroke-width="1" opacity="0.75"/><path d="M-5 0l3.5 3.5 7.5-7.5" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>
  </svg>`,
  devoted: c => `<svg viewBox="0 0 200 200" fill="none" width="100%" height="100%">
    <defs><radialGradient id="czdg" cx="50%" cy="40%" r="50%"><stop offset="0%" stop-color="${c}" stop-opacity="0.12"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient></defs>
    <g opacity="0.18"><path d="M34 118C34 118 28 110 28 104a6 6 0 0112 0C40 110 34 118 34 118z" fill="${c}"/><line x1="34" y1="118" x2="34" y2="124" stroke="${c}" stroke-width="2"/></g>
    <g opacity="0.12"><path d="M166 98C166 98 160 90 160 84a6 6 0 0112 0C172 90 166 98 166 98z" fill="${c}"/><line x1="166" y1="98" x2="166" y2="104" stroke="${c}" stroke-width="2"/></g>
    <ellipse cx="100" cy="80" rx="60" ry="65" fill="url(#czdg)"/>
    <path d="M100 24C100 24 70 50 70 82a30 30 0 0060 0C130 50 100 24 100 24z" fill="${c}" opacity="0.12"/>
    <path d="M100 36C100 36 76 58 76 82a24 24 0 0048 0C124 58 100 36 100 36z" fill="${c}" opacity="0.28"/>
    <path d="M100 50C100 50 82 68 82 82a18 18 0 0036 0C118 68 100 50 100 50z" fill="${c}" opacity="0.52"/>
    <path d="M100 64C100 64 88 76 88 84a12 12 0 0024 0C112 76 100 64 100 64z" fill="${c}" opacity="0.82"/>
    <path d="M100 74C100 74 94 80 94 86a6 6 0 0012 0C106 80 100 74 100 74z" fill="${c}" opacity="0.96"/>
    <ellipse cx="100" cy="87" rx="4" ry="5" fill="rgba(255,255,255,0.85)"/>
    <rect x="138" y="106" width="52" height="22" rx="4" fill="rgba(7,16,30,0.85)" stroke="${c}" stroke-width="0.75" opacity="0.6"/>
    <text x="164" y="114" text-anchor="middle" font-family="Syne,sans-serif" font-size="6" font-weight="400" letter-spacing="1.5" fill="${c}" opacity="0.4">HOURS</text>
    <text x="164" y="126" text-anchor="middle" font-family="Syne,sans-serif" font-size="11" font-weight="800" fill="${c}" opacity="0.9">728</text>
  </svg>`,
  wanderer: c => `<svg viewBox="0 0 200 200" fill="none" width="100%" height="100%">
    <defs><radialGradient id="czwg" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${c}" stop-opacity="0.10"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient></defs>
    <line x1="0" y1="50" x2="200" y2="50" stroke="${c}" stroke-width="0.5" opacity="0.07"/><line x1="0" y1="100" x2="200" y2="100" stroke="${c}" stroke-width="0.5" opacity="0.07"/><line x1="0" y1="150" x2="200" y2="150" stroke="${c}" stroke-width="0.5" opacity="0.07"/><line x1="50" y1="0" x2="50" y2="200" stroke="${c}" stroke-width="0.5" opacity="0.07"/><line x1="100" y1="0" x2="100" y2="200" stroke="${c}" stroke-width="0.5" opacity="0.07"/><line x1="150" y1="0" x2="150" y2="200" stroke="${c}" stroke-width="0.5" opacity="0.07"/>
    <circle cx="38" cy="32" r="2.5" fill="${c}" opacity="0.35"/><circle cx="162" cy="48" r="2" fill="${c}" opacity="0.28"/><circle cx="56" cy="132" r="2.5" fill="${c}" opacity="0.32"/><circle cx="174" cy="148" r="2" fill="${c}" opacity="0.25"/>
    <path d="M38 32 Q90 18 162 48" stroke="${c}" stroke-width="0.75" stroke-dasharray="2 4" opacity="0.15" fill="none"/>
    <path d="M162 48 Q180 100 174 148" stroke="${c}" stroke-width="0.75" stroke-dasharray="2 4" opacity="0.12" fill="none"/>
    <ellipse cx="100" cy="100" rx="70" ry="68" fill="url(#czwg)"/>
    <circle cx="100" cy="100" r="60" stroke="${c}" stroke-width="0.75" opacity="0.14"/>
    <circle cx="100" cy="100" r="44" stroke="${c}" stroke-width="1" opacity="0.2" stroke-dasharray="4 5"/>
    <polygon points="100,34 104.5,94 100,85 95.5,94" fill="${c}" opacity="0.95"/>
    <polygon points="100,34 102,56 100,52 98,56" fill="rgba(255,255,255,0.3)"/>
    <circle cx="100" cy="100" r="6" fill="${c}" opacity="0.75"/>
    <circle cx="100" cy="100" r="3" fill="rgba(255,255,255,0.7)"/>
    <rect x="10" y="108" width="46" height="22" rx="4" fill="rgba(7,16,30,0.85)" stroke="${c}" stroke-width="0.75" opacity="0.6"/>
    <text x="33" y="116" text-anchor="middle" font-family="Syne,sans-serif" font-size="5.5" font-weight="400" letter-spacing="1" fill="${c}" opacity="0.4">GENRES</text>
    <text x="33" y="128" text-anchor="middle" font-family="Syne,sans-serif" font-size="12" font-weight="800" fill="${c}" opacity="0.9">12+</text>
  </svg>`,
  volatile: c => `<svg viewBox="0 0 200 200" fill="none" width="100%" height="100%">
    <defs><radialGradient id="czvg" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${c}" stop-opacity="0.12"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="100" cy="100" rx="85" ry="80" fill="url(#czvg)"/>
    <path d="M10 104 L40 104 L50 84 L60 124 L70 84 L80 104 L96 104" stroke="${c}" stroke-width="1.2" opacity="0.28" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M112 104 L128 104 L138 92 L148 116 L158 100 L168 104 L190 104" stroke="${c}" stroke-width="1.2" opacity="0.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M116 10L78 90h34l-22 100 68-100H130L116 10z" fill="${c}" opacity="0.9" stroke="${c}" stroke-width="0.75" stroke-linejoin="round"/>
    <path d="M116 10L104 56h18l-8 28 30-42H122L116 10z" fill="rgba(255,255,255,0.18)"/>
  </svg>`,
  operator: c => `<svg viewBox="0 0 200 200" fill="none" width="100%" height="100%">
    <defs><radialGradient id="czog" cx="50%" cy="55%" r="50%"><stop offset="0%" stop-color="${c}" stop-opacity="0.10"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient></defs>
    <rect x="20" y="20" width="160" height="130" rx="2" stroke="${c}" stroke-width="0.5" opacity="0.1" fill="none"/>
    <line x1="52" y1="20" x2="52" y2="150" stroke="${c}" stroke-width="0.5" opacity="0.08"/><line x1="84" y1="20" x2="84" y2="150" stroke="${c}" stroke-width="0.5" opacity="0.08"/><line x1="116" y1="20" x2="116" y2="150" stroke="${c}" stroke-width="0.5" opacity="0.08"/><line x1="148" y1="20" x2="148" y2="150" stroke="${c}" stroke-width="0.5" opacity="0.08"/>
    <line x1="20" y1="52" x2="180" y2="52" stroke="${c}" stroke-width="0.5" opacity="0.08"/><line x1="20" y1="84" x2="180" y2="84" stroke="${c}" stroke-width="0.5" opacity="0.08"/><line x1="20" y1="116" x2="180" y2="116" stroke="${c}" stroke-width="0.5" opacity="0.08"/>
    <ellipse cx="100" cy="100" rx="65" ry="62" fill="url(#czog)"/>
    <rect x="68" y="36" width="14" height="13" rx="1.5" fill="${c}" opacity="0.88"/><rect x="93" y="36" width="14" height="13" rx="1.5" fill="${c}" opacity="0.88"/><rect x="118" y="36" width="14" height="13" rx="1.5" fill="${c}" opacity="0.88"/>
    <rect x="68" y="44" width="64" height="5" rx="1" fill="${c}" opacity="0.55"/>
    <rect x="70" y="49" width="60" height="58" rx="2.5" fill="${c}" opacity="0.62"/>
    <rect x="91" y="61" width="18" height="30" rx="2" fill="rgba(7,16,30,0.75)"/>
    <polygon points="100,56 91,68 109,68" fill="rgba(7,16,30,0.75)"/>
    <rect x="64" y="107" width="72" height="9" rx="2" fill="${c}" opacity="0.72"/><rect x="58" y="116" width="84" height="8" rx="2" fill="${c}" opacity="0.52"/><rect x="62" y="124" width="76" height="6" rx="2.5" fill="${c}" opacity="0.35"/>
    <rect x="118" y="126" width="68" height="22" rx="4" fill="rgba(7,16,30,0.85)" stroke="${c}" stroke-width="0.75" opacity="0.6"/>
    <text x="152" y="134" text-anchor="middle" font-family="Syne,sans-serif" font-size="5.5" font-weight="400" letter-spacing="1" fill="${c}" opacity="0.4">POSITION</text>
    <text x="152" y="146" text-anchor="middle" font-family="Syne,sans-serif" font-size="10" font-weight="800" fill="${c}" opacity="0.9">c4 ♜</text>
  </svg>`,
  sovereign: c => `<svg viewBox="0 0 200 200" fill="none" width="100%" height="100%">
    <defs><radialGradient id="czsg" cx="50%" cy="45%" r="55%"><stop offset="0%" stop-color="${c}" stop-opacity="0.12"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="100" cy="88" rx="72" ry="70" fill="url(#czsg)"/>
    <path d="M52 44 A52 52 0 0 1 148 44" stroke="${c}" stroke-width="1.5" opacity="0.18" fill="none" stroke-linecap="round"/>
    <path d="M44 50 Q26 50 26 68 Q26 84 44 88" stroke="${c}" stroke-width="5" fill="none" stroke-linecap="round" opacity="0.5"/>
    <path d="M156 50 Q174 50 174 68 Q174 84 156 88" stroke="${c}" stroke-width="5" fill="none" stroke-linecap="round" opacity="0.5"/>
    <path d="M44 34 h112 v52 Q156 102 100 106 Q44 102 44 86 Z" fill="${c}" opacity="0.72"/>
    <path d="M44 34 h112 v8 Q112 36 100 36 Q88 36 44 42 Z" fill="rgba(255,255,255,0.14)"/>
    <rect x="42" y="31" width="116" height="8" rx="3" fill="${c}" opacity="0.9"/>
    <text x="100" y="58" text-anchor="middle" font-family="Instrument Sans,sans-serif" font-size="6.5" font-style="italic" fill="rgba(7,16,30,0.6)">Elden Ring</text>
    <text x="100" y="70" text-anchor="middle" font-family="Instrument Sans,sans-serif" font-size="6" font-style="italic" fill="rgba(7,16,30,0.5)">Baldur's Gate 3</text>
    <text x="100" y="81" text-anchor="middle" font-family="Instrument Sans,sans-serif" font-size="5.5" font-style="italic" fill="rgba(7,16,30,0.4)">Disco Elysium</text>
    <path d="M100 42l3 9h9l-7.5 5.5 2.8 9L100 61l-7.3 4.5 2.8-9L88 51h9z" fill="rgba(255,255,255,0.55)"/>
    <rect x="88" y="98" width="24" height="14" rx="2" fill="${c}" opacity="0.55"/>
    <rect x="60" y="112" width="80" height="9" rx="2.5" fill="${c}" opacity="0.78"/><rect x="52" y="121" width="96" height="8" rx="2.5" fill="${c}" opacity="0.58"/><rect x="56" y="129" width="88" height="6" rx="2" fill="${c}" opacity="0.38"/>
    <text x="100" y="136" text-anchor="middle" font-family="Syne,sans-serif" font-size="5.5" font-weight="400" letter-spacing="2" fill="rgba(7,16,30,0.45)">147 COMPLETED</text>
  </svg>`,
  redacted: c => `<svg viewBox="0 0 200 200" fill="none" width="100%" height="100%">
    <defs><radialGradient id="czrg" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${c}" stop-opacity="0.08"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="100" cy="100" rx="72" ry="68" fill="url(#czrg)"/>
    <rect x="28" y="16" width="144" height="168" rx="5" stroke="${c}" stroke-width="1" opacity="0.2" fill="none"/>
    <rect x="36" y="26" width="100" height="8" rx="1.5" fill="${c}" opacity="0.35"/>
    <text x="86" y="33" text-anchor="middle" font-family="Syne,sans-serif" font-size="7" font-weight="400" letter-spacing="2" fill="rgba(7,16,30,0.6)">DOSSIER</text>
    <rect x="36" y="46" width="128" height="13" rx="2.5" fill="${c}" opacity="0.68"/><rect x="36" y="63" width="106" height="13" rx="2.5" fill="${c}" opacity="0.5"/><rect x="36" y="80" width="118" height="13" rx="2.5" fill="${c}" opacity="0.35"/><rect x="36" y="97" width="88" height="13" rx="2.5" fill="${c}" opacity="0.22"/>
    <rect x="38" y="48" width="22" height="9" rx="1.5" fill="rgba(6,12,22,0.65)"/><rect x="64" y="48" width="36" height="9" rx="1.5" fill="rgba(6,12,22,0.65)"/><rect x="108" y="48" width="52" height="9" rx="1.5" fill="rgba(6,12,22,0.65)"/>
    <rect x="42" y="84" width="116" height="32" rx="3" stroke="${c}" stroke-width="2.5" fill="rgba(6,12,22,0.15)" opacity="0.5" transform="rotate(-8 100 100)"/>
    <text x="100" y="102" text-anchor="middle" font-family="Syne,sans-serif" font-size="13" font-weight="800" letter-spacing="5" fill="${c}" opacity="0.6" transform="rotate(-8 100 100)">CLASSIFIED</text>
    <rect x="44" y="138" width="112" height="24" rx="3" fill="rgba(6,12,22,0.7)" stroke="${c}" stroke-width="1" opacity="0.5"/>
    <text x="100" y="146" text-anchor="middle" font-family="Syne,sans-serif" font-size="6" font-weight="400" letter-spacing="2" fill="${c}" opacity="0.38">CLEARANCE REQUIRED</text>
    <text x="100" y="158" text-anchor="middle" font-family="Syne,sans-serif" font-size="10" font-weight="800" letter-spacing="3" fill="${c}" opacity="0.6">ACCESS DENIED</text>
  </svg>`,
  ghost: c => `<svg viewBox="0 0 200 200" fill="none" width="100%" height="100%">
    <defs><radialGradient id="czghg" cx="50%" cy="45%" r="55%"><stop offset="0%" stop-color="${c}" stop-opacity="0.08"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="100" cy="90" rx="75" ry="70" fill="url(#czghg)"/>
    <rect x="36" y="50" width="128" height="104" rx="4" stroke="${c}" stroke-width="0.75" opacity="0.14" fill="none"/>
    <rect x="36" y="50" width="128" height="18" rx="4" fill="${c}" opacity="0.1"/>
    <circle cx="48" cy="59" r="3.5" fill="${c}" opacity="0.2"/><circle cx="60" cy="59" r="3.5" fill="${c}" opacity="0.15"/><circle cx="72" cy="59" r="3.5" fill="${c}" opacity="0.1"/>
    <rect x="44" y="76" width="80" height="6" rx="1.5" fill="${c}" opacity="0.2"/><rect x="44" y="88" width="56" height="6" rx="1.5" fill="${c}" opacity="0.15"/><rect x="44" y="100" width="68" height="6" rx="1.5" fill="${c}" opacity="0.1"/><rect x="44" y="112" width="44" height="6" rx="1.5" fill="${c}" opacity="0.07"/><rect x="44" y="124" width="60" height="6" rx="1.5" fill="${c}" opacity="0.05"/>
    <rect x="100" y="74" width="54" height="46" rx="3" stroke="${c}" stroke-width="0.6" opacity="0.18" fill="rgba(7,16,30,0.4)"/>
    <rect x="106" y="80" width="30" height="6" rx="1" fill="${c}" opacity="0.12"/><rect x="106" y="94" width="22" height="5" rx="1" fill="${c}" opacity="0.08"/>
    <text x="100" y="148" text-anchor="middle" font-family="Syne,sans-serif" font-size="7" font-weight="400" letter-spacing="3" fill="${c}" opacity="0.2">INACTIVE</text>
    <line x1="44" y1="144" x2="80" y2="144" stroke="${c}" stroke-width="0.5" opacity="0.15"/><line x1="120" y1="144" x2="156" y2="144" stroke="${c}" stroke-width="0.5" opacity="0.15"/>
  </svg>`,
  returner: c => `<svg viewBox="0 0 200 200" fill="none" width="100%" height="100%">
    <defs><radialGradient id="czrtg" cx="50%" cy="60%" r="55%"><stop offset="0%" stop-color="${c}" stop-opacity="0.12"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="100" cy="115" rx="78" ry="65" fill="url(#czrtg)"/>
    <rect x="36" y="50" width="12" height="12" rx="1.5" fill="${c}" opacity="0.08"/><rect x="52" y="50" width="12" height="12" rx="1.5" fill="${c}" opacity="0.08"/><rect x="68" y="50" width="12" height="12" rx="1.5" fill="${c}" opacity="0.08"/><rect x="84" y="50" width="12" height="12" rx="1.5" fill="${c}" opacity="0.08"/><rect x="100" y="50" width="12" height="12" rx="1.5" fill="${c}" opacity="0.08"/><rect x="116" y="50" width="12" height="12" rx="1.5" fill="${c}" opacity="0.08"/><rect x="132" y="50" width="12" height="12" rx="1.5" fill="${c}" opacity="0.08"/>
    <rect x="36" y="76" width="12" height="12" rx="1.5" fill="${c}" opacity="0.05"/><rect x="52" y="76" width="12" height="12" rx="1.5" fill="${c}" opacity="0.05"/><rect x="68" y="76" width="12" height="12" rx="1.5" fill="${c}" opacity="0.2"/><rect x="84" y="76" width="12" height="12" rx="1.5" fill="${c}" opacity="0.5"/><rect x="100" y="76" width="12" height="12" rx="1.5" fill="${c}" opacity="0.75"/><rect x="116" y="76" width="12" height="12" rx="1.5" fill="${c}" opacity="0.88"/><rect x="132" y="76" width="12" height="12" rx="1.5" fill="${c}" opacity="0.92"/>
    <path d="M58 122 L100 108 L142 122" stroke="${c}" stroke-width="1" opacity="0.2" fill="none" stroke-linecap="round"/>
    <path d="M68 138 L100 120 L132 138" stroke="${c}" stroke-width="1.2" opacity="0.35" fill="none" stroke-linecap="round"/>
    <path d="M80 156 L100 140 L120 156" stroke="${c}" stroke-width="1.5" opacity="0.55" fill="none" stroke-linecap="round"/>
    <circle cx="100" cy="140" r="4" fill="${c}" opacity="0.9"/>
    <circle cx="100" cy="140" r="2" fill="rgba(255,255,255,0.7)"/>
    <rect x="140" y="130" width="22" height="14" rx="2" fill="rgba(7,16,30,0.85)" stroke="${c}" stroke-width="0.75" opacity="0.6"/>
    <text x="151" y="138" text-anchor="middle" font-family="Syne,sans-serif" font-size="5.5" font-weight="600" letter-spacing="0.5" fill="${c}" opacity="0.75">DAY 1</text>
  </svg>`
};

var CARD_BORDERS = {
  archivist: cardBorderArchivist,
  terminus: cardBorderTerminus,
  devoted: cardBorderDevoted,
  wanderer: cardBorderWanderer,
  volatile: cardBorderVolatile,
  operator: cardBorderOperator,
  sovereign: cardBorderSovereign,
  redacted: cardBorderRedacted,
  ghost: cardBorderGhost,
  returner: cardBorderReturner
};

var CARD_NUMS = {
  archivist:'I', terminus:'II', devoted:'III', wanderer:'IV',
  volatile:'V', operator:'VI', sovereign:'VII', redacted:'—',
  ghost:'IX', returner:'X'
};

// ── 5.1 Archetype Definitions ─────────────────────────────────
// Static definitions for each archetype:
// - title
// - color
// - background
// - description generator
// - evidence generator

var IDENTITY_ARCHETYPES = {
  archivist: {
    title: 'The Archivist', color: '#e8900a',
    bg: 'linear-gradient(150deg,#1a0a00 0%,#2a1200 50%,#1a0a00 100%)',
    glow: 'rgba(232,144,10,0.18)', img: '',
    flavor: 'Collects more than they play',
    desc: function(d) {
      return 'You added <strong>' + d.added + ' games</strong> this month and logged only <strong>' + d.hrs + 'h</strong> of play. The library is the project. Every acquisition is deliberate — a record of what deserves to exist in your collection.';
    },
    fullDesc: function(d) {
      return '<p>You added <strong>' + d.added + ' games</strong> this month and played almost none of them. That is not neglect — it is curation. The backlog is not a source of guilt for you. It is an archive. A record of intention. Every title you added was a decision, and the collection itself is the output.</p>' +
             '<p>Your library currently sits at <strong>' + d.backlog + ' unplayed games</strong>. Most people would call that a problem. You understand it differently. The act of acquiring is part of the experience — the research, the wishlist, the moment of purchase. Playing is just one way to engage with a game. Owning it is another.</p>';
    },
    evidence: function(d) {
      return [
        'Added ' + d.added + ' games this month',
        d.completed > 0 ? 'Completed ' + d.completed + ' titles during the same period' : 'Completion remained limited during the same period',
        d.topGenre ? 'Collection leaned toward ' + d.topGenre + ' with ' + d.topGenreCount + ' additions' : null,
        'Backlog now sits at ' + d.backlog + ' games'
      ].filter(Boolean);
    },
    seal: 'The collection continues.'
  },

  terminus: {
    title: 'The Terminus', color: '#1abc9c',
    bg: 'linear-gradient(150deg,#001a14 0%,#002a1e 50%,#001a14 100%)',
    glow: 'rgba(26,188,156,0.18)', img: '',
    flavor: 'Always sees it through',
    desc: function(d) {
      return 'You finished <strong>' + d.completed + ' games</strong> this month. Where others accumulate starts, you close loops — steadily turning play sessions into completed runs.';
    },
    fullDesc: function(d) {
      return '<p>You finished <strong>' + d.completed + ' games</strong> this month. That is not a small thing. Most libraries are full of games that were started, enjoyed for a few hours, and quietly abandoned. You do not leave things that way. When you commit to something, it gets finished.</p>' +
             '<p>There is a particular kind of satisfaction in completion that casual players rarely experience — the full arc, the ending, the credits. You have logged <strong>' + d.hrs + ' hours</strong> this month in pursuit of that feeling. The backlog does not intimidate you. It is a queue, and you are working through it.</p>';
    },
    evidence: function(d) {
      return [
        'Completed ' + d.completed + ' games this month',
        d.hrs > 0 ? 'Logged ' + d.hrs + 'h of total playtime' : null,
        d.topGame ? 'Most time was spent on ' + d.topGame : null
      ].filter(Boolean);
    },
    seal: 'Another loop closed.'
  },

  devoted: {
    title: 'The Devoted', color: '#4da3ff',
    bg: 'linear-gradient(150deg,#001428 0%,#001e3c 50%,#001428 100%)',
    glow: 'rgba(77,163,255,0.18)', img: '',
    flavor: 'Depth over breadth',
    desc: function(d) {
      return (d.topGame ? '<strong>' + d.topGame + '</strong>' : 'One game') + ' held <strong>' + d.topGamePct + '%</strong> of your attention this month. You did not scatter. You returned, session after session, to the same flame.';
    },
    fullDesc: function(d) {
      return '<p>' + (d.topGame ? '<strong>' + d.topGame + '</strong>' : 'One game') + ' consumed <strong>' + d.topGamePct + '%</strong> of your playtime this month — <strong>' + d.topGameHrs + ' hours</strong> given to a single title while everything else waited. That kind of focus is rare. Most players drift. You settled.</p>' +
             '<p>There is something the devoted understand that others miss — a game does not reveal itself in the first few hours. The systems, the rhythms, the moments that stay with you long after you put the controller down — those come from time. You gave it time. That is not obsession. That is respect for the craft of the thing.</p>';
    },
    evidence: function(d) {
      return [
        d.topGame ? d.topGame + ' accounted for ' + d.topGamePct + '% of total playtime' : null,
        d.topGameHrs + 'h logged in your primary title',
        d.sessions + ' sessions recorded this month'
      ].filter(Boolean);
    },
    seal: 'The flame is still burning.'
  },

  wanderer: {
    title: 'The Wanderer', color: '#a855f7',
    bg: 'linear-gradient(150deg,#100828 0%,#180d38 50%,#100828 100%)',
    glow: 'rgba(168,85,247,0.16)', img: '',
    flavor: 'Never stays in one place',
    desc: function(d) {
      return 'You moved through <strong>' + d.genres + ' different genres</strong> this month. No single territory held you for long. You play to discover — each session a new coordinate on an ever-expanding map.';
    },
    fullDesc: function(d) {
      return '<p>You touched <strong>' + d.genres + ' different genres</strong> this month across <strong>' + d.gamesPlayed + ' games</strong>. No single title dominated. No single style defined the period. You moved through the library the way some people move through a city — with curiosity, without a fixed destination, finding things worth stopping for along the way.</p>' +
             '<p>The wanderer is not unfocused. The wanderer is deliberately broad. You are building a map of what games can be — what they feel like across genres, across tones, across scales. ' + (d.topGenre ? 'This month leaned toward <strong>' + d.topGenre + '</strong>, but even that was just one stop among many.' : 'No single genre claimed you for long.') + ' That breadth is the point.</p>';
    },
    evidence: function(d) {
      return [
        d.genres + ' unique genres appeared in recent play',
        d.sessions + ' sessions spread across ' + d.gamesPlayed + ' games',
        d.topGenre ? 'Activity leaned most toward ' + d.topGenre : null
      ].filter(Boolean);
    },
    seal: 'The map is still expanding.'
  },

  volatile: {
    title: 'The Volatile', color: '#facc15',
    bg: 'linear-gradient(150deg,#1a1400 0%,#2a2000 50%,#1a1400 100%)',
    glow: 'rgba(250,204,21,0.18)', img: '',
    flavor: 'Plays in bursts',
    desc: function(d) {
      return 'Your average session ran <strong>' + d.avgMins + ' minutes</strong>. You hit fast, you exit clean, and you keep coming back. The habit lives not in long sittings but in the frequency of the spark.';
    },
    fullDesc: function(d) {
      return '<p>Your sessions averaged <strong>' + d.avgMins + ' minutes</strong> this month across <strong>' + d.sessions + ' separate entries</strong>. Short, sharp, consistent. You do not need a three-hour block to engage with a game — you need fifteen minutes and the right moment. That discipline is harder than it looks.</p>' +
             '<p>The volatile pattern is not restlessness. It is efficiency. You have found a way to keep gaming present in your life without it consuming the whole of it. ' + (d.topGame ? '<strong>' + d.topGame + '</strong> was your most frequent return point — the game you came back to when the window opened.' : 'You return to whatever fits the moment.') + ' The sessions are short. The habit is not.</p>';
    },
    evidence: function(d) {
      return [
        d.sessions + ' sessions averaged ' + d.avgMins + ' minutes each',
        d.hrs + 'h total playtime logged this month',
        d.topGame ? 'Most frequent return point: ' + d.topGame : null
      ].filter(Boolean);
    },
    seal: 'The spark is still firing.'
  },

  operator: {
    title: 'The Operator', color: '#94a3b8',
    bg: 'linear-gradient(150deg,#0a0e18 0%,#121828 50%,#0a0e18 100%)',
    glow: 'rgba(148,163,184,0.14)', img: '',
    flavor: 'Thinks before they move',
    desc: function(d) {
      return '<strong>' + Math.round(d.stratPct) + '%</strong> of your playtime this month went to strategy and simulation. You are not here for spectacle. You are here for systems — the ones that reward patience, planning, and precision.';
    },
    fullDesc: function(d) {
      return '<p><strong>' + Math.round(d.stratPct) + '%</strong> of your playtime this month went to strategy and simulation. You are drawn to games that ask something of you before they give anything back — games where the first hour is spent learning and the twentieth hour is spent executing. ' + (d.topGame ? '<strong>' + d.topGame + '</strong> held most of your attention.' : 'The systems held your attention.') + '</p>' +
             '<p>The operator does not play for the story. The operator plays for the problem. There is a particular satisfaction in understanding a system deeply enough to make it do what you want — to see the board clearly while others are still reading the rules. You logged <strong>' + d.hrs + ' hours</strong> this month in that pursuit. Every one of them intentional.</p>';
    },
    evidence: function(d) {
      return [
        Math.round(d.stratPct) + '% of playtime in strategy or simulation',
        d.topGame ? 'Most time concentrated in ' + d.topGame : null,
        d.hrs + 'h total playtime logged this month'
      ].filter(Boolean);
    },
    seal: 'The position is understood.'
  },

  sovereign: {
    title: 'The Sovereign', color: '#fbbf24',
    bg: 'linear-gradient(150deg,#1a1000 0%,#2a1800 50%,#1a1000 100%)',
    glow: 'rgba(251,191,36,0.18)', img: '',
    flavor: 'Leaves nothing unfinished',
    desc: function(d) {
      return 'You completed <strong>' + d.completed + ' games</strong> and left nothing unfinished. Completion is not a metric for you — it is a standard. Every title in your history has been fully claimed.';
    },
    fullDesc: function(d) {
      return '<p>You completed <strong>' + d.completed + ' games</strong> this month and logged <strong>' + d.hrs + ' hours</strong> doing it. That combination — volume of completions and depth of time — is what separates the sovereign from the merely consistent. You do not just finish games. You finish them properly, fully, without cutting corners on the experience.</p>' +
             '<p>There is a standard here that most players do not hold themselves to. Credits are not the end — they are confirmation that you saw something through. ' + (d.topGame ? '<strong>' + d.topGame + '</strong> was where the most hours went this month.' : 'Every title you touched was given its full due.') + ' The library does not have loose ends. You do not leave things that way.</p>';
    },
    evidence: function(d) {
      return [
        d.completed + ' games brought to completion',
        d.hrs + 'h of focused playtime this month',
        d.topGame ? 'Primary focus: ' + d.topGame : null
      ].filter(Boolean);
    },
    seal: 'Nothing left unfinished.'
  },

  ghost: {
    title: 'The Ghost', color: '#64748b',
    bg: 'linear-gradient(150deg,#080c10 0%,#0c1018 50%,#080c10 100%)',
    glow: 'rgba(100,116,139,0.10)', img: '',
    flavor: 'Was here. Now absent.',
    desc: function(d) {
      return 'Your library has <strong>' + d.totalGames + ' games</strong> in it. The last session was <strong>' + d.daysSinceLastSession + ' days ago</strong>. The collection is real — the player has simply gone quiet. The file remains open.';
    },
    fullDesc: function(d) {
      return '<p>You have <strong>' + d.totalGames + ' games</strong> in your library and have not played in <strong>' + d.daysSinceLastSession + ' days</strong>. The collection did not disappear while you were gone. It waited. Everything you added, everything you played, everything you left unfinished — it is all still there, exactly as you left it.</p>' +
             '<p>Life moves. Priorities shift. The controller gets put down and the weeks pass faster than expected. That is not failure — it is just what happens. The file stays open. The library stays ready. Whenever you come back, the system will be here. There is no penalty for the absence. Only a record of it.</p>';
    },
    evidence: function(d) {
      return [
        'No sessions recorded this period',
        d.totalGames + ' games catalogued in library',
        d.lastSessionDate ? 'Last recorded session: ' + d.lastSessionDate : null
      ].filter(Boolean);
    },
    seal: 'The file remains open.'
  },

  returner: {
    title: 'The Returner', color: '#f97316',
    bg: 'linear-gradient(150deg,#1a0800 0%,#2a1000 50%,#1a0800 100%)',
    glow: 'rgba(249,115,22,0.18)', img: '',
    flavor: 'Gone. And back again.',
    desc: function(d) {
      return 'You were gone for <strong>' + d.daysSinceLastSessionBeforeThisPeriod + ' days</strong>. Now you are back — <strong>' + d.currentPeriodSessions + ' sessions</strong> logged this month. Whatever pulled you away, something pulled you back harder.';
    },
    fullDesc: function(d) {
      return '<p>You were away for <strong>' + d.daysSinceLastSessionBeforeThisPeriod + ' days</strong>. That is not a short absence. Long enough for habits to dissolve, for the library to feel unfamiliar, for the inertia of not playing to become its own kind of normal. And yet you came back. <strong>' + d.currentPeriodSessions + ' sessions</strong> logged since your return — enough to confirm this is not a one-night experiment.</p>' +
             '<p>Returns are harder than they look. The backlog that felt manageable before the break can feel overwhelming after it. The games you were in the middle of feel distant. Starting again takes something. ' + (d.topGame ? 'You started with <strong>' + d.topGame + '</strong>.' : 'You found your way back in.') + ' The fact that you did is the whole story. The system noticed.</p>';
    },
    evidence: function(d) {
      return [
        d.daysSinceLastSessionBeforeThisPeriod + ' days since previous activity',
        d.currentPeriodSessions + ' sessions logged since returning',
        d.topGame ? 'Return activity centered on ' + d.topGame : null
      ].filter(Boolean);
    },
    seal: 'The file is active again.'
  },

  redacted: {
    title: 'Classification Pending', color: '#475569',
    bg: 'linear-gradient(150deg,#0a0a14 0%,#10101e 50%,#0a0a14 100%)',
    glow: 'rgba(71,85,105,0.12)', img: '',
    flavor: 'Identity still forming',
    desc: function(d) {
      return 'Your profile has been flagged for review. Activity is present, but the pattern has not yet resolved into a stable classification. The system is watching. Return when there is more to read.';
    },
    fullDesc: function(d) {
      return '<p>A file has been opened for you. Right now it is mostly empty — not because nothing is here, but because the system needs more to work with before it can say anything meaningful about who you are as a player. Every library starts this way. Every classification begins with a blank page.</p>' +
             '<p>Add games. Play them. Come back. The system will be reading the signals as they come in — what you add, what you finish, how long your sessions run, which genres pull your attention. None of it is wasted. It is all going into the file. When the pattern is clear enough to name, you will know.</p>';
    },
    evidence: function(d) {
      return [
        d.sessions > 0 ? d.sessions + ' sessions recorded so far' : 'No sessions recorded yet',
        'More activity needed before a classification can be assigned'
      ].filter(Boolean);
    },
    seal: 'The file is open. The work begins.'
  }
};

// ── 5.2 Classification Logic ──────────────────────────────────
// Determines which archetype the player falls into
// based on behavior patterns and thresholds

function calculateIdentity(addedCount, completedCount, yearSessions, allGames, lastSessionDate, allSessions) {
  var totalSecs = yearSessions.reduce(function(t, s) { return t + s.seconds; }, 0);
  var avgMins = yearSessions.length ? totalSecs / yearSessions.length / 60 : 0;
  var totalGames = allGames.filter(function(g) { return !g.gpCatalog; }).length;

  var playedGenres = new Set();
  yearSessions.forEach(function(s) {
    if (s.game && s.game.genres && s.game.genres[0]) playedGenres.add(s.game.genres[0]);
  });

  // Game time map
  var gameTime = {};
  var gameTitle = {};
  yearSessions.forEach(function(s) {
    gameTime[s.gameId] = (gameTime[s.gameId] || 0) + s.seconds;
    if (s.game && s.game.title) gameTitle[s.gameId] = s.game.title;
  });
  var topGameSecs = 0;
  var topGameId = null;
  Object.entries(gameTime).forEach(function(entry) {
    if (entry[1] > topGameSecs) { topGameSecs = entry[1]; topGameId = entry[0]; }
  });
  var topGamePct = totalSecs > 0 ? Math.round((topGameSecs / totalSecs) * 100) : 0;
  var topGame = topGameId ? (gameTitle[topGameId] || null) : null;
  var topGameHrs = Math.round(topGameSecs / 3600);

  // Top genre
  var genreCount = {};
  yearSessions.forEach(function(s) {
    var g = s.game; if (!g) return;
    var genre = (g.genres && g.genres[0]) || g.genre || null;
    if (genre) genreCount[genre] = (genreCount[genre] || 0) + 1;
  });
  var topGenre = null;
  var topGenreCount = 0;
  Object.entries(genreCount).forEach(function(entry) {
    if (entry[1] > topGenreCount) { topGenreCount = entry[1]; topGenre = entry[0]; }
  });

  // Strategy percentage
  var strategySecs = 0;
  yearSessions.forEach(function(s) {
    var g = s.game; if (!g) return;
    var genre = ((g.genres && g.genres[0]) || g.genre || '').toLowerCase();
    var tags = (g.tags || []).map(function(t) { return t.toLowerCase(); });
    if (genre.includes('strateg') || genre.includes('simulat') ||
        tags.some(function(t) { return t.includes('strateg') || t.includes('simulat'); }))
      strategySecs += s.seconds;
  });
  var stratPct = totalSecs > 0 ? (strategySecs / totalSecs) * 100 : 0;

  // Backlog count
  var backlog = allGames.filter(function(g) { return g.status === 'backlog'; }).length;

  // Days since last session
  var now = new Date();
  var currentPeriodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  var daysSinceLastSession = null;
  if (lastSessionDate) {
    var diffMs = now - new Date(lastSessionDate);
    daysSinceLastSession = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }

  // Days since last session before this period
  var daysSinceLastSessionBeforeThisPeriod = null;
  if (allSessions && allSessions.length) {
    var previousSessions = allSessions.filter(function(s) {
      return new Date(s.date) < currentPeriodStart;
    });
    if (previousSessions.length) {
      var lastPrevSession = previousSessions.sort(function(a, b) {
        return new Date(b.date) - new Date(a.date);
      })[0];
      var diffMs = currentPeriodStart - new Date(lastPrevSession.date);
      daysSinceLastSessionBeforeThisPeriod = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    }
  }

  // Shared data object
  var d = {
    added: addedCount,
    completed: completedCount,
    hrs: Math.round(totalSecs / 3600),
    sessions: yearSessions.length,
    backlog: backlog,
    topGame: topGame,
    topGamePct: topGamePct,
    topGameHrs: topGameHrs,
    topGenre: topGenre,
    topGenreCount: topGenreCount,
    genres: playedGenres.size,
    gamesPlayed: Object.keys(gameTime).length,
    avgMins: Math.round(avgMins),
    stratPct: stratPct,
    totalGames: totalGames,
    lastSessionDate: lastSessionDate,
    daysSinceLastSession: daysSinceLastSession,
    daysSinceLastSessionBeforeThisPeriod: daysSinceLastSessionBeforeThisPeriod,
    currentPeriodSessions: yearSessions.length
  };

  // Returner — was gone, now back
  if (yearSessions.length >= 2 && daysSinceLastSessionBeforeThisPeriod !== null && daysSinceLastSessionBeforeThisPeriod >= 60)
    return { key: 'returner', data: d };

  // Archivist — collects faster than they play
  if (addedCount >= 10 && completedCount < Math.max(2, addedCount * 0.05))
    return { key: 'archivist', data: d };

  // Terminus — closes loops, volume of completions
  if (completedCount >= 4)
    return { key: 'terminus', data: d };

  // Devoted — singular focus on one game
  if (topGamePct > 50 && yearSessions.length >= 5)
    return { key: 'devoted', data: d };

  // Wanderer — broad genre coverage
  if (playedGenres.size >= 4 && yearSessions.length >= 4)
    return { key: 'wanderer', data: d };

  // Volatile — short burst sessions
  if (avgMins > 0 && avgMins < 30 && yearSessions.length >= 6)
    return { key: 'volatile', data: d };

  // Operator — strategy and simulation focus
  if (stratPct > 40 && yearSessions.length >= 3)
    return { key: 'operator', data: d };

  // Sovereign — completions with depth of engagement
  if (completedCount >= 3 && totalSecs >= (10 * 3600))
    return { key: 'sovereign', data: d };

  // Ghost — established library, has played before, now dormant
  if (yearSessions.length === 0 && totalGames >= 10 && lastSessionDate !== null)
    return { key: 'ghost', data: d };

  // Redacted — not enough signal yet
  return { key: 'redacted', data: d };
}

async function saveIdentityToHistory(year, quarter, identityKey) {
  try {
    var history = await window.nexus.store.get('identityHistory') || [];
    history = history.filter(function(e){ return !(e.year === year && e.quarter === quarter); });
    history.push({ year: year, quarter: quarter, identity: identityKey, ts: Date.now() });
    history.sort(function(a,b){ return a.year !== b.year ? a.year - b.year : a.quarter - b.quarter; });
    await window.nexus.store.set('identityHistory', history);
  } catch(e) {}
}

async function getPreviousIdentity(year, quarter) {
  try {
    var history = await window.nexus.store.get('identityHistory') || [];
    var prevQ = quarter - 1, prevY = year;
    if (prevQ < 1) { prevQ = 4; prevY = year - 1; }
    var entry = history.find(function(e){ return e.year === prevY && e.quarter === prevQ; });
    return entry ? entry.identity : null;
  } catch(e) { return null; }
}

function renderIdentityHighlightsRow(items) {
  return (
    '<div class="identity-highlights-row">' +
      items.map(function(item) {
        return (
          '<div class="identity-highlight-pill">' +
            '<div class="identity-highlight-label">' + item.label + '</div>' +
            '<div class="identity-highlight-value">' + item.value + '</div>' +
          '</div>'
        );
      }).join('') +
    '</div>'
  );
}

// ── IDENTITY PAGE: REALITY CHECK MODULE ──────────────────────────────────────
// Renders the compact metrics panel shown on the lower-left side of the page.

function renderBacklogRealityCheck(data) {
  return (
    '<div class="identity-module identity-reality-check">' +
     '<div class="identity-module-header">' +
       '<div class="identity-module-eyebrow">BACKLOG ASSESSMENT</div>' +
       '<div class="identity-module-title">Reality Check</div>' +
     '</div>' +
     '<div class="identity-reality-copy">' +
       'Library activity for ' + (data.periodLabel || 'this period') + '.' +
     '</div>' +

      '<div class="identity-reality-grid">' +

        '<div class="identity-reality-stat">' +
          '<div class="identity-reality-stat-label">Backlog Growth</div>' +
          '<div class="identity-reality-stat-value">' + (data.backlogGrowth > 0 ? '+' : '') + data.backlogGrowth + '</div>' +
        '</div>' +

        '<div class="identity-reality-stat">' +
          '<div class="identity-reality-stat-label">Completion Rate</div>' +
          '<div class="identity-reality-stat-value">' + data.completionRate + '%</div>' +
        '</div>' +

        '<div class="identity-reality-stat">' +
          '<div class="identity-reality-stat-label">Top Genre</div>' +
          '<div class="identity-reality-stat-value">' + data.topGenre + '</div>' +
        '</div>' +

        '<div class="identity-reality-stat">' +
          '<div class="identity-reality-stat-label">Top Platform</div>' +
          '<div class="identity-reality-stat-value">' + data.topPlatform + '</div>' +
        '</div>' +

        '<div class="identity-reality-stat">' +
          '<div class="identity-reality-stat-label">Longest Session</div>' +
          '<div class="identity-reality-stat-value">' + data.longestSession + '</div>' +
        '</div>' +

        '<div class="identity-reality-stat">' +
          '<div class="identity-reality-stat-label">Library Change</div>' +
          '<div class="identity-reality-stat-value">' + (data.libraryChange > 0 ? '+' : '') + data.libraryChange + '</div>' +
        '</div>' +

      '</div>' +
    '</div>'
  );
}

// ── 5.4 Archetype Card (Embedded) ─────────────────────────────
// Current in-page archetype display (small card)
// NOTE: This will be replaced/paired with modal system

function renderIdentityArchetypeModule(data) {
  return (
    '<div class="identity-archetype-module">' +
      '<div class="identity-archetype-shell" style="background-image:url(\'' + data.template + '\')">' +
        '<div class="identity-archetype-overlay"></div>' +
        '<div class="identity-archetype-inner">' +
          '<div class="identity-archetype-meta">Active Classification</div>' +
          '<div class="identity-archetype-name">' + data.identityName + '</div>' +
          '<div class="identity-archetype-text">' + data.identitySummary + '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

// ── ARCHETYPE CARD RENDERER ───────────────────────────────────────────────────
// Generates inline SVG tarot cards for the identity page teaser and modal.
// Call renderArchetypeCardSVG(key, width, height) to get a complete card HTML string.

function renderArchetypeCardSVG(key, width, height) {
  const meta = IDENTITY_ARCHETYPES[key] || IDENTITY_ARCHETYPES.redacted;
  const c = meta.color;
  const num = CARD_NUMS[key] || '—';
  const borderFn = CARD_BORDERS[key] || cardBorderRedacted;
  const symbolFn = CARD_SYMBOLS[key] || CARD_SYMBOLS.redacted;
  const W = CARD_W, H = CARD_H, R = CARD_R;
  const scaleX = width / W, scaleY = height / H;

  return `<div style="position:relative;width:${width}px;height:${height}px;border-radius:${R * scaleX}px;overflow:hidden;flex-shrink:0;">` +
    // base
    `<div style="position:absolute;inset:0;background:#07101e;border-radius:${R * scaleX}px;"></div>` +
    // atmosphere glow
    `<div style="position:absolute;inset:0;background:radial-gradient(ellipse 75% 65% at 50% 48%,${meta.glow} 0%,transparent 72%);border-radius:${R * scaleX}px;"></div>` +
    // header
    `<div style="position:relative;z-index:4;width:100%;text-align:center;padding:${Math.round(16*scaleY)}px ${Math.round(14*scaleX)}px ${Math.round(11*scaleY)}px;border-bottom:1px solid rgba(26,188,156,0.08);flex-shrink:0;">` +
      `<div style="font-family:'Syne',sans-serif;font-size:${Math.round(9.5*scaleX)}px;font-weight:800;letter-spacing:0.2em;text-transform:uppercase;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;width:100%;">` +
        `<span style="color:rgba(255,255,255,0.55);justify-self:end;padding-right:6px;">Backlog</span>` +
        `<span style="color:${c};opacity:0.9;letter-spacing:0.12em;">${num}</span>` +
        `<span style="color:rgba(255,255,255,0.55);justify-self:start;padding-left:6px;">Zero</span>` +
      `</div>` +
    `</div>` +
    // art zone
    `<div style="position:relative;z-index:4;flex:1;width:100%;overflow:hidden;height:${Math.round((H - 90) * scaleY)}px;">` +
      symbolFn(c) +
    `</div>` +
    // nameplate
    `<div style="position:relative;z-index:4;width:100%;text-align:center;padding:${Math.round(10*scaleY)}px ${Math.round(14*scaleX)}px ${Math.round(14*scaleY)}px;border-top:1px solid rgba(26,188,156,0.08);">` +
      `<div style="font-family:'Syne',sans-serif;font-size:${Math.round(16*scaleX)}px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;line-height:1;color:${c};">${meta.title.replace('The ','')}</div>` +
      `<div style="font-family:'Instrument Sans',sans-serif;font-style:italic;font-size:${Math.round(9.5*scaleX)}px;color:rgba(255,255,255,0.28);margin-top:4px;">${meta.flavor || ''}</div>` +
    `</div>` +
    // border overlay
    `<svg viewBox="0 0 ${W} ${H}" width="${width}" height="${height}" preserveAspectRatio="none" style="position:absolute;inset:0;pointer-events:none;z-index:8;overflow:visible;">` +
      borderFn(c) +
    `</svg>` +
  `</div>`;
}

// ── 5.5 Archetype Modal System ────────────────────────────────
// Full-size archetype card modal
// This is the expanded version of the embedded archetype preview.

function renderIdentityCardModal(data) {
  var evidence = (data.identityEvidence || []).slice(0, 3);

  return (
    '<div id="identityCardModal" class="identity-card-modal" aria-hidden="true">' +
      '<div class="identity-card-modal-backdrop"></div>' +
      '<div class="identity-card-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="identityCardTitle">' +

        '<div class="identity-card-full" style="background:' + (data.identityBg || 'linear-gradient(150deg,#061420 0%,#0a2030 50%,#072535 100%)') + ';">' +
          '<button type="button" class="identity-card-modal-close" id="identityCardCloseBtn" aria-label="Close Identity Card">×</button>' +
          '<button type="button" class="identity-card-modal-export" id="exportLibraryCard" aria-label="Export Dossier">↓ Export</button>' +
          '<span id="exportDossierConfirm" class="identity-card-modal-export-confirm">Dossier saved.</span>' +

          // HEADER
          '<div class="identity-card-full-header">BACKLOG ZERO • IDENTITY CLASSIFICATION • ' + escHtml((data.periodLabel || '').toUpperCase()) + '</div>' +
          
          '<div class="identity-card-full-body">' +

            // LEFT SIDE — TEXT
            '<div class="identity-card-full-left">' +
              '<div class="identity-card-full-copy">' +

                // LOGO STAMP
                '<div class="identity-card-full-logo">' +
                  '<img src="assets/bz_logo_circle_clean.svg" alt="Backlog Zero" class="identity-card-full-logo-img" style="filter:drop-shadow(0 0 4px ' + (data.identityColor || '#1abc9c') + ') brightness(1.4);opacity:0.75;">' +
                '</div>' +

                '<div id="identityCardTitle" class="identity-card-full-title">' +
                  escHtml((data.identityName || 'Identity Unknown').toUpperCase()) +
                '</div>' +

                '<div id="identityCardNarrative" class="identity-card-full-narrative" style="--accent:' + (data.identityColor || '#1abc9c') + ';">' +
                  (data.identitySummary || '') +
                '</div>' +

                '<div class="identity-card-full-section-label">CLASSIFICATION BASIS</div>' +

                '<div class="identity-card-full-evidence">' +
                  evidence.map(function(e){
                    return '<div class="identity-card-full-evidence-line">' + e + '</div>';
                  }).join('') +
                '</div>' +

                '<div class="identity-card-full-footer">' +
                  escHtml(data.identityPeriod || '') + '<br>' +
                  'Classification Confirmed' +
                '</div>' +

                '<div class="identity-card-full-seal">' +
                  escHtml(data.identitySeal || '') +
                '</div>' +

              '</div>' +
            '</div>' +

            // RIGHT SIDE — TAROT CARD
            '<div class="identity-card-full-art">' +
              renderArchetypeCardSVG(data.identityKey, 300, 480) +
            '</div>' +

          '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

function openIdentityCardModal() {
  var modal = document.getElementById('identityCardModal');
  if (!modal) return;
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  // Move focus to close button for accessibility
  var closeBtn = document.getElementById('identityCardCloseBtn');
  if (closeBtn) setTimeout(function() { closeBtn.focus(); }, 50);
}

function closeIdentityCardModal() {
  var modal = document.getElementById('identityCardModal');
  if (!modal) return;
  // Move focus to body before hiding to avoid aria-hidden on focused element
  if (document.activeElement && modal.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  modal.classList.remove('active');
  modal.setAttribute('aria-hidden', 'true');
}

function bindIdentityCardModal() {
  var modal = document.getElementById('identityCardModal');
  var openBtn = document.getElementById('identityCardOpenBtn');
  var closeBtn = document.getElementById('identityCardCloseBtn');
  var card = document.querySelector('.identity-archetype-module');

  if (openBtn && !openBtn.dataset.bound) {
    openBtn.dataset.bound = '1';
    openBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      openIdentityCardModal();
    });
  }

  if (card && !card.dataset.bound) {
    card.dataset.bound = '1';
    card.style.cursor = 'pointer';
    card.addEventListener('click', openIdentityCardModal);
  }

  if (closeBtn && !closeBtn.dataset.bound) {
    closeBtn.dataset.bound = '1';
    closeBtn.addEventListener('click', closeIdentityCardModal);
  }

  if (closeBtn && !closeBtn.dataset.bound) {
    closeBtn.dataset.bound = '1';
    closeBtn.addEventListener('click', closeIdentityCardModal);
  }

  var exportBtn = document.getElementById('exportLibraryCard');
  console.log('[Bind] exportBtn:', exportBtn);
  if (exportBtn && !exportBtn.dataset.bound) {
    exportBtn.dataset.bound = '1';
    exportBtn.addEventListener('click', exportLibraryCard);
  }

if (modal && !modal.dataset.bound) {
    modal.dataset.bound = '1';
    modal.addEventListener('click', function(e) {
      if (e.target === modal || e.target === modal.querySelector('.identity-card-modal-dialog')) {
        closeIdentityCardModal();
      }
    });
  }

  if (!document.body.dataset.identityEscBound) {
    document.body.dataset.identityEscBound = '1';
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeIdentityCardModal();
    });
  }
}

// ── REPORT NOTES LOGIC ──────────────────────────────────────────────────────

function getPreviousMonthInfo(year, monthIndex) {
  if (monthIndex <= 0) {
    return { year: year - 1, monthIndex: 11 };
  }
  return { year: year, monthIndex: monthIndex - 1 };
}

// ── IDENTITY PAGE: PERIOD COMPARISON HELPERS ─────────────────────────────────
// Builds previous-period data so report notes can compare current quarter
// behavior against the prior quarter.

function buildIdentityDataForPeriod(year, monthIndex) {
  var start = new Date(year, monthIndex, 1);
  var end = new Date(year, monthIndex + 1, 1);

  var added = games.filter(function(g) {
    if (!g.addedAt) return false;
    var d = new Date(g.addedAt);
    return d >= start && d < end;
  });

  var completed = games.filter(function(g) {
    if (g.status !== 'finished' || !g.lastPlayedAt) return false;
    var d = new Date(g.lastPlayedAt);
    return d >= start && d < end;
  });

  var sessions = [];
  games.forEach(function(g) {
    (g.sessions || []).forEach(function(s) {
      if (!s || !s.startedAt) return;
      var d = new Date(s.startedAt);
      if (d >= start && d < end) {
        sessions.push({
          gameId: g.id,
          title: g.title,
          platform: g.platform,
          genre: g.genre || null,
          seconds: s.seconds || 0,
          startedAt: s.startedAt
        });
      }
    });
  });

  var totalSecs = sessions.reduce(function(sum, s) {
    return sum + (s.seconds || 0);
  }, 0);

  return {
    addedCount: added.length,
    completedCount: completed.length,
    sessionsCount: sessions.length,
    totalHours: totalSecs / 3600,
    netBacklogChange: added.length - completed.length
  };
}

// ── IDENTITY PAGE: REPORT NOTES GENERATION ───────────────────────────────────
// Generates short interpretation lines for the hero card.
// These notes explain what the quarter's behavior means without duplicating
// the Stats page directly.

function buildIdentityReportNotes(data, previousPeriodData) {
  var notes = [];

  var addedCount = data.added ? data.added.length : 0;
  var completedCount = data.completed ? data.completed.length : 0;
  var sessionsCount = data.sessions ? data.sessions.length : 0;
  var totalHours = typeof data.totalHours === 'number' ? data.totalHours : 0;
  var completionRate = addedCount > 0
    ? Math.round((completedCount / addedCount) * 100)
    : 0;

  var longestSessionText = data.longestSession
    ? formatIdentityDuration(data.longestSession.seconds)
    : null;

  var topGenreName = data.topGenre ? data.topGenre[0] : null;
  var topGenreCount = data.topGenre ? data.topGenre[1] : 0;

  // 1. Backlog / acquisition behavior
  if (data.netBacklogChange > 0) {
    var backlogLine =
      'Acquisition continues to outpace completion, with backlog expanding by +' +
      data.netBacklogChange + ' this month.';

    if (previousPeriodData && previousPeriodData.netBacklogChange !== null) {
      if (data.netBacklogChange > previousPeriodData.netBacklogChange) {
        backlogLine =
          'Backlog growth has accelerated versus last month, reinforcing a collection-driven pattern.';
      } else if (data.netBacklogChange < previousPeriodData.netBacklogChange) {
        backlogLine =
          'Backlog growth has slowed versus last month, though acquisition still exceeds completion.';
      }
    }

    notes.push(backlogLine);

  } else if (data.netBacklogChange < 0) {

    notes.push(
      'Completion has outpaced acquisition, reducing backlog pressure by ' +
      Math.abs(data.netBacklogChange) + ' this month.'
    );

  } else {

    notes.push(
      'Backlog movement remains stable, with acquisition and completion roughly balanced this month.'
    );
  }

  // 2. Completion behavior
  if (completionRate === 0 && addedCount > 0) {
    notes.push(
      'No newly added titles were completed this month, indicating continued backlog expansion without reduction.'
    );
  } else if (completionRate >= 50) {
    notes.push(
      'Completion efficiency is strong this month, with ' + completionRate +
      '% of added titles reaching completion.'
    );
  } else {
    var completionLine =
      'Completion activity remains limited, with only ' + completionRate +
      '% of newly added titles completed this month.';
    if (previousPeriodData && previousPeriodData.addedCount > 0) {
      var prevRate = Math.round(
        (previousPeriodData.completedCount / previousPeriodData.addedCount) * 100
      );

      if (completionRate > prevRate) {
        completionLine =
          'Completion efficiency has improved versus last month, indicating increased follow-through.';
      } else if (completionRate < prevRate) {
        completionLine =
          'Completion efficiency has declined versus last month, suggesting reduced progression through the backlog.';
      }
    }

    notes.push(completionLine);
  }

  // 3. Engagement / session behavior
  if (sessionsCount === 0 || totalHours === 0) {
    notes.push(
      'No play activity recorded this month. Identity signals are still forming.'
    );
  } else if (totalHours < 5) {
    notes.push(
      'Playtime this month remains limited at ' + totalHours.toFixed(1) +
      ' hours, indicating lower engagement relative to library growth.'
    );
  } else if (longestSessionText) {
    notes.push(
      'Session patterns this month indicate focused engagement, with peak sessions reaching ' +
      longestSessionText + '.'
    );
  }

  // 4. Platform concentration
  if (data.topPlatform) {
    notes.push(
      'Platform usage this month is heavily concentrated on ' + data.topPlatform +
      ', with limited distribution across other systems.'
    );
  }

  // 5. Genre tendency
  if (topGenreName) {
    notes.push(
      'Genre preference this month is centered around ' + topGenreName +
      (topGenreCount > 0 ? ', appearing most frequently in recent activity.' : '.')
    );
  }

  // prioritize stronger signals first
  return notes.slice(0, Math.min(3, notes.length));
}

// ── 7. EVENT BINDINGS ─────────────────────────────────────────
// ── 5.3 Identity Page Rendering ──────────────────────────────
// Builds the Identity page UI by assembling:
// - hero section
// - reality check module
// - embedded archetype card
// - page-level branding

async function renderWrappedPage() {
  var el = document.getElementById('wrappedContent');
  if (!el) return;
  maybeShowPageHint('identity');

  var yearSel = document.getElementById('wrappedYear');
  if (yearSel && !yearSel.dataset.bound) {
    var currentYear = new Date().getFullYear();
    yearSel.innerHTML = '';
    for (var y = currentYear; y >= 2020; y--) {
      var opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      yearSel.appendChild(opt);
    }
    yearSel.value = String(currentYear);
    yearSel.dataset.bound = '1';
    yearSel.addEventListener('change', renderWrappedPage);
  }

    var monthSel = document.getElementById('wrappedMonth');
    if (monthSel && !monthSel.dataset.bound) {
      var currentMonth = new Date().getMonth();
      monthSel.value = String(currentMonth);
      monthSel.dataset.bound = '1';
      monthSel.addEventListener('change', renderWrappedPage);
    }

  var data = await buildIdentityData();

  var selectedYear = parseInt((yearSel && yearSel.value) || new Date().getFullYear(), 10);
  var selectedMonthIndex = parseInt((monthSel && monthSel.value) || new Date().getMonth(), 10);

  var prevInfo = getPreviousMonthInfo(selectedYear, selectedMonthIndex);
  var previousPeriodData = buildIdentityDataForPeriod(prevInfo.year, prevInfo.monthIndex);

  var reportNotes = buildIdentityReportNotes(data, previousPeriodData);

  var completionRate = data.added.length > 0
    ? Math.round((data.completed.length / data.added.length) * 100)
    : 0;

  var backlogRealityData = {
       backlogGrowth: data.netBacklogChange,
       completionRate: completionRate,
       topGenre: data.topGenre ? data.topGenre[0] : '—',
       topPlatform: data.topPlatform || '—',
       longestSession: data.longestSession
         ? formatIdentityDuration(data.longestSession.seconds)
         : '—',
       libraryChange: data.added.length,
       periodLabel: data.periodLabel || ''
};

  var archetypeVisual = data.identityMeta || {};
  var identityKey = data.identityKey || 'redacted';
  var previousIdentityKey = await window.nexus.store.get('identity.previous.key') || null;
  window.nexus.store.set('identity.previous.key', identityKey);
  var archetypeBg = archetypeVisual.template || archetypeVisual.bg || '';
  var archetypeArt = archetypeVisual.image || '';

  // ── Identity Modal Data Bridge ─────────────────────────────
// Converts archetype system into modal-ready fields

var identityModalPayload = {
  added: data.added.length,
  completed: data.completed.length,
  hrs: Math.round(data.totalHours * 10) / 10,
  backlog: data.backlogCurrentCount,
  sessions: data.sessions.length,
  genres: data.topGenre ? 1 : 0,
  gamesPlayed: data.sessions.length,
  topGame: data.topGame ? data.topGame.title : null,
  topGameHrs: data.topGameHours || 0,
  topGamePct: data.totalHours > 0 && data.topGameHours > 0
    ? Math.round((data.topGameHours / data.totalHours) * 100)
    : 0,
  topGenre: data.topGenre ? data.topGenre[0] : null,
  topGenreCount: data.topGenre ? data.topGenre[1] : 0,
  avgMins: data.sessions.length > 0
    ? Math.round((data.totalSecs / data.sessions.length) / 60)
    : 0,
  stratPct: 0
};

data.identityName =
  archetypeVisual.title || 'Identity Unknown';

data.identitySummary =
  typeof archetypeVisual.fullDesc === 'function'
    ? archetypeVisual.fullDesc(identityModalPayload)
    : typeof archetypeVisual.desc === 'function'
      ? archetypeVisual.desc(identityModalPayload)
      : 'Your gaming identity is still taking shape.';

data.identityEvidence =
  typeof archetypeVisual.evidence === 'function'
    ? archetypeVisual.evidence(identityModalPayload)
    : [];

data.identityImage =
  archetypeVisual.img || '';

data.identityBg =
  archetypeBg || 'linear-gradient(150deg,#061420 0%,#0a2030 50%,#072535 100%)';

data.identitySeal =
  archetypeVisual.seal || '';

data.identityColor = 
  archetypeVisual.color || '#1abc9c';


// ── 6. UI RENDERING ───────────────────────────────────────────

  el.innerHTML =
    '<div class="identity-page-layout">' +

      '<div class="identity-page-watermark">' +
        '<img src="assets/bz_logo_full.svg" class="identity-page-watermark-full" alt="Backlog Zero">' +
      '</div>' +

            '<div class="identity-top-band">' +
        '<div class="identity-report-hero">' +

          '<div class="identity-report-eyebrow">Backlog Zero · Identity Dossier</div>' +

          '<div class="identity-report-main">' +
            
            '<div class="identity-report-copy">' +

              '<div class="identity-report-title-row">' +
                '<div class="identity-report-title">' + escHtml(archetypeVisual.title || 'Identity Unknown') + '</div>' +
              '</div>' +

              '<div class="identity-report-meta-block">' +
                '<div class="identity-report-meta-line">' +
                  '<span class="identity-report-meta-key">Period</span>' +
                  '<span class="identity-report-meta-val">' + escHtml(data.periodLabel || 'January 2026') + '</span>' +
                '</div>' +

                '<div class="identity-report-meta-line">' +
                  '<span class="identity-report-meta-key">Status</span>' +
                  '<span class="identity-report-meta-val">' + (identityKey === 'redacted' ? 'Classification Pending' : 'Active Classification') + '</span>' +
                '</div>' +

                '<div class="identity-report-meta-line">' +
                  '<span class="identity-report-meta-key">Classification</span>' +
                  '<span class="identity-report-meta-val" style="color:' + (archetypeVisual.color || 'inherit') + '">' + escHtml(archetypeVisual.title || 'Pending') + '</span>' +
                '</div>' +

                (previousIdentityKey && previousIdentityKey !== identityKey
                  ? '<div class="identity-report-meta-line">' +
                      '<span class="identity-report-meta-key">Prior</span>' +
                      '<span class="identity-report-meta-val" style="opacity:0.55;">' + escHtml((IDENTITY_ARCHETYPES[previousIdentityKey] && IDENTITY_ARCHETYPES[previousIdentityKey].title) || '—') + '</span>' +
                    '</div>'
                  : '') +

              '</div>' +

              '<div class="identity-report-notes">' +
                '<div class="identity-report-notes-label">Report Notes</div>' +
                '<div class="identity-report-notes-list">' +
                  reportNotes.map(function(note) {
                    return '<div class="identity-report-note-item">' + escHtml(note) + '</div>';
                  }).join('') +
                '</div>' +
              '</div>' +

              '</div>' +

            '<div class="identity-report-visual"></div>' +
          '</div>' +

        '</div>' +
      '</div>' +

 

      '<div class="identity-bottom-band">' +

        '<div class="identity-bottom-left">' +
          renderBacklogRealityCheck(backlogRealityData) +
        '</div>' +

        '<div class="identity-bottom-right">' +
          '<div class="identity-archetype-module">' +
            '<div class="identity-archetype-shell"' +
              (archetypeBg ? ' style="background:' + archetypeBg + ';"' : '') +
            '>' +

              renderArchetypeCardSVG(data.identityKey, 200, 320) +

              '<div class="identity-archetype-overlay"></div>' +

              '<div class="identity-archetype-inner">' +
                '<div class="identity-archetype-meta">Active Classification</div>' +
                '<div class="identity-archetype-name">' + escHtml(archetypeVisual.title || 'Identity Unknown') + '</div>' +
                '<div class="identity-archetype-text">' +
                (archetypeVisual && typeof archetypeVisual.desc === 'function'
                  ? archetypeVisual.desc({
                      added: data.added.length,
                      completed: data.completed.length,
                      hrs: Math.round(data.totalHours * 10) / 10,
                      backlog: data.backlogCurrentCount,
                      sessions: data.sessions.length,
                      genres: data.topGenre ? 1 : 0,
                      gamesPlayed: data.sessions.length,
                      topGame: data.topGame ? data.topGame.title : null,
                      topGameHrs: data.topGameHours || 0,
                      topGamePct: data.totalHours > 0 && data.topGameHours > 0
                        ? Math.round((data.topGameHours / data.totalHours) * 100)
                        : 0,
                      topGenre: data.topGenre ? data.topGenre[0] : null,
                      topGenreCount: data.topGenre ? data.topGenre[1] : 0,
                      avgMins: data.sessions.length > 0
                        ? Math.round((data.totalSecs / data.sessions.length) / 60)
                        : 0,
                      stratPct: 0
                    })
                  : 'Keep playing to reveal your identity pattern.') +
                '</div>' +
                '<button type="button" class="identity-card-open-btn" id="identityCardOpenBtn">Open Full Dossier</button>'
              '</div>' +

            '</div>' +
          '</div>' +
        '</div>' +

      '</div>' +
      '</div>';

      var existingIdentityModal = document.getElementById('identityCardModal');
      if (existingIdentityModal) existingIdentityModal.remove();

      document.body.insertAdjacentHTML('beforeend', renderIdentityCardModal(data));

      bindIdentityCardModal();
    }

// ── 5.6 Identity Data Assembly ───────────────────────────────
// Collects all quarter-specific inputs for the Identity page,
// including archetype classification, notes, and summary metrics.

async function buildIdentityData() {
  var yearSel = document.getElementById('wrappedYear');
  var monthSel = document.getElementById('wrappedMonth');

  var year = parseInt((yearSel && yearSel.value) || new Date().getFullYear());
  var month = parseInt((monthSel && monthSel.value) || new Date().getMonth());

  var periodStart = new Date(year, month, 1);
  var periodEnd = new Date(year, month + 1, 1);

  var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var periodLabel = monthNames[month] + ' ' + year;

  var added = games.filter(function(g) {
    return !g.gpCatalog && g.addedAt && new Date(g.addedAt) >= periodStart && new Date(g.addedAt) < periodEnd;
  });

  var completed = games.filter(function(g) {
  return g.status === 'finished' && g.lastPlayedAt &&
    new Date(g.lastPlayedAt) >= periodStart && new Date(g.lastPlayedAt) < periodEnd;
  });

  var backlogStartCount = games.filter(function(g) {
  if (g.gpCatalog) return false;
  var addedDate = g.addedAt ? new Date(g.addedAt) : null;
  return (!addedDate || addedDate < periodStart) && g.status !== 'finished';
}).length;
  
  var sessions = [];
  var allSD = {};
  try {
    allSD = await window.nexus.store.getByPrefix('sessions:') || {};
    Object.entries(allSD).forEach(function(entry) {
      var gameId = entry[0].replace('sessions:', '');
      var game = games.find(function(g) { return String(g.id) === String(gameId); });
      (entry[1] || []).forEach(function(s) {
        var d = new Date(s.date);
        if (d >= periodStart && d < periodEnd) {
          sessions.push({
            gameId: gameId,
            game: game,
            title: game ? game.title : null,
            date: d,
            seconds: Math.max(0, s.seconds || 0)
          });
        }
      });
    });
  } catch (e) {}
    allSD = await window.nexus.store.getByPrefix('sessions:') || {};


  var totalSecs = sessions.reduce(function(t, s) { return t + s.seconds; }, 0);
  var totalHours = totalSecs / 3600;

  var backlogCurrentCount = games.filter(function(g) {
  return !g.gpCatalog && g.status !== 'finished';
  }).length;

  var gamesAddedCount = added.length;
  var gamesCompletedCount = completed.length;

  var netBacklogChange = backlogCurrentCount - backlogStartCount;

  var estimatedClearMonths = gamesCompletedCount > 0
    ? Math.round((backlogCurrentCount / gamesCompletedCount) * 3)
    : null;

  var estimatedClearLabel = estimatedClearMonths === null
    ? 'No estimate yet'
    : estimatedClearMonths < 12
      ? estimatedClearMonths + ' months'
      : (estimatedClearMonths / 12).toFixed(1) + ' years';

  var gameSessionTime = {};
  sessions.forEach(function(s) {
    gameSessionTime[s.gameId] = (gameSessionTime[s.gameId] || 0) + s.seconds;
  });

  var newPlayedCount = Object.keys(gameSessionTime).length;

  var topGameId = Object.keys(gameSessionTime).sort(function(a, b) {
    return gameSessionTime[b] - gameSessionTime[a];
  })[0];

  var topGame = topGameId
    ? games.find(function(g) { return String(g.id) === String(topGameId); })
    : null;

  var topGameHours = topGame ? (gameSessionTime[topGameId] / 3600) : 0;

  var genreCounts = {};
  added.forEach(function(g) {
    var genre = (g.genres && g.genres[0]) || g.genre || 'Other';
    genreCounts[genre] = (genreCounts[genre] || 0) + 1;
  });

  var topGenres = Object.entries(genreCounts).sort(function(a, b) { return b[1] - a[1]; });
  var topGenre = topGenres[0] || null;

  var longestSession = sessions.reduce(function(best, s) {
    return s.seconds > (best ? best.seconds : 0) ? s : best;
  }, null);

  var platformCounts = {};
  games.forEach(function(g) {
    (g.platforms || []).forEach(function(p) {
      if (!p || p === 'gamepass') return;
      platformCounts[p] = (platformCounts[p] || 0) + 1;
    });
  });

  var topPlatformKey = Object.keys(platformCounts).sort(function(a, b) {
    return platformCounts[b] - platformCounts[a];
  })[0] || '';

  var topPlatform = topPlatformKey ? (PLAT_LABEL[topPlatformKey] || topPlatformKey) : '—';
  var platformCount = Object.keys(platformCounts).length;

  // Build full session history and lastSessionDate for identity classification
  var allSessions = [];
  var lastSessionDate = null;
  try {
    Object.entries(allSD).forEach(function(entry) {
      var gameId = entry[0].replace('sessions:', '');
      var game = games.find(function(g) { return String(g.id) === String(gameId); });
      (entry[1] || []).forEach(function(s) {
        allSessions.push({
          gameId: gameId,
          game: game,
          date: new Date(s.date),
          seconds: Math.max(0, s.seconds || 0)
        });
      });
    });
    if (allSessions.length) {
      allSessions.sort(function(a, b) { return b.date - a.date; });
      lastSessionDate = allSessions[0].date.toISOString();
    }
  } catch(e) {}

  var identity = calculateIdentity(added.length, completed.length, sessions, games, lastSessionDate, allSessions);
  var identityKey = identity.key;
  var previousIdentityKey = await window.nexus.store.get('identity.previous.key') || null;
  window.nexus.store.set('identity.previous.key', identityKey);
  var identityData = identity.data;
  var identityMeta = IDENTITY_ARCHETYPES[identityKey] || IDENTITY_ARCHETYPES.redacted;

  return {
    year: year,
    month: month,
    periodLabel: periodLabel,
    added: added,
    completed: completed,
    sessions: sessions,
    totalSecs: totalSecs,
    totalHours: totalHours,
    newPlayedCount: newPlayedCount,
    backlogStartCount: backlogStartCount,
    backlogCurrentCount: backlogCurrentCount,
    netBacklogChange: netBacklogChange,
    estimatedClearMonths: estimatedClearMonths,
    estimatedClearLabel: estimatedClearLabel,
    topGame: topGame,
    topGameHours: topGameHours,
    topGenre: topGenre,
    topPlatform: topPlatform,
    platformCount: platformCount,
    longestSession: longestSession,
    identityKey: identityKey,
    identityMeta: identityMeta
  };

  var totalHours = 0; 
}

function renderIdentityHero(data) {
  return (
    '<section class="identity-hero">' +

      '<div class="identity-hero-kicker">Backlog Zero</div>' +
      '<div class="identity-hero-title">Identity Report</div>' +
      '<div class="identity-hero-subtitle">' + escHtml(data.periodLabel) + '</div>' +

      '<div class="identity-hero-archetype">' +
        '<div class="identity-archetype-badge">' +
          escHtml(data.identityMeta.title || 'Classification Pending') +
        '</div>' +
        '<div class="identity-archetype-desc">' +
          (data.identityMeta.desc ? data.identityMeta.desc(data.identityData) : 'Keep playing to reveal your identity pattern.') +
        '</div>' +
      '</div>' +

      '<div class="identity-hero-stats">' +

        '<div class="identity-hero-stat">' +
          '<strong>' + data.added.length + '</strong>' +
          '<span>Added</span>' +
        '</div>' +

        '<div class="identity-hero-stat">' +
          '<strong>' + data.completed.length + '</strong>' +
          '<span>Completed</span>' +
        '</div>' +

        '<div class="identity-hero-stat">' +
          '<strong>' + data.totalHours.toFixed(1) + 'h</strong>' +
          '<span>Played</span>' +
        '</div>' +

      '</div>' +

    '</section>'
  );
}

function renderIdentityHighlights(data) {
  return (
    '<section class="identity-section">' +
      '<div class="identity-section-title">Highlights</div>' +
      '<div class="identity-highlights-grid">' +
        renderIdentityHighlightCard('Most Played', data.topGame ? escHtml(data.topGame.title) : '—', data.topGame ? data.topGameHours.toFixed(1) + 'h' : 'No play data') +
        renderIdentityHighlightCard('Top Genre', data.topGenre ? escHtml(data.topGenre[0]) : '—', data.topGenre ? data.topGenre[1] + ' added' : 'No genre signal') +
        renderIdentityHighlightCard('Longest Session', data.longestSession ? formatIdentityDuration(data.longestSession.seconds) : '—', 'Single-session peak') +
        renderIdentityHighlightCard('Quarter', 'Q' + data.quarter, escHtml(data.qLabels[data.quarter])) +
      '</div>' +
    '</section>'
  );
}

function renderIdentityArchetype(data) {
  return (
    '<section class="identity-section identity-archetype">' +
      '<div class="identity-section-title">Archetype</div>' +
      '<div class="identity-archetype-name">' + escHtml(data.identityMeta.label || 'Unknown') + '</div>' +
      '<div class="identity-archetype-copy">' + escHtml(data.identityMeta.description || 'Keep playing to reveal your identity pattern.') + '</div>' +
    '</section>'
  );
}

function renderIdentityTaste(data) {
  return (
    '<section class="identity-section">' +
      '<div class="identity-section-title">Taste Profile</div>' +
      '<div class="identity-placeholder">Genre, platform, and collection taste modules go here.</div>' +
    '</section>'
  );
}

function renderIdentityPlayStyle(data) {
  return (
    '<section class="identity-section">' +
      '<div class="identity-section-title">Play Style</div>' +
      '<div class="identity-placeholder">Session cadence, completion tendency, and behavior insights go here.</div>' +
    '</section>'
  );
}

function renderIdentitySupport(data) {
  return (
    '<section class="identity-section">' +
      '<div class="identity-section-title">Supporting Signals</div>' +
      '<div class="identity-placeholder">Recent standouts, hidden gem, backlog pressure, and supporting narrative go here.</div>' +
    '</section>'
  );
}

function renderIdentityHighlightCard(label, value, meta) {
  return (
    '<div class="identity-highlight-card">' +
      '<div class="identity-highlight-label">' + label + '</div>' +
      '<div class="identity-highlight-value">' + value + '</div>' +
      '<div class="identity-highlight-meta">' + meta + '</div>' +
    '</div>'
  );
}

function renderIdentityHighlightsRow(items) {
  return (
    '<div class="identity-highlights-row">' +
      items.map(function(item) {
        return (
          '<div class="identity-highlight-pill">' +
            '<div class="identity-highlight-label">' + escHtml(item.label) + '</div>' +
            '<div class="identity-highlight-value">' + escHtml(item.value) + '</div>' +
          '</div>'
        );
      }).join('') +
    '</div>'
  );
}

function formatIdentityDuration(seconds) {
  if (!seconds) return '—';
  if (seconds >= 3600) return (seconds / 3600).toFixed(1) + 'h';
  return Math.round(seconds / 60) + 'm';
}

function renderIdentityCard(data) {
  return (
    '<section class="identity-section">' +
      '<div class="identity-section-title">Identity Card</div>' +
      '<div class="identity-card-shell">' +
        '<div class="identity-card-avatar">' +
          '<div class="identity-card-avatar-inner">' +
            escHtml((data.identityMeta.label || 'Unknown').charAt(0)) +
          '</div>' +
        '</div>' +
        '<div class="identity-card-copy">' +
          '<div class="identity-card-name">' + escHtml(data.identityMeta.label || 'Unknown') + '</div>' +
          '<div class="identity-card-desc">' +
            escHtml(data.identityMeta.description || 'Keep playing to reveal your identity pattern.') +
          '</div>' +
        '</div>' +
      '</div>' +
    '</section>'
  );
}

function renderIdentityBacklogOutlook(data) {
  var changeLabel = data.netBacklogChange > 0
    ? '+' + data.netBacklogChange
    : String(data.netBacklogChange);

  var paceCopy = data.estimatedClearMonths === null
    ? 'No estimate yet — complete more games this period to establish a pace.'
    : 'At your current pace, backlog zero is approximately ' + data.estimatedClearLabel + ' away.';

  return (
    '<section class="identity-section">' +
      '<div class="identity-section-title">Backlog Outlook</div>' +

      '<div class="identity-highlights-grid">' +
        renderIdentityHighlightCard('Backlog Start', String(data.backlogStartCount), 'At start of period') +
        renderIdentityHighlightCard('Current Backlog', String(data.backlogCurrentCount), 'Where you are now') +
        renderIdentityHighlightCard('Games Added', String(data.gamesAddedCount), 'Added this period') +
        renderIdentityHighlightCard('New Games Played', String(data.newPlayedCount), 'Touched this period') +
        renderIdentityHighlightCard('Games Completed', String(data.gamesCompletedCount), 'Finished this period') +
        renderIdentityHighlightCard('Net Change', changeLabel, data.netBacklogChange > 0 ? 'Backlog grew' : data.netBacklogChange < 0 ? 'Backlog shrank' : 'No change') +
      '</div>' +

      '<div class="identity-outlook-note">' + escHtml(paceCopy) + '</div>' +
    '</section>'
  );
}

function wrappedStatHero(val, label) {
  return '<div style="text-align:center;padding:0 12px">' +
    '<div style="font-family:\'Syne\',sans-serif;font-size:40px;font-weight:900;color:#fff;line-height:1">' + val + '</div>' +
    '<div style="font-size:10px;color:rgba(255,255,255,0.4);margin-top:6px;letter-spacing:1.5px">' + label + '</div>' +
  '</div>';
}

function wrappedStatBig(val, label, color) {
  return '<div style="text-align:center">' +
    '<div style="font-family:\'Syne\',sans-serif;font-size:36px;font-weight:900;color:' + color + ';line-height:1">' + val + '</div>' +
    '<div style="font-size:10px;color:rgba(255,255,255,0.35);margin-top:5px;text-transform:uppercase;letter-spacing:0.5px">' + label + '</div>' +
  '</div>';
}

function highlightCard(icon, label, value, sub, color) {
  return '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:14px;padding:16px">' +
    '<div style="font-size:18px;margin-bottom:8px">' + icon + '</div>' +
    '<div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">' + label + '</div>' +
    '<div style="font-size:14px;font-weight:800;color:' + color + ';line-height:1.3;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">' + value + '</div>' +
    '<div style="font-size:11px;color:var(--text3)">' + sub + '</div>' +
  '</div>';
}

async function exportLibraryCard() {
  console.log('[Export] exportLibraryCard called');
  var modal = document.getElementById('identityCardModal');
  var card = modal ? modal.querySelector('.identity-card-full') : null;
  console.log('[Export] modal:', modal);
  console.log('[Export] card:', card);

  if (!card) {
    showStatus('Open the full dossier before exporting.', 100);
    setTimeout(hideStatus, 3000);
    return;
  }

  try {
    // Hide buttons before capture
    var closeBtn = document.getElementById('identityCardCloseBtn');
    var exportBtn = document.getElementById('exportLibraryCard');
    var confirm = document.getElementById('exportDossierConfirm');
    if (closeBtn) closeBtn.style.visibility = 'hidden';
    if (exportBtn) exportBtn.style.visibility = 'hidden';
    if (confirm) confirm.style.visibility = 'hidden';

    // Small delay to let the DOM update before capture
    await new Promise(function(r) { setTimeout(r, 200); });

    var rect = card.getBoundingClientRect();
    console.log('[Export] rect:', rect);
    console.log('[Export] calling captureDossier...');
    var result = await window.nexus.app.captureDossier({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      dpr: window.devicePixelRatio || 1
    });
    console.log('[Export] result:', result);

    // Restore buttons after capture
    if (closeBtn) closeBtn.style.visibility = 'visible';
    if (exportBtn) exportBtn.style.visibility = 'visible';
    if (confirm) confirm.style.visibility = 'visible';

    if (result && result.cancelled) return;

    if (result && result.saved) {
      if (confirm) {
        confirm.style.opacity = '1';
        setTimeout(function() { confirm.style.opacity = '0'; }, 3000);
      }
    } else if (result && result.error) {
      showStatus('Export failed: ' + result.error, 100);
      setTimeout(hideStatus, 4000);
    }
  } catch(e) {
    // Restore buttons on error too
    var closeBtn = document.getElementById('identityCardCloseBtn');
    var exportBtn = document.getElementById('exportLibraryCard');
    if (closeBtn) closeBtn.style.visibility = 'visible';
    if (exportBtn) exportBtn.style.visibility = 'visible';
    showStatus('Export failed: ' + e.message, 100);
    setTimeout(hideStatus, 4000);
  }
}

// ════════════════════════════════════════════════════════
// STEAM AUTO SESSION TRACKING
// ════════════════════════════════════════════════════════
var steamPoller        = null;       // setInterval handle
var steamActiveGameId  = null;       // Steam appId currently detected
var steamActiveGame    = null;       // game object from our library
var steamSessionStart  = null;       // Date.now() when game was detected
var steamSessionTicker = null;       // setInterval for presence pip timer

async function initSteamAutoTracking() {
  // Load saved toggle state
  var enabled = await window.nexus.store.get('steamAutoTrack');
  var toggle  = document.getElementById('steamAutoTrackToggle');
  var slider  = document.getElementById('steamAutoTrackSlider');
  if (!toggle) return;

  toggle.checked = !!enabled;
  updateSliderStyle(!!enabled);

  toggle.addEventListener('change', async function() {
    var on = toggle.checked;
    await window.nexus.store.set('steamAutoTrack', on);
    updateSliderStyle(on);
    if (on) startSteamPoller();
    else    stopSteamPoller();
  });

  if (enabled) startSteamPoller();
}

function updateSliderStyle(on) {
  var slider = document.getElementById('steamAutoTrackSlider');
  if (!slider) return;
  slider.style.background = on ? 'var(--steam)' : 'var(--border2)';
  slider.style.setProperty('--slider-thumb', on ? '18px' : '2px');
  // Use a pseudo-element trick via inline style for the knob
  slider.innerHTML = '<span style="position:absolute;height:18px;width:18px;left:' + (on ? '20px' : '2px') + ';bottom:2px;background:#fff;border-radius:50%;transition:0.3s"></span>';
}

function startSteamPoller() {
  if (steamPoller) return; // already running
  var statusEl = document.getElementById('steamAutoTrackStatus');
  if (statusEl) statusEl.textContent = 'Polling every 60s…';
  console.log('[SteamPresence] Poller started');
  pollSteamPresence(); // immediate first check
  steamPoller = setInterval(pollSteamPresence, 60000);
}

function stopSteamPoller() {
  if (steamPoller) { clearInterval(steamPoller); steamPoller = null; }
  if (steamSessionTicker) { clearInterval(steamSessionTicker); steamSessionTicker = null; }
  var statusEl = document.getElementById('steamAutoTrackStatus');
  if (statusEl) statusEl.textContent = 'Not polling';
  // If a game was being tracked, stop its session
  if (steamActiveGame) {
    console.log('[SteamPresence] Poller stopped — ending active session for', steamActiveGame.title);
    finalizeSteamSession();
  }
  hideSteamPresencePip();
  console.log('[SteamPresence] Poller stopped');
}

async function pollSteamPresence() {
  try {
    var result = await window.nexus.steam.getPresence();
    var statusEl = document.getElementById('steamAutoTrackStatus');

    if (result.error) {
      if (statusEl) statusEl.textContent = 'Error: ' + result.error;
      return;
    }

    var nowGameId = result.gameId ? String(result.gameId) : null;

    if (statusEl) {
      var lastPoll = new Date().toLocaleTimeString();
      statusEl.textContent = nowGameId
        ? 'Playing: ' + (result.gameName || nowGameId) + ' · last checked ' + lastPoll
        : 'Not in game · last checked ' + lastPoll;
    }

    // ── Game STARTED ──
    if (nowGameId && nowGameId !== steamActiveGameId) {
      // End any previous session first
      if (steamActiveGame) await finalizeSteamSession();
      // Reset session-scoped dismissals for the new game
      intentProgressionDismissed = new Set();

      // Find matching game in library
      var matchedGame = games.find(function(g) {
        return g.steamAppId && String(g.steamAppId) === nowGameId;
      });

      if (matchedGame) {
        steamActiveGameId = nowGameId;
        steamActiveGame   = matchedGame;
        steamSessionStart = Date.now();
        console.log('[SteamPresence] Detected:', matchedGame.title);
        showSteamPresencePip(matchedGame, result.gameName);
        startSteamSessionTicker();

        // Intent Progression — suggest promoting queue/priority → playnext
        triggerIntentProgression(matchedGame);

        // Momentum boost — write timestamp for scoring engine
        if (matchedGame.intent === 'queue' || matchedGame.intent === 'priority') {
          var now = new Date().toISOString();
          matchedGame.momentumAt = now;
          window.nexus.games.update(matchedGame.id, { momentumAt: now }).catch(function(){});
        }

        // If detail modal is open for this game, sync the manual timer display
        if (currentDetailGame && currentDetailGame.id === matchedGame.id) {
          renderSessionPanel(matchedGame);
        }
      }
    }

    // ── Game STOPPED ──
    if (!nowGameId && steamActiveGameId) {
      await finalizeSteamSession();
    }

  } catch(e) {
    console.warn('[SteamPresence] Poll error:', e.message);
  }
}

function startSteamSessionTicker() {
  if (steamSessionTicker) clearInterval(steamSessionTicker);
  steamSessionTicker = setInterval(function() {
    if (!steamSessionStart) return;
    var elapsed = Math.floor((Date.now() - steamSessionStart) / 1000);
    var h = Math.floor(elapsed / 3600);
    var m = Math.floor((elapsed % 3600) / 60);
    var s = elapsed % 60;
    var timeStr = h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    var pipTimer    = document.getElementById('steamPresenceTimer');
    var bannerTimer = document.getElementById('nowPlayingTimer');
    if (pipTimer)    pipTimer.textContent    = timeStr;
    if (bannerTimer) bannerTimer.textContent = timeStr;
  }, 1000);
}

async function finalizeSteamSession() {
  if (!steamActiveGame || !steamSessionStart) {
    steamActiveGameId = null;
    steamActiveGame   = null;
    steamSessionStart = null;
    hideSteamPresencePip();
    return;
  }

  var elapsed    = Math.floor((Date.now() - steamSessionStart) / 1000);
  var elapsedHrs = elapsed / 3600;
  var game       = steamActiveGame;

  // Reset state before async work
  steamActiveGameId = null;
  steamActiveGame   = null;
  steamSessionStart = null;
  if (steamSessionTicker) { clearInterval(steamSessionTicker); steamSessionTicker = null; }
  hideSteamPresencePip();

  if (elapsed < 60) {
    console.log('[SteamPresence] Session too short (<60s), skipping:', game.title);
    return;
  }

  console.log('[SteamPresence] Session ended for', game.title, '—', Math.round(elapsed/60), 'min');

  // Save session
  var sessions = await window.nexus.store.get('sessions:' + game.id) || [];
  sessions.push({ date: new Date().toISOString(), seconds: elapsed, source: 'steam-auto' });
  if (sessions.length > 100) sessions = sessions.slice(-100);
  await window.nexus.store.set('sessions:' + game.id, sessions);

  // Update playtime and last played
  var newPlaytime = Math.round(((game.playtimeHours || 0) + elapsedHrs) * 10) / 10;
  var updates = {
    lastPlayedAt:  new Date().toISOString(),
    playtimeHours: newPlaytime,
  };
  var idx = games.findIndex(function(g) { return g.id === game.id; });
  if (idx !== -1) Object.assign(games[idx], updates);
  await window.nexus.games.update(game.id, updates);

  // Refresh detail if it's open for this game
  if (currentDetailGame && currentDetailGame.id === game.id) {
    Object.assign(currentDetailGame, updates);
    var ptEl = document.getElementById('gameDetailPlaytime');
    if (ptEl) ptEl.textContent = newPlaytime + ' hours played';
    document.getElementById('sessionLastPlayedDate').textContent = 'Today';
  }

  var mins = Math.floor(elapsed / 60);
  var hrs  = Math.floor(elapsed / 3600);
  var timeStr = hrs > 0 ? hrs + 'h ' + (mins % 60) + 'm' : mins + 'm';
  showStatus('🎮 Steam session saved — ' + timeStr + ' logged for ' + game.title, 100);
  setTimeout(hideStatus, 5000);
  renderAll();

  // Offer intent completion path if session was substantial (10+ min)
  if (elapsed >= 600) {
    setTimeout(function() { showSessionEndToast(game); }, 1500);
  }
}

function showSteamPresencePip(game, steamName) {
  var title = game.title || steamName || 'Unknown Game';

  var pip    = document.getElementById('steamPresencePip');
  var nameEl = document.getElementById('steamPresenceName');
  if (pip)    { pip.style.display = 'block'; }
  if (nameEl) nameEl.textContent = title;

  // Main page banner (legacy — keep for backward compat)
  var banner      = document.getElementById('nowPlayingBanner');
  var bannerTitle = document.getElementById('nowPlayingTitle');
  var bannerCover = document.getElementById('nowPlayingCover');
  if (banner) {
    banner.style.display = 'block';
    banner.onclick = function() { if (steamActiveGame) openGameDetail(steamActiveGame); };
  }
  if (bannerTitle) bannerTitle.textContent = title;
  if (bannerCover) {
    var coverUrl = coverCache[game.id] || coverCache[String(game.id)];
    bannerCover.innerHTML = coverUrl
      ? '<img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover">'
      : '<div style="width:100%;height:100%;background:linear-gradient(135deg,' + COVER_PALETTES[(game.pal||0)%COVER_PALETTES.length].join(',') + ')"></div>';
  }
}

function hideSteamPresencePip() {
  var pip    = document.getElementById('steamPresencePip');
  var banner = document.getElementById('nowPlayingBanner');
  if (pip)    pip.style.display    = 'none';
  if (banner) banner.style.display = 'none';
}

// ════════════════════════════════════════════════════════
// STEAM PRESENCE POLLER — auto session tracking
// ════════════════════════════════════════════════════════
var presencePoller      = null;
var presenceGameId      = null;   // Steam appId currently detected
var presenceGameTitle   = null;
var presenceSessionStart = null;
var presenceIgnoreList  = new Set(); // appIds to ignore this session
var presenceTimerInterval = null;
var autoSessionEnabled  = false;

async function initAutoSessionTracking() {
  var enabled = await window.nexus.store.get('autoSessionTracking');
  autoSessionEnabled = !!enabled;
  var toggle = document.getElementById('autoSessionToggle');
  if (toggle) {
    toggle.checked = autoSessionEnabled;
    updateAutoSessionToggleUI(autoSessionEnabled);
    toggle.addEventListener('change', async function() {
      autoSessionEnabled = toggle.checked;
      await window.nexus.store.set('autoSessionTracking', autoSessionEnabled);
      updateAutoSessionToggleUI(autoSessionEnabled);
      if (autoSessionEnabled) {
        startPresencePoller();
      } else {
        stopPresencePoller();
      }
    });
  }

  // Tooltip hover
  var helpBtn = document.getElementById('autoSessionHelpBtn');
  var tooltip = document.getElementById('autoSessionTooltip');
  if (helpBtn && tooltip) {
    helpBtn.addEventListener('mouseenter', function() { tooltip.style.display = 'block'; });
    helpBtn.addEventListener('mouseleave', function() { tooltip.style.display = 'none'; });
    tooltip.addEventListener('mouseenter', function() { tooltip.style.display = 'block'; });
    tooltip.addEventListener('mouseleave', function() { tooltip.style.display = 'none'; });
  }
  if (autoSessionEnabled) {
    setTimeout(startPresencePoller, 10000); // start 10s after init
  }

  // Wire presence Ignore button
  var ignoreBtn = document.getElementById('steamPresenceIgnore');
  if (ignoreBtn) ignoreBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (presenceGameId) presenceIgnoreList.add(String(presenceGameId));
    stopPresenceSession(false);
    document.getElementById('steamPresencePip').style.display = 'none';
  });

  // Also check recently played on startup to catch offline sessions
  if (autoSessionEnabled) {
    setTimeout(checkRecentlyPlayedDelta, 20000);
  }
}

function updateAutoSessionToggleUI(enabled) {
  var slider = document.getElementById('autoSessionSlider');
  var thumb  = document.getElementById('autoSessionThumb');
  var status = document.getElementById('steamPresenceStatus');
  if (slider) slider.style.background = enabled ? 'var(--steam)' : 'var(--border2)';
  if (thumb)  thumb.style.transform   = enabled ? 'translateX(16px)' : 'translateX(0)';
  if (status) status.textContent      = enabled ? 'Polling' : 'Off';
  // Update sidebar indicator
  var indicator = document.getElementById('sessionTrackerIndicator');
  var dot       = document.getElementById('sessionTrackerDot');
  var label     = document.getElementById('sessionTrackerLabel');
  if (indicator) indicator.style.display = 'flex';
  if (dot)   dot.style.background   = enabled ? '#4ade80' : 'var(--border2)';
  if (label) label.textContent      = enabled ? 'AUTO ON' : 'AUTO OFF';
  if (label) label.style.color      = enabled ? '#4ade80' : 'var(--text3)';
}

function startPresencePoller() {
  if (presencePoller) return; // already running
  console.log('[Nexus] Steam presence poller started');
  presencePoller = setInterval(pollSteamPresence, 60000); // every 60s
  pollSteamPresence(); // immediate first check
}

function stopPresencePoller() {
  if (presencePoller) { clearInterval(presencePoller); presencePoller = null; }
  stopPresenceSession(true);
  document.getElementById('steamPresencePip').style.display = 'none';
  console.log('[Nexus] Steam presence poller stopped');
}

async function pollSteamPresence() {
  try {
    var result = await window.nexus.steam.getPresence();
    if (result.error) {
      if (result.error === 'no_credentials') stopPresencePoller();
      return;
    }

    var currentAppId = result.gameId ? String(result.gameId) : null;

    if (currentAppId && !presenceIgnoreList.has(currentAppId)) {
      // A game is running
      if (currentAppId !== presenceGameId) {
        // New game detected — stop previous if any, start new session
        if (presenceGameId) await stopPresenceSession(true);
        presenceGameId     = currentAppId;
        presenceGameTitle  = result.gameName || 'Unknown Game';
        presenceSessionStart = Date.now();
        showPresencePip(presenceGameTitle);
        console.log('[Nexus] Auto-session started:', presenceGameTitle);
      }
      // Update running timer
      updatePresenceTimer();
    } else if (!currentAppId && presenceGameId) {
      // Game closed — save session
      await stopPresenceSession(true);
    }

    // Update status indicator
    var statusEl = document.getElementById('steamPresenceStatus');
    if (statusEl && autoSessionEnabled) {
      statusEl.textContent = currentAppId ? '🟢 Active' : '🔵 Watching';
    }

  } catch(e) {
    console.warn('[Presence] Poll error:', e.message);
  }
}

function showPresencePip(title) {
  var pip  = document.getElementById('steamPresencePip');
  var name = document.getElementById('steamPresenceGame');
  var dot  = document.getElementById('steamPresenceDot');
  if (!pip) return;
  if (name) name.textContent = title;
  if (dot)  dot.style.background = '#4ade80';
  pip.style.display = 'block';

  // Pulse animation on first show
  pip.style.animation = 'none';
  pip.offsetHeight; // reflow
  pip.style.boxShadow = '0 0 0 0 rgba(74,222,128,0.4)';

  // Start live timer
  if (presenceTimerInterval) clearInterval(presenceTimerInterval);
  presenceTimerInterval = setInterval(updatePresenceTimer, 1000);
}

function updatePresenceTimer() {
  var timerEl = document.getElementById('steamPresenceTimer');
  if (!timerEl || !presenceSessionStart) return;
  var elapsed = Math.floor((Date.now() - presenceSessionStart) / 1000);
  var h = Math.floor(elapsed / 3600);
  var m = Math.floor((elapsed % 3600) / 60);
  var s = elapsed % 60;
  timerEl.textContent = h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
}

async function stopPresenceSession(save) {
  if (presenceTimerInterval) { clearInterval(presenceTimerInterval); presenceTimerInterval = null; }

  if (save && presenceGameId && presenceSessionStart) {
    var elapsed = Math.floor((Date.now() - presenceSessionStart) / 1000);
    if (elapsed >= 60) { // only save sessions over 1 minute
      var game = games.find(function(g) { return String(g.steamAppId) === String(presenceGameId); });
      if (game) {
        var sessions = await window.nexus.store.get('sessions:' + game.id) || [];
        sessions.push({ date: new Date().toISOString(), seconds: elapsed, auto: true });
        if (sessions.length > 100) sessions = sessions.slice(-100);
        await window.nexus.store.set('sessions:' + game.id, sessions);

        var elapsedHrs  = elapsed / 3600;
        var newPlaytime = Math.round(((game.playtimeHours || 0) + elapsedHrs) * 10) / 10;
        var updates = { lastPlayedAt: new Date().toISOString(), playtimeHours: newPlaytime };
        var idx = games.findIndex(function(g) { return g.id === game.id; });
        if (idx !== -1) Object.assign(games[idx], updates);
        await window.nexus.games.update(game.id, updates);

        var mins = Math.round(elapsed / 60);
        showStatus('✓ Auto-logged ' + (elapsed >= 3600
          ? Math.floor(elapsed/3600) + 'h ' + Math.floor((elapsed%3600)/60) + 'm'
          : mins + 'm') + ' for ' + game.title, 100);
        setTimeout(hideStatus, 5000);
        renderAll();
      }
    }
  }

  // Reset state
  presenceGameId       = null;
  presenceGameTitle    = null;
  presenceSessionStart = null;

  // Hide pip after a short delay
  setTimeout(function() {
    var pip = document.getElementById('steamPresencePip');
    if (pip && !presenceGameId) pip.style.display = 'none';
  }, 2000);
}

// ── RECENTLY PLAYED DELTA — catch sessions from outside the app ──
async function checkRecentlyPlayedDelta() {
  try {
    var recent = await window.nexus.steam.getRecentlyPlayed();
    if (!recent || recent.error || !recent.length) return;

    var lastKnown = await window.nexus.store.get('steamPlaytimeSnapshot') || {};
    var updates   = [];
    var now       = new Date().toISOString();

    for (var i = 0; i < recent.length; i++) {
      var r = recent[i];
      var appId = String(r.appid);
      var currentMins = r.playtime_forever || 0;
      var prevMins    = lastKnown[appId] || null;

      if (prevMins !== null && currentMins > prevMins) {
        var diffMins = currentMins - prevMins;
        if (diffMins >= 1) {
          // Find the game in library
          var game = games.find(function(g) { return String(g.steamAppId) === appId; });
          if (game) {
            // Log as an offline session
            var sessions = await window.nexus.store.get('sessions:' + game.id) || [];
            sessions.push({ date: now, seconds: diffMins * 60, auto: true, offline: true });
            if (sessions.length > 100) sessions = sessions.slice(-100);
            await window.nexus.store.set('sessions:' + game.id, sessions);

            // Update last played
            var idx = games.findIndex(function(g) { return g.id === game.id; });
            if (idx !== -1 && !games[idx].lastPlayedAt) {
              games[idx].lastPlayedAt = now;
              await window.nexus.games.update(game.id, { lastPlayedAt: now });
            }
          }
        }
      }
      lastKnown[appId] = currentMins;
    }

    await window.nexus.store.set('steamPlaytimeSnapshot', lastKnown);
    console.log('[Nexus] Playtime snapshot updated for', recent.length, 'recent games');
  } catch(e) {
    console.warn('[RecentlyPlayed] Delta check failed:', e.message);
  }
}

// ════════════════════════════════════════════════════════
// INTENT PROGRESSION — Steam session → playnext promotion
// ════════════════════════════════════════════════════════

var intentProgressionDismissed = new Set(); // session-scoped — gameId → ignored

function triggerIntentProgression(game) {
  // Only fire for queue/priority games that aren't finished/not-for-me
  if (!game.intent || (game.intent !== 'queue' && game.intent !== 'priority')) return;
  if (game.status === 'finished' || game.status === 'not-for-me') return;
  if (game.intent === 'playnext') return; // already promoted
  if (intentProgressionDismissed.has(game.id)) return; // already dismissed this session

  // Small delay so it doesn't fire instantly on app load
  setTimeout(function() {
    showIntentProgressionToast(game);
  }, 3000);
}

function showIntentProgressionToast(game) {
  // Remove any existing toast
  var existing = document.getElementById('intentProgressionToast');
  if (existing) existing.remove();

  var cUrl = coverCache[game.id] || coverCache[String(game.id)];
  var pal  = COVER_PALETTES[(game.pal||0) % COVER_PALETTES.length];

  var toast = document.createElement('div');
  toast.id = 'intentProgressionToast';
  toast.style.cssText = [
    'position:fixed',
    'bottom:24px',
    'right:24px',
    'z-index:9999',
    'background:var(--surface2)',
    'border:1px solid var(--border2)',
    'border-radius:12px',
    'padding:14px 16px',
    'width:280px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.4)',
    'animation:slideInToast 0.25s ease',
    'display:flex',
    'flex-direction:column',
    'gap:10px'
  ].join(';');

  toast.innerHTML =
    '<style>@keyframes slideInToast{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}</style>' +
    '<div style="display:flex;align-items:center;gap:10px">' +
      '<div style="width:36px;height:36px;border-radius:6px;overflow:hidden;flex-shrink:0;background:linear-gradient(135deg,' + pal[0] + ',' + pal[1] + ')">' +
        (cUrl ? '<img src="' + cUrl + '" style="width:100%;height:100%;object-fit:cover">' : '') +
      '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:11px;color:var(--text3);margin-bottom:2px">You\'re playing</div>' +
        '<div style="font-size:13px;font-weight:800;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(game.title) + '</div>' +
      '</div>' +
      '<button onclick="document.getElementById(\'intentProgressionToast\').remove()" ' +
        'style="flex-shrink:0;background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;padding:0;line-height:1">×</button>' +
    '</div>' +
    '<div style="font-size:11px;color:var(--text2)">Promote to <strong style="color:#4ade80">▶ Play Next</strong>?</div>' +
    '<div style="display:flex;gap:8px">' +
      '<button onclick="intentProgressionPromote(' + game.id + ')" ' +
        'style="flex:1;background:var(--accent);border:none;color:#fff;font-size:11px;font-weight:700;padding:7px 0;border-radius:7px;cursor:pointer">Promote</button>' +
      '<button onclick="intentProgressionIgnore(' + game.id + ')" ' +
        'style="flex:1;background:none;border:1px solid var(--border);color:var(--text3);font-size:11px;padding:7px 0;border-radius:7px;cursor:pointer">Ignore</button>' +
    '</div>';

  document.body.appendChild(toast);

  // Auto-dismiss after 8 seconds
  var autoDismiss = setTimeout(function() {
    var t = document.getElementById('intentProgressionToast');
    if (t) { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(function() { if (t.parentNode) t.remove(); }, 300); }
  }, 8000);
  toast._autoDismiss = autoDismiss;
}

window.intentProgressionPromote = async function(gameId) {
  var toast = document.getElementById('intentProgressionToast');
  if (toast) { clearTimeout(toast._autoDismiss); toast.remove(); }

  var g = games.find(function(g) { return g.id === gameId; });
  if (!g) return;
  g.intent = 'playnext';
  await window.nexus.games.update(gameId, { intent: 'playnext' });
  renderAll();
  showStatus('▶ ' + g.title + ' promoted to Play Next', 100);
  setTimeout(hideStatus, 2500);
};

window.intentProgressionIgnore = function(gameId) {
  var toast = document.getElementById('intentProgressionToast');
  if (toast) { clearTimeout(toast._autoDismiss); toast.remove(); }
  intentProgressionDismissed.add(gameId);
};

// ════════════════════════════════════════════════════════
// FREE GAMES TRACKER (Epic Games Store)
// ════════════════════════════════════════════════════════
async function renderFreeGamesPage() {
  var el = document.getElementById('freeGamesContent');
  if (!el) return;

  // Load claimed set
  var claimedRaw = await window.nexus.store.get('claimedFreeGames').catch(function(){return null;});
  var claimed = new Set(Array.isArray(claimedRaw) ? claimedRaw : []);

  function updatePip(cards) {
    var unclaimed = cards.filter(function(c) { return !claimed.has(c.title); }).length;
    var pip = document.getElementById('navFreeGamesPip');
    if (!pip) return;
    if (unclaimed > 0) { pip.textContent = unclaimed; pip.style.display = 'flex'; }
    else pip.style.display = 'none';
  }

  function saveClaimed(allCards) {
    window.nexus.store.set('claimedFreeGames', [...claimed]).catch(function(){});
    updatePip(allCards);
  }

  function buildCard(g, allCards) {
    var isClaimed = claimed.has(g.title);
    var displayTitle = g.title
      .replace(/\s*\(Epic Games?\)\s*Giveaway/gi, '')
      .replace(/\s*\([^)]*\)\s*Giveaway/gi, '')
      .replace(/\s*Giveaway$/gi, '')
      .trim();
    var card = document.createElement('div');
    card.className = 'free-game-card' + (isClaimed ? ' is-claimed' : '');
    card.dataset.title = g.title;

    var platformBadge = (g.platform && g.platform !== 'Epic') ? '<span class="free-platform-badge">' + escHtml(g.platform) + '</span>' : '';
    var typeBadge = '';
    var worth = g.worth && g.worth !== 'N/A' ? '<span class="free-worth">Was ' + escHtml(String(g.worth)) + '</span>' : '';
    var endText = g.endDate ? 'Until ' + new Date(g.endDate).toLocaleDateString('en-US', {month:'short',day:'numeric'}) : (g.status === 'Active' ? 'Active now' : '');

    card.innerHTML =
      '<div class="free-card-img">' +
        (g.imageUrl ? '<img src="' + escHtml(g.imageUrl) + '" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.style.background=\'var(--surface3)\';this.remove()">' : '') +
        (isClaimed ? '<div class="free-claimed-badge">CLAIMED ✓</div>' : '') +
        '<div class="free-card-badges">' + platformBadge + typeBadge + '</div>' +
      '</div>' +
      '<div class="free-card-body">' +
        '<div class="free-card-title' + (isClaimed ? ' is-claimed' : '') + '">' + escHtml(displayTitle) + '</div>' +
        '<div class="free-card-footer">' +
          '<label class="free-claim-label' + (isClaimed ? ' claimed' : '') + '">' +
            '<input type="checkbox" class="claim-checkbox" ' + (isClaimed ? 'checked' : '') + ' style="accent-color:#4ade80;cursor:pointer"> ' +
            (isClaimed ? '✓ Claimed' : 'Claimed?') +
          '</label>' +
          '<div class="free-card-right">' +
            (worth ? worth + ' · ' : '') +
            (endText ? '<span class="free-end-text">' + endText + '</span>' : '') +
            (g.url ? '<a href="#" class="free-get-link" data-url="' + escHtml(g.url) + '">Get →</a>' : '') +
          '</div>' +
        '</div>' +
      '</div>';

    // Wire checkbox
    var cb = card.querySelector('.claim-checkbox');
    cb.addEventListener('change', function() {
      if (cb.checked) claimed.add(g.title); else claimed.delete(g.title);
      card.classList.toggle('is-claimed', cb.checked);
      card.querySelector('.free-card-title').classList.toggle('is-claimed', cb.checked);
      var lbl = card.querySelector('.free-claim-label');
      if (lbl) { lbl.classList.toggle('claimed', cb.checked); lbl.lastChild.textContent = cb.checked ? ' ✓ Claimed' : ' Claimed?'; }
      var badge = card.querySelector('.free-claimed-badge');
      if (cb.checked && !badge) {
        var b = document.createElement('div'); b.className = 'free-claimed-badge'; b.textContent = 'CLAIMED ✓';
        card.querySelector('.free-card-img').appendChild(b);
      } else if (!cb.checked && badge) badge.remove();
      saveClaimed(allCards);
    });

    var getLink = card.querySelector('.free-get-link');
    if (getLink) {
      var linkUrl = getLink.dataset.url;
      getLink.addEventListener('click', function(e) { e.preventDefault(); if (linkUrl) window.open(linkUrl, '_blank'); });
    }
    // Make the whole card image clickable too
    if (g.url) {
      var cardImg = card.querySelector('.free-card-img');
      if (cardImg) {
        cardImg.style.cursor = 'pointer';
        var cardUrl = g.url;
        cardImg.addEventListener('click', function() { window.open(cardUrl, '_blank'); });
      }
    }

    return card;
  }

  function renderSection(title, titleColor, games, allCards, container) {
    if (!games.length) return;
    var header = document.createElement('div');
    header.className = 'free-section-label';
    header.style.color = titleColor;
    header.textContent = title;
    container.appendChild(header);
    var grid = document.createElement('div');
    grid.className = 'free-grid';
    games.forEach(function(g) { grid.appendChild(buildCard(g, allCards)); });
    container.appendChild(grid);
  }

  // Tab state
  var currentTab = 'epic';

  function renderTabContent(tab) {
    var content = el.querySelector('#freeTabContent');
    content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">Loading…</div>';

    if (tab === 'epic') {
      window.nexus.epic.freeGames().then(function(list) {
        var freeNow      = (list || []).filter(function(g) { return g.isFree; });
        var freeUpcoming = (list || []).filter(function(g) { return g.isUpcoming; });
        var allCards     = freeNow.map(function(g) { return {title:g.title}; });
        updatePip(allCards);
        content.innerHTML = '';
        if (!freeNow.length && !freeUpcoming.length) {
          content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">No Epic free games right now.</div>';
          return;
        }
        var epicItems = freeNow.map(function(g) { return {
          title: g.title, description: g.description,
          imageUrl: g.imageUrl, url: g.pageSlug ? 'https://store.epicgames.com/en-US/p/'+g.pageSlug : 'https://store.epicgames.com/en-US/free-games',
          platform: 'Epic', type: 'Game',
          endDate: g.endDate, status: 'Active', worth: null
        }; });
        var upcomingItems = freeUpcoming.map(function(g) { return {
          title: g.title, description: g.description,
          imageUrl: g.imageUrl, url: 'https://store.epicgames.com/en-US/free-games',
          platform: 'Epic', type: 'Game',
          endDate: g.endDate, status: 'Upcoming', worth: null
        }; });
        var all = epicItems.concat(upcomingItems);
        renderSection('🎁 Free Right Now', '#4ade80', epicItems, all, content);
        if (upcomingItems.length) {
          var spacer = document.createElement('div'); spacer.style.height = '20px'; content.appendChild(spacer);
          renderSection('📅 Coming Up Next', '#fb923c', upcomingItems, all, content);
        }
      }).catch(function(e) {
        content.innerHTML = '<div style="text-align:center;padding:40px;color:#f87171">Epic API error: ' + escHtml(e.message) + '</div>';
      });
    } else {
      // Try multiple free game APIs — GamerPower if accessible, fall back to Steam F2P data
      var typeParam = tab === 'dlc' ? 'dlc' : tab === 'loot' ? 'loot' : 'game';

      // Use GamerPower via IPC (main process bypasses CSP)
      function tryGamerPower() {
        return window.nexus.free.giveaways(tab);
      }

      function showSteamFreeToPlay() {
        // Build from library: filter free-to-play games the user has
        var f2pGames = games.filter(function(g) {
          var genres = g.genres || [];
          return genres.includes('Free to Play') || (g.genre || '').toLowerCase().includes('free');
        });
        content.innerHTML = '';
        if (!f2pGames.length) {
          content.innerHTML =
            '<div style="text-align:center;padding:40px;color:var(--text3)">' +
            '<div style="font-size:28px;margin-bottom:12px">🌐</div>' +
            '<div style="font-size:13px;font-weight:700;margin-bottom:8px">External API unavailable</div>' +
            '<div style="font-size:11px;max-width:320px;margin:0 auto;line-height:1.7">The GamerPower API is blocked in this environment.<br>' +
            'Free-to-play games from your library are shown below.<br>' +
            '<a href="#" onclick="window.open(\'https://www.gamerpower.com\',\'_blank\');return false;" style="color:var(--steam)">Browse GamerPower directly →</a></div>' +
            '</div>';
          return;
        }
        var header = document.createElement('div');
        header.className = 'free-section-label'; header.style.color = '#4a9eed';
        header.textContent = '🎮 Free to Play in Your Library';
        content.appendChild(header);
        var grid = document.createElement('div'); grid.className = 'free-grid';
        var allCards = f2pGames.map(function(g){return{title:g.title};});
        f2pGames.forEach(function(g) {
          var cUrl = coverCache[g.id] || coverCache[String(g.id)];
          var pal  = COVER_PALETTES[(g.pal||0)%COVER_PALETTES.length];
          var item = {
            title: g.title, description: g.description || '',
            imageUrl: cUrl, url: g.steamAppId ? 'https://store.steampowered.com/app/' + g.steamAppId : null,
            platform: 'Steam', type: 'Free to Play', endDate: null, status: 'Active', worth: null
          };
          grid.appendChild(buildCard(item, allCards));
        });
        content.appendChild(grid);
        var note = document.createElement('div');
        note.style.cssText = 'text-align:center;padding:16px;font-size:11px;color:var(--text3)';
        note.innerHTML = 'Showing Free to Play games from your library · <a href="#" onclick="window.open(\'https://www.gamerpower.com\',\'_blank\');return false;" style="color:var(--steam)">Browse more at GamerPower →</a>';
        content.appendChild(note);
      }

      tryGamerPower().then(function(data) {
        if (!Array.isArray(data) || !data.length) { showSteamFreeToPlay(); return; }
        // IPC handler already maps to { title, description, imageUrl, url, platform, type, endDate, status, worth }
        var items = data;
        var all = items.map(function(g){return{title:g.title};});
        updatePip(all);
        content.innerHTML = '';
        var active  = items.filter(function(g){return g.status==='Active';});
        var ending  = items.filter(function(g){return g.status!=='Active';});
        renderSection('🎮 Active Giveaways', '#4ade80', active, all, content);
        if (ending.length) {
          var s=document.createElement('div'); s.style.height='16px'; content.appendChild(s);
          renderSection('⏳ Ending Soon', '#fb923c', ending.slice(0,8), all, content);
        }
      }).catch(function() { showSteamFreeToPlay(); });
    }
  }

    // Build page + tabs UI
  el.innerHTML =
  '<div class="free-tabs">' +
    '<button class="free-tab active" data-tab="epic">🟡 Epic Free Games</button>' +
    '<button class="free-tab" data-tab="steam">🔵 PC Giveaways</button>' +
    '<button class="free-tab" data-tab="loot">🏆 Free DLC</button>' +
  '</div>' +

  '<div id="freeTabContent" style="margin-top:16px"></div>';

  el.querySelectorAll('.free-tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      el.querySelectorAll('.free-tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      renderTabContent(currentTab);
    });
  });

  renderTabContent('epic');

  // Brand footer
  var footerEl = document.createElement('div');
  footerEl.innerHTML = BRAND_FOOTER_HTML;
  el.appendChild(footerEl.firstChild);
}


// Check free games badge on startup
async function checkFreeGamesBadge() {
  try {
    var games = await window.nexus.epic.freeGames();
    var freeNow = (games || []).filter(function(g) { return g.isFree; });
    var pip = document.getElementById('navFreeGamesPip');
    if (pip && freeNow.length > 0) {
      pip.textContent   = freeNow.length;
      pip.style.display = 'flex';
    }
  } catch(e) {}
}

// ════════════════════════════════════════════════════════
// EXPANDED PRICE HISTORY (full modal from wishlist card)
// ════════════════════════════════════════════════════════
function showPriceHistory(wishItem) {
  var history = wishItem.priceHistory || [];
  if (history.length < 2) {
    alert('Not enough price data yet. Check prices a few more times to build history.');
    return;
  }

  var prices = history.map(function(h) { return h.price; });
  var dates  = history.map(function(h) { return h.date; });
  var min = Math.min.apply(null, prices);
  var max = Math.max.apply(null, prices);
  var range = max - min || 1;
  var W = 420, H = 120, pad = 16;

  var pts = prices.map(function(p, i) {
    var x = pad + (i / (prices.length - 1)) * (W - pad*2);
    var y = pad + (1 - (p - min) / range) * (H - pad*2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');

  var trend = prices[prices.length-1] < prices[0] ? '#4ade80' : prices[prices.length-1] > prices[0] ? '#f87171' : '#7fc8f8';

  // Fill path for area under line
  var first = pts.split(' ')[0];
  var last  = pts.split(' ').slice(-1)[0];
  var fillPts = pts + ' ' + last.split(',')[0] + ',' + (H-pad) + ' ' + pad + ',' + (H-pad) + ' ' + first;

  // Build overlay
  var existing = document.getElementById('priceHistoryOverlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'priceHistoryOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center';
  overlay.innerHTML =
    '<div style="background:var(--surface2);border:1px solid var(--border2);border-radius:16px;padding:24px;min-width:480px;max-width:90vw">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
        '<div>' +
          '<div style="font-size:15px;font-weight:800;color:var(--text)">' + escHtml(wishItem.title) + '</div>' +
          '<div style="font-size:11px;color:var(--text3);margin-top:2px">' + history.length + ' price records · Low $' + min.toFixed(2) + ' · High $' + max.toFixed(2) + '</div>' +
        '</div>' +
        '<button onclick="document.getElementById(\'priceHistoryOverlay\').remove()" style="background:none;border:none;color:var(--text3);font-size:20px;cursor:pointer;padding:4px 8px">×</button>' +
      '</div>' +
      '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto">' +
        '<polygon points="' + fillPts + '" fill="' + trend + '" opacity="0.08"/>' +
        '<polyline points="' + pts + '" fill="none" stroke="' + trend + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
        prices.map(function(p, i) {
          var x = pad + (i / (prices.length - 1)) * (W - pad*2);
          var y = pad + (1 - (p - min) / range) * (H - pad*2);
          return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3" fill="' + trend + '"><title>' + dates[i] + ': $' + p.toFixed(2) + '</title></circle>';
        }).join('') +
        // Y axis labels
        '<text x="' + (W-pad+2) + '" y="' + (pad+4) + '" font-size="9" fill="var(--text3)" text-anchor="start">$' + max.toFixed(0) + '</text>' +
        '<text x="' + (W-pad+2) + '" y="' + (H-pad+4) + '" font-size="9" fill="var(--text3)" text-anchor="start">$' + min.toFixed(0) + '</text>' +
      '</svg>' +
      '<div style="display:flex;justify-content:space-between;margin-top:8px">' +
        '<span style="font-size:10px;color:var(--text3)">' + dates[0] + '</span>' +
        '<span style="font-size:12px;font-weight:800;color:' + trend + '">Current: $' + prices[prices.length-1].toFixed(2) + '</span>' +
        '<span style="font-size:10px;color:var(--text3)">' + dates[dates.length-1] + '</span>' +
      '</div>' +
      // Last 10 records table
      '<div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px">' +
        '<div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Recent History</div>' +
        history.slice(-10).reverse().map(function(h) {
          return '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:11px;border-bottom:1px solid var(--border);color:var(--text2)">' +
            '<span>' + h.date + '</span><span style="font-weight:700;color:var(--text)">$' + h.price.toFixed(2) + '</span>' +
          '</div>';
        }).join('') +
      '</div>' +
    '</div>';
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ── BACKLOG BURN-DOWN ──
function burnDownSection(allSessions) {
  var backlog = games.filter(function(g) { return !g.gpCatalog && !(g.playtimeHours > 0) && g.status !== 'not-for-me' && g.status !== 'finished'; });
  if (!backlog.length) return '';

  // Average session length from history
  var avgSessionSecs = allSessions.length
    ? Math.max(60, allSessions.reduce(function(t,s) { return t + Math.max(0, s.seconds); }, 0) / allSessions.length)
    : 2 * 3600; // default 2h if no history

  // Sessions per week from last 4 weeks
  var fourWeeksAgo = Date.now() - 28 * 24 * 60 * 60 * 1000;
  var recentSessions = allSessions.filter(function(s) { return s.date.getTime() > fourWeeksAgo; });
  var sessionsPerWeek = recentSessions.length / 4 || 1;

  // Estimate hours to clear backlog (rough: 15h avg per game)
  var avgHrsPerGame   = 15;
  var totalBacklogHrs = Math.max(0, backlog.length * avgHrsPerGame);
  console.log('[BurnDown] backlog.length:', backlog.length, 'totalBacklogHrs:', totalBacklogHrs, 'sample playtimes:', backlog.slice(0,5).map(function(g){ return g.title + ':' + g.playtimeHours; }));
  var hrsPerWeek      = (sessionsPerWeek * avgSessionSecs) / 3600;
  var weeksToFinish   = hrsPerWeek > 0 ? Math.round(totalBacklogHrs / hrsPerWeek) : null;
  var yearsToFinish   = weeksToFinish ? (weeksToFinish / 52).toFixed(1) : null;

  // How many games completed per month recently
  var completedRecent = games.filter(function(g) {
    return g.status === 'finished' && g.lastPlayedAt &&
      new Date(g.lastPlayedAt).getTime() > fourWeeksAgo;
  }).length;
  var completionsPerMonth = Math.round(completedRecent / 1);

  return '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">' +
      '<div style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:1px">📚 Backlog Burn-Down</div>' +
      '<button class="settings-btn" style="font-size:10px;padding:4px 10px" onclick="openRandomPicker()">🎲 Pick One Now</button>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">' +
      statMini(backlog.length, 'In Backlog', COLOR.backlog) +
      statMini(Math.round(totalBacklogHrs).toLocaleString('en-US') + 'h', 'Est. Total', COLOR.backlog) +
      statMini(weeksToFinish ? (weeksToFinish > 104 ? yearsToFinish + ' yrs' : weeksToFinish + ' wks') : '?', 'At Your Pace', COLOR.error) +
    '</div>' +
    (weeksToFinish ? '<div style="font-size:11px;color:var(--text3);line-height:1.6">' +
      'At <strong style="color:var(--text2)">' + hrsPerWeek.toFixed(1) + 'h/week</strong> (' +
      sessionsPerWeek.toFixed(1) + ' sessions · ' + Math.round(avgSessionSecs/60) + 'min avg), ' +
      'clearing your backlog would take <strong style="color:#fb923c">' +
      (weeksToFinish > 104 ? yearsToFinish + ' years' : weeksToFinish + ' weeks') +
      '</strong>.' +
      (completionsPerMonth > 0 ? ' You finished <strong style="color:#4ade80">' + completionsPerMonth + ' game' + (completionsPerMonth !== 1 ? 's' : '') + '</strong> in the last month.' : '') +
    '</div>' : '<div style="font-size:11px;color:var(--text3)">Start logging sessions to see your burn-down estimate.</div>') +
    // Mini backlog list (top 5 by rating/genre match)
    '<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">' +
      '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Next Up</div>' +
      backlog.slice(0, 5).map(function(g) {
        var cover = coverCache[g.id] || coverCache[String(g.id)];
        return '<div class="session-history-row">' +
          (cover ? '<img src="' + cover + '" style="width:24px;height:24px;border-radius:3px;object-fit:cover;margin-right:6px">'
                 : '<div style="width:24px;height:24px;border-radius:3px;background:var(--border);margin-right:6px;flex-shrink:0"></div>') +
          '<span style="flex:1">' + escHtml(g.title) + '</span>' +
          (g.userRating ? '<span style="color:#facc15;font-size:10px">' + g.userRating + '/10</span>' : '') +
          (g.metacriticScore ? '<span style="font-size:10px;color:var(--text3);margin-left:6px">' + g.metacriticScore + ' MC</span>' : '') +
        '</div>';
      }).join('') +
    '</div>' +
  '</div>';
}

// ════════════════════════════════════════════════════════
// CONTEXT MENU
// ════════════════════════════════════════════════════════
var ctxGame = null;

function showContextMenu(e, game) {
  e.preventDefault();
  e.stopPropagation();
  ctxGame = game;

  var menu = document.getElementById('nexusContextMenu');
  if (!menu) return;

  var hasCover   = !!(coverCache[game.id] || coverCache[String(game.id)]);
  var inWishlist = wishlist.find(function(w) { return normalizeTitle(w.title) === normalizeTitle(game.title); });
  var hasSteam   = !!game.steamAppId;
  var hasGog     = game.platforms && game.platforms.includes('gog');
  var hasEpic    = game.platforms && game.platforms.includes('epic');
  var curStatus  = game.status || '';

  var statusIcons = { exploring: '▶', finished: '✓', 'not-for-me': '✕', '': '○' };
  var statuses = ['exploring','finished','not-for-me'];

  menu.innerHTML =
    // Header — game title
    '<div style="padding:8px 12px 6px;font-size:11px;font-weight:800;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;border-bottom:1px solid var(--border);margin-bottom:4px">' +
      escHtml(game.title.length > 28 ? game.title.slice(0,26) + '…' : game.title) +
    '</div>' +

    // Primary actions
    ctxItem('📖', 'Open Detail',        'openGameDetailById(' + game.id + ');hideContextMenu()') +
    ctxItem('🎲', 'Find Similar Games', 'ctxFindSimilar();hideContextMenu()') +
    ctxItem('🔀', 'Merge Duplicate…',    'ctxMerge();hideContextMenu()') +
    ctxItem(hasCover ? '🖼' : '🔍', hasCover ? 'Change Cover Art' : 'Find Cover Art', 'hideContextMenu();coverSearchFromDetail=false;openCoverSearch(' + game.id + ')') +

    '<div class="ctx-separator"></div>' +

    // Status submenu
    '<div class="ctx-submenu">' +
      ctxItem('📊', 'Set Status', null, '▸', true) +
      '<div class="ctx-submenu-items">' +
        statuses.map(function(s) {
          var active = curStatus === s ? ' style="color:var(--text);font-weight:700"' : '';
          return '<div class="ctx-item"' + active + ' onclick="ctxSetStatus(\'' + s + '\');hideContextMenu()">' +
            '<span class="ctx-icon">' + statusIcons[s] + '</span>' +
            '<span class="ctx-label">' + s.charAt(0).toUpperCase() + s.slice(1) + '</span>' +
            (curStatus === s ? '<span class="ctx-sub">current</span>' : '') +
          '</div>';
        }).join('') +
        (curStatus ? '<div class="ctx-item" onclick="ctxClearStatus();hideContextMenu()" style="opacity:0.6">' +
          '<span class="ctx-icon">○</span>' +
          '<span class="ctx-label">Clear Status</span>' +
        '</div>' : '') +
      '</div>' +
    '</div>' +

    '<div class="ctx-separator"></div>' +

    // Intent / queue actions
    (function() {
      var cur = game.intent || '';
      return '<div class="ctx-submenu">' +
        ctxItem('▶', 'Play Queue', null, '▸', true) +
        '<div class="ctx-submenu-items">' +
          ['playnext','priority','queue'].map(function(intent) {
            var labels = { playnext: '▶ Play Next', priority: '⭐ Focus List', queue: '📋 Queue' };
            var active = cur === intent ? ' style="color:var(--text);font-weight:700"' : '';
            return '<div class="ctx-item"' + active + ' onclick="ctxSetIntent(\'' + intent + '\');hideContextMenu()">' +
              '<span class="ctx-icon">' + labels[intent].split(' ')[0] + '</span>' +
              '<span class="ctx-label">' + labels[intent].split(' ').slice(1).join(' ') + '</span>' +
              (cur === intent ? '<span class="ctx-sub">active</span>' : '') +
            '</div>';
          }).join('') +
          (cur ? '<div class="ctx-item" onclick="ctxClearIntent();hideContextMenu()" style="opacity:0.6">' +
            '<span class="ctx-icon">○</span><span class="ctx-label">Clear</span>' +
          '</div>' : '') +
        '</div>' +
      '</div>';
    })() +

    '<div class="ctx-separator"></div>' +

    // Info & links
    ctxItem('📋', 'Copy Title',           'ctxCopyTitle();hideContextMenu()') +
    (hasSteam ? ctxItem('🎮', 'Open on Steam',   'ctxOpenSteam();hideContextMenu()') : '') +
    (hasGog   ? ctxItem('👾', 'Open on GOG',      'ctxOpenGog();hideContextMenu()')   : '') +
    (hasEpic  ? ctxItem('🟣', 'Open on Epic',     'ctxOpenEpic();hideContextMenu()')  : '') +
    ctxItem('🔍', 'Search on Google',    'ctxOpenGoogle();hideContextMenu()') +
    ctxItem(game.hidden ? '👁' : '👁', game.hidden ? 'Unhide Game' : 'Hide Game', 'ctxToggleHide();hideContextMenu()') +

    '<div class="ctx-separator"></div>' +

    // Danger
    ctxItemDanger('🗑', 'Delete from Library', 'hideContextMenu();promptDelete(ctxGame)');

  // Position — keep on screen
  var x = e.clientX, y = e.clientY;
  menu.style.left = '-9999px'; menu.style.top = '-9999px';
  menu.classList.add('visible');
  var mw = menu.offsetWidth, mh = menu.offsetHeight;
  var ww = window.innerWidth,  wh = window.innerHeight;
  if (x + mw + 8 > ww) x = ww - mw - 8;
  if (y + mh + 8 > wh) y = wh - mh - 8;
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function ctxItem(icon, label, onclick, sub, noClick) {
  var clickAttr = onclick ? ' onclick="' + onclick + '"' : '';
  return '<div class="ctx-item"' + (noClick ? '' : clickAttr) + '>' +
    '<span class="ctx-icon">' + icon + '</span>' +
    '<span class="ctx-label">' + escHtml(label) + '</span>' +
    (sub ? '<span class="ctx-sub">' + sub + '</span>' : '') +
  '</div>';
}
function ctxItemDanger(icon, label, onclick) {
  return '<div class="ctx-item danger" onclick="' + onclick + '">' +
    '<span class="ctx-icon">' + icon + '</span>' +
    '<span class="ctx-label">' + escHtml(label) + '</span>' +
  '</div>';
}

function ctxOpenSteam() {
  if (!ctxGame || !ctxGame.steamAppId) return;
  window.open('steam://store/' + ctxGame.steamAppId, '_blank');
}

async function ctxToggleHide() {
  if (!ctxGame) return;
  var nowHidden = !ctxGame.hidden;
  ctxGame.hidden = nowHidden;
  var idx = games.findIndex(function(g) { return g.id === ctxGame.id; });
  if (idx !== -1) games[idx].hidden = nowHidden;
  await window.nexus.games.update(ctxGame.id, { hidden: nowHidden });
  renderAll();
  showStatus((nowHidden ? '👁 Hidden: ' : '👁 Visible: ') + ctxGame.title, 100);
  setTimeout(hideStatus, 2500);
}

function ctxMerge() {
  if (!ctxGame) return;
  showMergeOverlay(ctxGame);
}

function showMergeOverlay(targetGame) {
  var existing = document.getElementById('mergeOverlay');
  if (existing) existing.remove();

  // Find candidates: same normalized base title (strip platform suffixes) or user can pick any
  var baseTitle = targetGame.title
    .replace(/\s*[-–]\s*Amazon\s*(Prime|Luna|Gaming)?\s*$/i, '')
    .replace(/\s*[-–]\s*Epic\s*Games?\s*$/i, '')
    .replace(/\s*[-–]\s*GOG(\.COM?)?\s*$/i, '')
    .trim()
    .toLowerCase();

  var suggestions = games.filter(function(g) {
    if (g.id === targetGame.id) return false;
    var gBase = g.title.replace(/\s*[-–]\s*(Amazon|Epic|GOG).*$/i,'').trim().toLowerCase();
    return gBase === baseTitle || g.title.toLowerCase().includes(baseTitle) || baseTitle.includes(gBase);
  });

  var overlay = document.createElement('div');
  overlay.id = 'mergeOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:900;background:rgba(0,0,0,0.7);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:20px';

  var modal = document.createElement('div');
  modal.style.cssText = 'background:var(--bg);border:1px solid var(--border2);border-radius:16px;width:100%;max-width:560px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden';

  var header = document.createElement('div');
  header.style.cssText = 'padding:16px 20px;border-bottom:1px solid var(--border);flex-shrink:0';
  header.innerHTML =
    '<div style="font-size:14px;font-weight:800;color:var(--text);margin-bottom:4px">🔀 Merge Duplicate</div>' +
    '<div style="font-size:11px;color:var(--text3)">Keep <strong style="color:var(--text)">' + escHtml(targetGame.title) + '</strong> and delete the selected entry. Playtime, tags, and platforms will be combined.</div>';

  var closeBtn = document.createElement('button');
  closeBtn.innerHTML = '&times;';
  closeBtn.style.cssText = 'position:absolute;top:14px;right:16px;background:var(--surface2);border:1px solid var(--border);color:var(--text2);font-size:16px;line-height:1;cursor:pointer;width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center';
  closeBtn.onclick = function() { overlay.remove(); };
  header.style.position = 'relative';
  header.appendChild(closeBtn);

  var body = document.createElement('div');
  body.style.cssText = 'overflow-y:auto;padding:14px 16px';

  // Search box to find any game to merge
  var searchWrap = document.createElement('div');
  searchWrap.innerHTML =
    '<input id="mergeSearch" type="text" class="settings-input" placeholder="Search for game to merge into this one…" style="width:100%;margin-bottom:10px">';
  body.appendChild(searchWrap);

  var listEl = document.createElement('div');
  listEl.id = 'mergeGameList';
  body.appendChild(listEl);

  function renderMergeList(filter) {
    var source = filter
      ? games.filter(function(g) {
          return g.id !== targetGame.id && g.title.toLowerCase().includes(filter.toLowerCase());
        }).slice(0, 20)
      : suggestions.slice(0, 20);

    if (!source.length) {
      listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px">' +
        (filter ? 'No games match "' + escHtml(filter) + '"' : 'No obvious duplicates found — search above') + '</div>';
      return;
    }

    listEl.innerHTML = '';
    source.forEach(function(g) {
      var cover = coverCache[g.id] || coverCache[String(g.id)];
      var pal   = COVER_PALETTES[(g.pal||0) % COVER_PALETTES.length];
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;cursor:pointer;border:1px solid transparent';
      row.onmouseenter = function() { row.style.background = 'var(--surface2)'; };
      row.onmouseleave = function() { row.style.background = ''; };
      row.innerHTML =
        '<div style="width:32px;height:32px;border-radius:4px;overflow:hidden;background:linear-gradient(135deg,' + pal[0] + ',' + pal[1] + ');flex-shrink:0">' +
          (cover ? '<img src="' + cover + '" style="width:100%;height:100%;object-fit:cover">' : '') +
        '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:12px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(g.title) + '</div>' +
          '<div style="font-size:10px;color:var(--text3)">' + g.platforms.join(', ') + (g.playtimeHours ? ' · ' + g.playtimeHours + 'h' : '') + '</div>' +
        '</div>' +
        '<button style="font-size:11px;padding:5px 12px;background:rgba(74,158,237,0.15);border:1px solid rgba(74,158,237,0.4);border-radius:6px;color:#7fc8f8;cursor:pointer;flex-shrink:0">Merge Into This</button>';
      row.querySelector('button').addEventListener('click', async function() {
        overlay.remove();
        await mergeGameRecords(targetGame, [g]);
        games = await window.nexus.games.getAll();
        renderAll();
      });
      listEl.appendChild(row);
    });
  }

  renderMergeList('');

  // Wire search
  searchWrap.querySelector('#mergeSearch').addEventListener('input', function(e) {
    renderMergeList(e.target.value);
  });

  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  setTimeout(function() { document.getElementById('mergeSearch').focus(); }, 50);
}

function ctxCopyTitle() {
  if (!ctxGame) return;
  navigator.clipboard.writeText(ctxGame.title).then(function() {
    showStatus('✓ Copied: ' + ctxGame.title, 100);
    setTimeout(hideStatus, 2000);
  }).catch(function() {
    showStatus('Copy failed', 100);
    setTimeout(hideStatus, 2000);
  });
}

async function ctxSetStatus(status) {
  if (!ctxGame) return;
  var idx = games.findIndex(function(g) { return g.id === ctxGame.id; });
  if (idx === -1) return;
  games[idx].status = status;
  await window.nexus.games.update(ctxGame.id, { status: status });
  // Clear intent + momentum if moving to finished/not-for-me
  if (status === 'finished' || status === 'not-for-me') {
    if (games[idx].intent)      { games[idx].intent = null;      await window.nexus.games.update(ctxGame.id, { intent: null }); }
    if (games[idx].momentumAt)  { games[idx].momentumAt = null;  await window.nexus.games.update(ctxGame.id, { momentumAt: null }); }
  }
  renderAll();
  showStatus('✓ "' + ctxGame.title + '" → ' + status, 100);
  setTimeout(hideStatus, 2500);

  // Trigger feedback when marking finished via context menu
  if (status === 'finished') {
    var gameForFeedback = Object.assign({}, games[idx]);
    setTimeout(function() { openGameFeedback(gameForFeedback, false); }, 300);
  }
}

async function ctxClearStatus() {
  if (!ctxGame) return;
  var idx = games.findIndex(function(g) { return g.id === ctxGame.id; });
  if (idx === -1) return;
  games[idx].status = null;
  await window.nexus.games.update(ctxGame.id, { status: null });
  renderAll();
  showStatus('✓ "' + ctxGame.title + '" status cleared', 100);
  setTimeout(hideStatus, 2500);
}

async function ctxSetIntent(intent) {
  if (!ctxGame) return;
  await setGameIntent(ctxGame.id, intent);
  var label = { playnext: 'Play Next', priority: 'Focus List', queue: 'Queue' }[intent] || intent;
  showStatus('✓ "' + ctxGame.title + '" added to ' + label, 100);
  setTimeout(hideStatus, 2500);
}

async function ctxClearIntent() {
  if (!ctxGame) return;
  await setGameIntent(ctxGame.id, '');
  showStatus('✓ Queue cleared for "' + ctxGame.title + '"', 100);
  setTimeout(hideStatus, 2500);
}

function ctxOpenGog() {
  if (!ctxGame) return;
  // Try GOG's natural-language URL format first (game/title_with_underscores)
  // Fall back to search if that doesn't work — user can navigate from there
  var slug = ctxGame.title
    .toLowerCase()
    .replace(/[:\-–—]/g, ' ')          // colons, dashes → space
    .replace(/[^a-z0-9 ]/g, '')        // remove special chars
    .trim()
    .replace(/\s+/g, '_');             // spaces → underscores
  window.open('https://www.gog.com/en/game/' + slug, '_blank');
}

function ctxOpenEpic() {
  if (!ctxGame) return;
  window.open('https://store.epicgames.com/en-US/browse?q=' + encodeURIComponent(ctxGame.title), '_blank');
}

function ctxOpenGoogle() {
  if (!ctxGame) return;
  window.open('https://www.google.com/search?q=' + encodeURIComponent(ctxGame.title + ' game'), '_blank');
}

function hideContextMenu() {
  var menu = document.getElementById('nexusContextMenu');
  if (menu) menu.classList.remove('visible');
}

// Close on any click or scroll outside
document.addEventListener('click',    function(e) { if (!document.getElementById('nexusContextMenu')?.contains(e.target)) hideContextMenu(); });
document.addEventListener('keydown',  function(e) { if (e.key === 'Escape') hideContextMenu(); });
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  var detailOverlay = document.getElementById('gameDetailOverlay');
  if (detailOverlay && detailOverlay.classList.contains('open')) { closeGameDetail(); return; }
  var pickerOverlay = document.getElementById('helpMeDecideOverlay');
  if (pickerOverlay && pickerOverlay.classList.contains('open')) { closeHelpMeDecide(); return; }
  var randomOverlay = document.getElementById('randomPickerOverlay');
  if (randomOverlay && randomOverlay.classList.contains('open')) { closeRandomPicker(); return; }
});
document.addEventListener('scroll',   hideContextMenu, true);

// ── Context menu actions ──
function ctxFindSimilar() {
  if (!ctxGame) return;
  var src = ctxGame;
  var srcGenres = (src.genres && src.genres.length ? src.genres : (src.genre ? [src.genre] : [])).map(function(g) { return (g||'').toLowerCase(); });
  var srcTags   = (src.tags || []).map(function(t) { return (t||'').toLowerCase(); });
  var srcDev    = (src.developer || '').toLowerCase();
  var srcMC     = src.metacriticScore || 0;

  // Get title words for fallback matching (when no genre/tag data)
  var srcTitleWords = src.title.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(' ').filter(function(w) { return w.length > 3; });

  // Score every other game
  var scored = games
    .filter(function(g) { return g.id !== src.id; })
    .map(function(g) {
      var score = 0;
      var reasons = [];
      var gGenres = (g.genres && g.genres.length ? g.genres : (g.genre ? [g.genre] : [])).map(function(x) { return (x||'').toLowerCase(); });
      var gTags   = (g.tags || []).map(function(t) { return (t||'').toLowerCase(); });

      // Genre overlap — weighted by number of shared genres
      var sharedGenres = srcGenres.filter(function(gn) { return gGenres.includes(gn); });
      if (sharedGenres.length) {
        score += sharedGenres.length * 10;
        reasons.push(sharedGenres.length + ' shared genre' + (sharedGenres.length > 1 ? 's' : '') + ' (' + sharedGenres.slice(0,2).join(', ') + ')');
      }

      // Tag overlap
      var sharedTags = srcTags.filter(function(t) { return gTags.includes(t); });
      if (sharedTags.length) {
        score += sharedTags.length * 4;
        reasons.push(sharedTags.length + ' shared tag' + (sharedTags.length > 1 ? 's' : ''));
      }

      // Same developer
      if (srcDev && g.developer && g.developer.toLowerCase() === srcDev) {
        score += 15;
        reasons.push('same developer');
      }

      // Similar Metacritic score (within 10 points)
      if (srcMC && g.metacriticScore && Math.abs(srcMC - g.metacriticScore) <= 10) {
        score += 5;
        reasons.push('similar MC score');
      }

      // Title-word fallback when no genre/tag data
      if (score === 0 && srcTitleWords.length) {
        var gTitleWords = g.title.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(' ').filter(function(w) { return w.length > 3; });
        var sharedWords = srcTitleWords.filter(function(w) { return gTitleWords.includes(w); });
        if (sharedWords.length) { score += sharedWords.length * 3; reasons.push('similar title'); }
      }

      return { game: g, score: score, reasons: reasons };
    })
    .filter(function(e) { return e.score > 0; })
    .sort(function(a, b) { return b.score - a.score; })
    .slice(0, 30);

  if (!scored.length) {
    showStatus('No similar games found — try enriching this game first with the 🎮 button', 100);
    setTimeout(hideStatus, 4000);
    return;
  }

  showSimilarGamesOverlay(src, scored);
}

function showSimilarGamesOverlay(src, scored) {
  var existing = document.getElementById('similarGamesOverlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'similarGamesOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:800;background:rgba(0,0,0,0.65);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:20px';

  var srcCover = coverCache[src.id] || coverCache[String(src.id)];
  var srcPal   = COVER_PALETTES[(src.pal||0) % COVER_PALETTES.length];

  // Build modal shell
  var modal = document.createElement('div');
  modal.style.cssText = 'background:var(--bg);border:1px solid var(--border2);border-radius:16px;width:100%;max-width:680px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden';

  // Header
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border);flex-shrink:0';
  var coverThumb = document.createElement('div');
  coverThumb.style.cssText = 'width:40px;height:40px;border-radius:6px;overflow:hidden;background:linear-gradient(135deg,' + srcPal[0] + ',' + srcPal[1] + ');flex-shrink:0';
  if (srcCover) coverThumb.innerHTML = '<img src="' + srcCover + '" style="width:100%;height:100%;object-fit:cover">';
  var titleEl = document.createElement('div');
  titleEl.style.cssText = 'flex:1;min-width:0';
  titleEl.innerHTML = '<div style="font-size:14px;font-weight:800;color:var(--text)">Games similar to ' + escHtml(src.title) + '</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:2px">' + scored.length + ' matches · ranked by similarity</div>';
  var closeBtn = document.createElement('button');
  closeBtn.innerHTML = '&times;';
  closeBtn.style.cssText = 'flex-shrink:0;background:var(--surface2);border:1px solid var(--border);color:var(--text2);font-size:16px;line-height:1;cursor:pointer;width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center';
  closeBtn.addEventListener('click', function() { overlay.remove(); });
  header.appendChild(coverThumb);
  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  // Results list
  var list = document.createElement('div');
  list.style.cssText = 'overflow-y:auto;padding:12px 16px';

  scored.forEach(function(e, i) {
    var g = e.game;
    var cover = coverCache[g.id] || coverCache[String(g.id)];
    var pal   = COVER_PALETTES[(g.pal||0) % COVER_PALETTES.length];
    var statusColor = { exploring:'#4ade80', finished:'#7fc8f8', 'not-for-me':'#f87171' }[g.status] || 'var(--text3)';
    var scorePct = Math.min(100, Math.round((e.score / scored[0].score) * 100));

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px;border-radius:10px;cursor:pointer;margin-bottom:4px;transition:background 0.1s';
    row.addEventListener('mouseenter', function() { row.style.background = 'var(--surface2)'; });
    row.addEventListener('mouseleave', function() { row.style.background = 'transparent'; });
    row.addEventListener('click', function() { overlay.remove(); openGameDetailById(g.id); });

    var coverEl = document.createElement('div');
    coverEl.style.cssText = 'width:36px;height:36px;border-radius:5px;overflow:hidden;background:linear-gradient(135deg,' + pal[0] + ',' + pal[1] + ');flex-shrink:0';
    if (cover) coverEl.innerHTML = '<img src="' + cover + '" style="width:100%;height:100%;object-fit:cover">';

    row.innerHTML =
      '<div style="font-size:11px;font-weight:700;color:var(--text3);min-width:20px;text-align:center">#' + (i+1) + '</div>';
    row.appendChild(coverEl);
    row.insertAdjacentHTML('beforeend',
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:13px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(g.title) + '</div>' +
        '<div style="font-size:10px;color:var(--text3);margin-top:1px">' + escHtml(e.reasons.join(' · ')) + '</div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' +
        '<div style="width:60px;height:4px;background:var(--border);border-radius:2px;margin-bottom:3px">' +
          '<div style="height:100%;width:' + scorePct + '%;background:var(--steam);border-radius:2px"></div>' +
        '</div>' +
        (g.status ? '<div style="font-size:10px;color:' + statusColor + '">' + g.status + '</div>' : '') +
      '</div>'
    );
    list.appendChild(row);
  });

  modal.appendChild(header);
  modal.appendChild(list);
  overlay.appendChild(modal);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ══════════════════════════════════════════════════════
// GAME FEEDBACK
// ══════════════════════════════════════════════════════

var feedbackGame = null;        // game being rated
var feedbackRating = 0;         // 1–10
var feedbackReaction = null;    // 'loved' | 'liked' | 'mixed' | 'disappointed'
var feedbackChainFinish = false;// true when opened from session-end "Mark Finished" flow

function openGameFeedback(game, chainFinish) {
  feedbackGame        = game;
  feedbackRating      = game.userRating || 0;
  feedbackReaction    = game.reaction   || null;
  feedbackChainFinish = !!chainFinish;

  // Populate cover
  var cUrl = coverCache[game.id] || coverCache[String(game.id)];
  var pal  = COVER_PALETTES[(game.pal||0) % COVER_PALETTES.length];
  var coverEl = document.getElementById('feedbackCover');
  if (coverEl) coverEl.innerHTML = cUrl
    ? '<img src="' + cUrl + '" style="width:100%;height:100%;object-fit:cover">'
    : '<div style="width:100%;height:100%;background:linear-gradient(135deg,' + pal[0] + ',' + pal[1] + ')"></div>';

  // Title + meta
  var genres = (game.genres && game.genres.length ? game.genres : (game.genre ? [game.genre] : [])).slice(0,2).join(' · ');
  var hours  = game.playtimeHours > 0 ? game.playtimeHours + 'h played' : '';
  setText('feedbackGameTitle', game.title);
  setText('feedbackGameMeta', [genres, hours].filter(Boolean).join(' · '));

  // Stars
  renderFeedbackStars(feedbackRating);

  // Reactions
  renderFeedbackReactions(feedbackReaction);

  // Review — pre-fill if exists, clear otherwise
  var input = document.getElementById('feedbackReviewInput');
  if (input) input.value = game.shortReview || '';

  document.getElementById('gameFeedbackOverlay').classList.add('open');
}

function closeGameFeedback() {
  document.getElementById('gameFeedbackOverlay').classList.remove('open');
  feedbackGame = null;
}

function renderFeedbackStars(active) {
  var el = document.getElementById('feedbackStars');
  if (!el) return;
  // Show 5 stars, each worth 2 points (maps to 1–10 scale)
  el.innerHTML = [1,2,3,4,5].map(function(i) {
    var val = i * 2;
    var filled = active >= val;
    var half   = !filled && active >= val - 1;
    return '<span data-val="' + val + '" onclick="setFeedbackRating(' + val + ')" ' +
      'style="font-size:28px;cursor:pointer;color:' + (filled || half ? '#facc15' : 'var(--border2)') + ';transition:color 0.1s" ' +
      'onmouseenter="renderFeedbackStarsHover(' + val + ')" ' +
      'onmouseleave="renderFeedbackStars(' + feedbackRating + ')">' +
      (filled ? '★' : half ? '⯨' : '☆') +
    '</span>';
  }).join('');
}

window.renderFeedbackStarsHover = function(val) { renderFeedbackStars(val); };

window.setFeedbackRating = function(val) {
  feedbackRating = (feedbackRating === val) ? 0 : val; // toggle off
  renderFeedbackStars(feedbackRating);
};

function renderFeedbackReactions(active) {
  document.querySelectorAll('.feedback-reaction-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.reaction === active);
    btn.onclick = function() {
      feedbackReaction = (feedbackReaction === btn.dataset.reaction) ? null : btn.dataset.reaction;
      renderFeedbackReactions(feedbackReaction);
    };
  });
}

window.saveGameFeedback = async function() {
  if (!feedbackGame) return;
  var review = (document.getElementById('feedbackReviewInput').value || '').trim();
  var updates = {
    userRating:  feedbackRating  || null,
    reaction:    feedbackReaction || null,
    shortReview: review           || null,
  };
  var idx = games.findIndex(function(g) { return g.id === feedbackGame.id; });
  if (idx !== -1) Object.assign(games[idx], updates);
  if (currentDetailGame && currentDetailGame.id === feedbackGame.id) Object.assign(currentDetailGame, updates);
  await window.nexus.games.update(feedbackGame.id, updates);

  // Refresh star display in detail modal if open
  if (currentDetailGame && currentDetailGame.id === feedbackGame.id) {
    renderStarRating(feedbackRating || 0);
  }

  closeGameFeedback();
  renderAll();
  showStatus('✓ Feedback saved for ' + feedbackGame.title, 100);
  setTimeout(hideStatus, 2500);
};

// ── Session-end toast (intent completion path) ──

var sessionEndGame    = null;
var sessionEndTimeout = null;

function showSessionEndToast(game) {
  // Only prompt for games with playnext intent or no specific intent — not for casual plays
  if (game.status === 'finished' || game.status === 'not-for-me') return;
  // Only show if they've played a reasonable amount (30+ min this session doesn't mean finished,
  // but we ask anyway — they can dismiss)
  sessionEndGame = game;

  var toast  = document.getElementById('sessionEndToast');
  var cUrl   = coverCache[game.id] || coverCache[String(game.id)];
  var pal    = COVER_PALETTES[(game.pal||0) % COVER_PALETTES.length];
  var coverEl = document.getElementById('sessionEndCover');
  if (coverEl) coverEl.innerHTML = cUrl
    ? '<img src="' + cUrl + '" style="width:100%;height:100%;object-fit:cover">'
    : '<div style="width:100%;height:100%;background:linear-gradient(135deg,' + pal[0] + ',' + pal[1] + ')"></div>';

  setText('sessionEndTitle', game.title);
  if (toast) {
    toast.style.display = 'block';
    toast.style.animation = 'slideInToast 0.25s ease';
  }

  // Auto-dismiss after 10 seconds
  if (sessionEndTimeout) clearTimeout(sessionEndTimeout);
  sessionEndTimeout = setTimeout(dismissSessionEndToast, 10000);
}

window.dismissSessionEndToast = function() {
  var toast = document.getElementById('sessionEndToast');
  if (toast) toast.style.display = 'none';
  if (sessionEndTimeout) { clearTimeout(sessionEndTimeout); sessionEndTimeout = null; }
  sessionEndGame = null;
};

window.sessionEndMarkFinished = async function() {
  var game = sessionEndGame;
  window.dismissSessionEndToast();
  if (!game) return;

  // Update status to finished
  var idx = games.findIndex(function(g) { return g.id === game.id; });
  var updates = { status: 'finished', intent: null, momentumAt: null };
  if (idx !== -1) Object.assign(games[idx], updates);
  if (currentDetailGame && currentDetailGame.id === game.id) Object.assign(currentDetailGame, updates);
  await window.nexus.games.update(game.id, updates);
  renderAll();

  // Chain into feedback overlay
  setTimeout(function() { openGameFeedback(game, true); }, 300);
};

window.sessionEndKeepPlaying = function() {
  window.dismissSessionEndToast();
};

// ══════════════════════════════════════════════════════
// DISCOVERY PAGE
// ══════════════════════════════════════════════════════

var discShownIds = new Set(); // session exclusion for Play Next shelf

function renderDiscoveryPage() {
  renderDiscPlayNext();
  renderDiscHiddenGems();
  // Find Similar starts blank — user picks seed
}

// ── Play Next shelf with familiarity slider ──
function renderDiscPlayNext() {
  var el = document.getElementById('disc-playnext-cards');
  if (!el) return;

  var slider = document.getElementById('discFamiliaritySlider');
  var familiarity = slider ? parseInt(slider.value) : 1; // 0=Familiar, 1=Balanced, 2=Adventurous

  var backlog = games.filter(function(g) {
    return (g.playtimeHours||0) === 0 && !g.hidden && !g.gpCatalog && g.status !== 'not-for-me';
  });
  if (!backlog.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:20px 0">No backlog games found.</div>';
    return;
  }

  var scored = scorePlayNext(backlog);
  if (!scored.length) { el.innerHTML = ''; return; }

  var topScore = scored[0].score;

  // Familiarity controls comfort/stretch split
  // 0=Familiar: 5 comfort, 1 stretch
  // 1=Balanced: 4 comfort, 2 stretch
  // 2=Adventurous: 3 comfort, 3 stretch
  var comfortCount = [5, 4, 3][familiarity];
  var stretchCount = [1, 2, 3][familiarity];
  var minSimilarity = topScore * 0.3; // stretch guardrail

  // Comfort = top band (>75% of top score), jittered
  var comfortPool = scored
    .filter(function(s) { return s.score >= topScore * 0.75; })
    .map(function(s) { return { game: s.game, score: s.score * (0.85 + Math.random() * 0.3) }; })
    .sort(function(a,b) { return b.score - a.score; });

  // Stretch = mid band (30–75%), jittered more aggressively
  var stretchPool = scored
    .filter(function(s) { return s.score < topScore * 0.75 && s.score >= minSimilarity && !discShownIds.has(s.game.id); })
    .map(function(s) { return { game: s.game, score: s.score * (0.6 + Math.random() * 0.8) }; })
    .sort(function(a,b) { return b.score - a.score; });

  var picks = [];
  var usedIds = new Set();

  comfortPool.forEach(function(s) {
    if (picks.length < comfortCount && !usedIds.has(s.game.id)) {
      picks.push({ game: s.game, type: 'comfort' });
      usedIds.add(s.game.id);
    }
  });
  stretchPool.forEach(function(s) {
    if (picks.length < comfortCount + stretchCount && !usedIds.has(s.game.id)) {
      picks.push({ game: s.game, type: 'stretch' });
      usedIds.add(s.game.id);
    }
  });
  // Pad with comfort if stretch pool was thin
  comfortPool.forEach(function(s) {
    if (picks.length < 6 && !usedIds.has(s.game.id)) {
      picks.push({ game: s.game, type: 'comfort' });
      usedIds.add(s.game.id);
    }
  });

  picks.forEach(function(p) { discShownIds.add(p.game.id); });

  el.innerHTML = picks.map(function(p) {
    return buildDiscGameCard(p.game, scored, p.type === 'stretch' ? '✨ Stretch pick' : null);
  }).join('');
}

// ── Hidden Gems ──
function renderDiscHiddenGems() {
  var el = document.getElementById('disc-gems-cards');
  if (!el) return;

  var candidates = games.filter(function(g) {
    return (g.playtimeHours||0) < 2
      && g.status !== 'not-for-me'
      && !g.hidden
      && !g.gpCatalog
      && (g.metacriticScore >= 75 || g.openCriticScore >= 75 || g.userRating >= 4);
  });

  if (!candidates.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:20px 0">No hidden gems found yet — try adding Metacritic scores in Settings.</div>';
    return;
  }

  // Score by quality + how little you've played
  var gems = candidates.map(function(g) {
    var score = 0;
    if (g.metacriticScore >= 90)      score += 5;
    else if (g.metacriticScore >= 80) score += 3;
    else if (g.metacriticScore >= 75) score += 2;
    if (g.openCriticScore >= 90)      score += 4;
    else if (g.openCriticScore >= 80) score += 2;
    if (g.userRating >= 5)   score += 3;
    else if (g.userRating >= 4) score += 1.5;
    if ((g.playtimeHours||0) === 0) score += 1; // never touched gets small boost
    score *= (0.75 + Math.random() * 0.5); // jitter for variety
    return { game: g, score: score };
  }).sort(function(a,b) { return b.score - a.score; }).slice(0, 8);

  el.innerHTML = gems.map(function(s) {
    return buildDiscGameCard(s.game, [], '💎 Hidden gem');
  }).join('');
}

// ── Find Similar ──
var discSimilarSeed = null;

window.discSimilarSearch = function(query) {
  var clearBtn = document.getElementById('discSimilarClear');
  if (clearBtn) clearBtn.style.display = query.length > 0 ? 'block' : 'none';
  var dropdown = document.getElementById('discSimilarDropdown');
  if (!dropdown) return;
  if (!query || query.length < 2) { dropdown.innerHTML = ''; return; }

  var q = query.toLowerCase();
  var matches = games
    .filter(function(g) { return g.title.toLowerCase().includes(q); })
    .slice(0, 8);

  if (!matches.length) { dropdown.innerHTML = ''; return; }

  dropdown.innerHTML =
    '<div style="position:absolute;top:4px;left:0;z-index:200;background:var(--surface2);border:1px solid var(--border);border-radius:8px;min-width:280px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.3)">' +
      matches.map(function(g) {
        return '<div style="padding:8px 12px;cursor:pointer;font-size:12px;color:var(--text);border-bottom:1px solid var(--border)" ' +
          'onmouseenter="this.style.background=\'var(--surface)\'" ' +
          'onmouseleave="this.style.background=\'\'" ' +
          'onclick="discSetSeed(' + g.id + ')">' +
          escHtml(g.title) +
          '<span style="font-size:10px;color:var(--text3);margin-left:6px">' + escHtml((g.genres||[g.genre||'']).slice(0,1).join('')) + '</span>' +
        '</div>';
      }).join('') +
    '</div>';
};

window.discSetSeed = function(gameId) {
  var g = games.find(function(g) { return g.id === gameId; });
  if (!g) return;
  discSimilarSeed = g;
  var input    = document.getElementById('discSimilarInput');
  var clearBtn = document.getElementById('discSimilarClear');
  if (input)    input.value = g.title;
  if (clearBtn) clearBtn.style.display = 'block';
  document.getElementById('discSimilarDropdown').innerHTML = '';
  renderDiscSimilar(g);
};

window.discClearSeed = function() {
  discSimilarSeed = null;
  var input = document.getElementById('discSimilarInput');
  var clearBtn = document.getElementById('discSimilarClear');
  var seedEl = document.getElementById('disc-similar-seed');
  var cardsEl = document.getElementById('disc-similar-cards');
  if (input) input.value = '';
  if (clearBtn) clearBtn.style.display = 'none';
  if (seedEl) seedEl.innerHTML = '';
  if (cardsEl) cardsEl.innerHTML = '';
  var dropdown = document.getElementById('discSimilarDropdown');
  if (dropdown) dropdown.innerHTML = '';
};

window.discOpenTopRatedPicker = function() {
  var overlay = document.getElementById('topRatedPickerOverlay');
  var list    = document.getElementById('topRatedPickerList');
  if (!overlay || !list) return;

  var rated = games
    .filter(function(g) { return g.userRating > 0 && !g.gpCatalog; })
    .sort(function(a,b) { return b.userRating - a.userRating || a.title.localeCompare(b.title); });

  if (!rated.length) {
    list.innerHTML = '<div style="padding:20px;font-size:12px;color:var(--text3);text-align:center">No ratings yet.<br>Rate games from their detail panel.</div>';
  } else {
    list.innerHTML = rated.map(function(g) {
      var cover  = coverCache[g.id] || coverCache[String(g.id)];
      var pal    = COVER_PALETTES[(g.pal||0) % COVER_PALETTES.length];
      var stars  = Math.round(g.userRating / 2);
      var genres = (g.genres && g.genres.length ? g.genres[0] : g.genre) || '';
      return '<div style="display:flex;align-items:center;gap:10px;padding:9px 20px;cursor:pointer;border-bottom:1px solid var(--border)" ' +
        'onmouseenter="this.style.background=\'var(--surface2)\'" ' +
        'onmouseleave="this.style.background=\'\'" ' +
        'onclick="discPickTopRated(' + g.id + ')">' +
        (cover
          ? '<img src="' + cover + '" style="width:32px;height:42px;border-radius:4px;object-fit:cover;flex-shrink:0">'
          : '<div style="width:32px;height:42px;border-radius:4px;flex-shrink:0;background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')"></div>') +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(g.title) + '</div>' +
          '<div style="font-size:10px;color:var(--text3);margin-top:2px">' + (genres ? escHtml(genres) + ' · ' : '') + fmtHrs(g.playtimeHours) + 'h</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0">' +
          '<span style="color:#facc15;font-size:12px;letter-spacing:-1px">' + '★'.repeat(stars) + '<span style="opacity:0.2">' + '★'.repeat(5-stars) + '</span></span>' +
          '<span style="font-family:\'Syne\',sans-serif;font-size:11px;font-weight:800;color:#facc15">' + g.userRating + '/10</span>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  overlay.style.display = 'flex';
};

window.discPickTopRated = function(gameId) {
  discCloseTopRatedPicker();
  discSetSeed(gameId);
};

window.discCloseTopRatedPicker = function() {
  var overlay = document.getElementById('topRatedPickerOverlay');
  if (overlay) overlay.style.display = 'none';
};

window.discUseFavorite = function() {
  discOpenTopRatedPicker();
};

window.discUseLastPlayed = function() {
  var last = games
    .filter(function(g) { return g.lastPlayedAt; })
    .sort(function(a,b) { return new Date(b.lastPlayedAt) - new Date(a.lastPlayedAt); })[0];
  if (last) discSetSeed(last.id);
};

function renderDiscSimilar(src) {
  var seedEl  = document.getElementById('disc-similar-seed');
  var cardsEl = document.getElementById('disc-similar-cards');
  if (!seedEl || !cardsEl) return;

  var srcCover = coverCache[src.id] || coverCache[String(src.id)];
  var srcPal   = COVER_PALETTES[(src.pal||0) % COVER_PALETTES.length];
  var srcGenres = (src.genres && src.genres.length ? src.genres : (src.genre ? [src.genre] : [])).map(function(g) { return g.toLowerCase(); });
  var srcTags   = [...new Set([...(src.tags||[]),...(src.steamTags||[])].map(function(t){return t.toLowerCase();}))];

  // Seed chip
  seedEl.innerHTML =
    '<div style="display:inline-flex;align-items:center;gap:8px;background:var(--surface2);border:1px solid var(--accent);border-radius:8px;padding:6px 10px;margin-bottom:4px">' +
      '<div style="width:28px;height:28px;border-radius:4px;overflow:hidden;flex-shrink:0;background:linear-gradient(135deg,' + srcPal[0] + ',' + srcPal[1] + ')">' +
        (srcCover ? '<img src="' + srcCover + '" style="width:100%;height:100%;object-fit:cover">' : '') +
      '</div>' +
      '<span style="font-size:12px;font-weight:700;color:var(--text)">' + escHtml(src.title) + '</span>' +
      '<span style="font-size:10px;color:var(--text3)">→ finding similar games</span>' +
    '</div>';

  // Score all other games by similarity
  var scored = games
    .filter(function(g) { return g.id !== src.id && !g.hidden; })
    .map(function(g) {
      var score = 0;
      var gGenres = (g.genres && g.genres.length ? g.genres : (g.genre ? [g.genre] : [])).map(function(x){return x.toLowerCase();});
      var gTags   = [...new Set([...(g.tags||[]),...(g.steamTags||[])].map(function(t){return t.toLowerCase();}))];
      gGenres.forEach(function(gn) { if (srcGenres.includes(gn)) score += 3; });
      gTags.forEach(function(t)    { if (srcTags.includes(t))   score += 1; });
      if (g.developer && src.developer && g.developer === src.developer) score += 2;
      return { game: g, score: score };
    })
    .filter(function(s) { return s.score > 0; })
    .sort(function(a,b) { return b.score - a.score; });

  // Bucket: owned (played+unplayed) first, then indicate unowned
  var owned   = scored.filter(function(s) { return !s.game.gpCatalog; }).slice(0, 12);
  var catalog = scored.filter(function(s) { return s.game.gpCatalog; }).slice(0, 4);

  if (!owned.length && !catalog.length) {
    cardsEl.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:16px 0">No similar games found in your library.</div>';
    return;
  }

  cardsEl.innerHTML =
    (owned.length ? '<div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">In your library</div>' : '') +
    '<div style="display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;scrollbar-width:thin;margin-bottom:' + (catalog.length ? '16px' : '0') + '">' +
      owned.map(function(s) { return buildDiscGameCard(s.game, scored, null); }).join('') +
    '</div>' +
    (catalog.length ?
      '<div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Also in Game Pass</div>' +
      '<div style="display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;scrollbar-width:thin">' +
        catalog.map(function(s) { return buildDiscGameCard(s.game, scored, '🎮 Game Pass'); }).join('') +
      '</div>'
    : '');
}

// ── Shared card builder for Discovery ──
function buildDiscGameCard(g, scored, badge) {
  var cUrl  = coverCache[g.id] || coverCache[String(g.id)];
  var pal   = COVER_PALETTES[(g.pal||0) % COVER_PALETTES.length];
  var genres = (g.genres && g.genres.length ? g.genres : (g.genre ? [g.genre] : [])).slice(0,2).join(' · ');
  var mc    = g.metacriticScore;
  var mcColor = mc >= 80 ? '#4ade80' : mc >= 60 ? '#facc15' : '#f87171';
  var hours = g.playtimeHours > 0 ? g.playtimeHours + 'h played' : '';
  var intent = g.intent ? (INTENT_LABEL[g.intent] || '') : '';

  return '<div class="disc-game-card" onclick="openGameDetailById(' + g.id + ')">' +
    '<div class="disc-game-card-cover" style="background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')">' +
      (cUrl ? '<img src="' + cUrl + '" style="width:100%;height:100%;object-fit:cover">' : '') +
      (mc ? '<span style="position:absolute;bottom:5px;right:5px;font-size:9px;font-weight:800;color:' + mcColor + ';background:rgba(0,0,0,0.75);padding:1px 5px;border-radius:3px">' + mc + '</span>' : '') +
      (badge ? '<span style="position:absolute;top:5px;left:5px;font-size:8px;font-weight:700;background:rgba(0,0,0,0.75);color:#fff;padding:2px 6px;border-radius:3px">' + escHtml(badge) + '</span>' : '') +
      (intent ? '<span style="position:absolute;bottom:5px;left:5px;font-size:8px;font-weight:700;background:rgba(0,0,0,0.75);color:' + (INTENT_COLOR[g.intent]||'#fff') + ';padding:2px 6px;border-radius:3px">' + escHtml(intent) + '</span>' : '') +
    '</div>' +
    '<div class="disc-game-card-body">' +
      '<div class="disc-game-card-title" title="' + escHtml(g.title) + '">' + escHtml(g.title) + '</div>' +
      (genres ? '<div class="disc-game-card-meta">' + escHtml(genres) + '</div>' : '') +
      (hours  ? '<div class="disc-game-card-meta" style="color:var(--text2)">' + hours + '</div>' : '') +
    '</div>' +
  '</div>';
}

// ══════════════════════════════════════════════════════
// RANDOM GAME PICKER
// ══════════════════════════════════════════════════════
window.openRandomPicker = function() {
  var overlay = document.getElementById('randomPickerOverlay');
  if (!overlay) return;
  overlay.classList.add('open');
  spinRandomGame();
};

window.closeRandomPicker = function() {
  var overlay = document.getElementById('randomPickerOverlay');
  if (overlay) overlay.classList.remove('open');
};

window.spinRandomGame = function() {
  var el = document.getElementById('randomPickerCard');
  if (!el) return;

  // Randomly pick quiz answers
  var energyKeys = ['chill', 'intense', 'think', 'surprise'];
  var timeKeys   = [30, 120, 240, 480];
  var modeKeys   = ['story', 'skill', 'strategic', 'cozy', 'fastpaced'];
  var chosenEnergy = energyKeys[Math.floor(Math.random() * energyKeys.length)];
  var chosenTime   = timeKeys[Math.floor(Math.random() * timeKeys.length)];
  var chosenMode   = modeKeys[Math.floor(Math.random() * modeKeys.length)];

  var energyLabels = { chill: '😌 Chill', intense: '🔥 Intense', think: '🧠 Thinky', surprise: '🎲 Surprise' };
  var timeLabels   = { 30: '30 min', 120: '2 hours', 240: '4 hours', 480: 'All day' };
  var modeLabels   = { story: '📖 Story', skill: '🎯 Skill', strategic: '♟ Strategic', cozy: '🛋 Cozy', fastpaced: '💨 Fast-paced' };

  var descriptions = {
    'chill-cozy':       'A relaxing, cozy game perfect for unwinding',
    'chill-story':      'A laid-back story to get lost in',
    'chill-strategic':  'A calm, thoughtful strategy session',
    'chill-skill':      'A gentle game to ease into',
    'chill-fastpaced':  'A light, breezy pick-up-and-play game',
    'intense-skill':    'A challenging game that will test your skills',
    'intense-fastpaced':'A high-energy, adrenaline-fueled experience',
    'intense-story':    'An action-packed adventure with a gripping story',
    'intense-strategic':'An intense, high-stakes strategy game',
    'intense-cozy':     'An exciting game with a fun, welcoming vibe',
    'think-strategic':  'A deep, brain-teasing strategy game',
    'think-story':      'A thoughtful, narrative-driven experience',
    'think-skill':      'A challenging puzzler that rewards mastery',
    'think-cozy':       'A relaxing game with satisfying depth',
    'think-fastpaced':  'A fast-thinking game that keeps you on your toes',
    'surprise-cozy':    'A wildcard pick — could be anything cozy',
    'surprise-story':   'A wildcard story — let fate decide',
    'surprise-skill':   'A random skill challenge awaits',
    'surprise-strategic':'A strategic surprise from your backlog',
    'surprise-fastpaced':'A random fast-paced pick — spin and see'
  };
  var timeDesc = { 30: 'in about 30 minutes', 120: 'over a couple of hours', 240: 'over a few hours', 480: 'for a long session' };
  var descKey  = chosenEnergy + '-' + chosenMode;
  var baseDesc = descriptions[descKey] || 'A randomly chosen game from your library';
  var fullDesc = baseDesc + ' — ' + timeDesc[chosenTime];

  // Rolling animation
  el.innerHTML =
  '<div class="random-roll-state">' +
    '<div class="random-roll-dice-wrap">' +
  '<div class="random-roll-spark"></div>' +
  '<div id="randomRollDie" style="display:inline-flex;color:var(--text);transform-origin:center center;position:relative;z-index:2;">' +
        '<svg viewBox="0 0 24 24" width="34" height="34">' +
          '<rect x="3" y="3" width="18" height="18" rx="5" fill="currentColor"/>' +
          '<circle cx="8" cy="8" r="1.4" fill="var(--bg)"/>' +
          '<circle cx="16" cy="16" r="1.4" fill="var(--bg)"/>' +
          '<circle cx="8" cy="16" r="1.4" fill="var(--bg)"/>' +
          '<circle cx="16" cy="8" r="1.4" fill="var(--bg)"/>' +
        '</svg>' +
      '</div>' +
    '</div>' +
    '<div class="random-roll-title">Rolling the dice...</div>' +
    '<div class="random-roll-tags">' +
      '<span class="random-roll-tag">' + energyLabels[chosenEnergy] + '</span>' +
      '<span class="random-roll-tag">⏱ ' + timeLabels[chosenTime] + '</span>' +
      '<span class="random-roll-tag">' + modeLabels[chosenMode] + '</span>' +
    '</div>' +
  '</div>';

  var dieEl = document.getElementById('randomRollDie');
var rollAngle = 0;
var rollTimer = null;

if (dieEl) {
  rrollTimer = setInterval(function() {
  rollAngle += 16;

  var scale = 1 + Math.sin(rollAngle * Math.PI / 180) * 0.07;
  var blur = 0.15 + Math.abs(Math.sin(rollAngle * Math.PI / 180)) * 0.5;

  dieEl.style.transform = 'rotate(' + rollAngle + 'deg) scale(' + scale + ')';
  dieEl.style.filter = 'drop-shadow(0 0 10px rgba(91,192,190,0.14)) blur(' + blur + 'px)';
}, 32);
}

  setTimeout(function() {
    var energy = PICKER_ENERGY_MAP[chosenEnergy] || PICKER_ENERGY_MAP.surprise;
    var time   = PICKER_TIME_MAP[chosenTime]     || PICKER_TIME_MAP[120];
    var mode   = PICKER_MODE_MAP[chosenMode]     || { genres: [], tagStems: [] };
    var isSurprise = !!energy.skip;

    var energyGenres  = energy.genres       || [];
    var timeGenres    = time.genres         || [];
    var timeStems     = time.tagStems       || [];
    var modeGenres    = mode.genres         || [];
    var energyStems   = energy.tagStems     || [];
    var modeStems     = mode.tagStems       || [];
    var energyPenalty = energy.penaltyStems || [];
    var modePenalty   = mode.penaltyStems   || [];

    function stemMatch(tag, stems) {
      var t = tag.toLowerCase();
      return stems.some(function(s) { return t.indexOf(s.toLowerCase()) !== -1; });
    }

    var candidates = games.filter(function(g) { return (g.playtimeHours||0) === 0 && !g.hidden && !g.gpCatalog; });
    if (!candidates.length) {
      el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">No unplayed games found!</div>';
      return;
    }

    var scored = candidates.map(function(g) {
      var gGenres = g.genres && g.genres.length ? g.genres : (g.genre ? [g.genre] : []);
      var allTags = [...new Set([...(g.tags||[]),...(g.steamTags||[])].map(function(t){return t.toLowerCase();}))];
      var quizScore = 0;
      var hasMetadata = gGenres.length || allTags.length;

      if (!isSurprise) {
        var genreBonus = 0;
        gGenres.forEach(function(gn) {
          if (energyGenres.some(function(eg){return eg.toLowerCase()===gn.toLowerCase();})) genreBonus+=3;
          if (timeGenres.some(function(tg){return tg.toLowerCase()===gn.toLowerCase();}))   genreBonus+=3;
          if (modeGenres.some(function(mg){return mg.toLowerCase()===gn.toLowerCase();}))   genreBonus+=3;
        });
        quizScore += Math.min(genreBonus, 9);
        var tagBonus = 0, tagPenalty = 0;
        allTags.forEach(function(t) {
          if (stemMatch(t,energyStems)||stemMatch(t,modeStems)||stemMatch(t,timeStems)) tagBonus+=1.5;
          if (stemMatch(t,energyPenalty)) tagPenalty+=2;
          if (stemMatch(t,modePenalty))   tagPenalty+=2;
        });
        quizScore += Math.min(tagBonus, 15);
        quizScore -= Math.min(tagPenalty, 15);
      }

      if (g.notForMeAt) {
        var daysSince = (Date.now() - new Date(g.notForMeAt).getTime()) / (1000*60*60*24);
        var pen = 8 * Math.pow(0.5, daysSince/7);
        if (pen > 0.25) quizScore -= pen;
      }

      if (g.metacriticScore >= 90) quizScore += 2;
      else if (g.metacriticScore >= 80) quizScore += 1;
      if (g.userRating > 0) quizScore += g.userRating * 0.3;
      if (!hasMetadata) quizScore = Math.min(quizScore, 1);

      var finalScore = isSurprise
        ? (1 + (g.metacriticScore>=90?2:g.metacriticScore>=80?1:0) + (g.userRating||0)*0.3)
        : quizScore;

      return { game: g, score: finalScore * (0.8 + Math.random() * 0.4), genres: gGenres, tags: allTags };
    }).sort(function(a,b){ return b.score - a.score; });

    var MIN_SCORE = isSurprise ? 0.5 : 3.0;
    var qualifying = scored.filter(function(s){ return s.score >= MIN_SCORE; });
    if (qualifying.length < 3) qualifying = scored.slice(0, Math.min(15, scored.length));
    var topScore = qualifying.length ? qualifying[0].score : 1;
    var pool = qualifying.filter(function(s){ return s.score >= topScore * 0.75; }).slice(0, 12);
    if (!pool.length) pool = qualifying.slice(0, 5);

    var totalWeight = pool.reduce(function(s,e){ return s + Math.max(0.1, e.score); }, 0);
    var r2 = Math.random() * totalWeight;
    var pick = pool[0];
    for (var i = 0; i < pool.length; i++) {
      r2 -= Math.max(0.1, pool[i].score);
      if (r2 <= 0) { pick = pool[i]; break; }
    }

    if (rollTimer) clearInterval(rollTimer);
    if (dieEl) {
  dieEl.style.filter = 'drop-shadow(0 0 10px rgba(91,192,190,0.10))';
  dieEl.style.transition = 'transform 260ms cubic-bezier(.2,.9,.3,1)';
dieEl.style.transform = 'rotate(' + (rollAngle + 40) + 'deg) scale(1)';

}

    var g2   = pick.game;
    var cUrl = coverCache[g2.id] || coverCache[String(g2.id)];
    var pal  = COVER_PALETTES[(g2.pal||0) % COVER_PALETTES.length];
    var displayTags = pick.tags.slice(0, 6);
    var metaColor = g2.metacriticScore >= 80 ? '#4ade80' : g2.metacriticScore >= 60 ? '#facc15' : '#f87171';

    el.innerHTML =
      '<div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-bottom:14px">' +
        '<span style="font-size:10px;padding:3px 8px;background:rgba(91,163,245,0.12);border:1px solid rgba(91,163,245,0.3);border-radius:5px;color:var(--steam)">' + energyLabels[chosenEnergy] + '</span>' +
        '<span style="font-size:10px;padding:3px 8px;background:rgba(91,163,245,0.12);border:1px solid rgba(91,163,245,0.3);border-radius:5px;color:var(--steam)">&#9201; ' + timeLabels[chosenTime] + '</span>' +
        '<span style="font-size:10px;padding:3px 8px;background:rgba(91,163,245,0.12);border:1px solid rgba(91,163,245,0.3);border-radius:5px;color:var(--steam)">' + modeLabels[chosenMode] + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:16px;align-items:flex-start;margin-bottom:14px">' +
        '<div style="width:90px;height:120px;border-radius:8px;overflow:hidden;flex-shrink:0;background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ');box-shadow:0 8px 24px rgba(0,0,0,0.4)">' +
          (cUrl ? '<img src="' + cUrl + '" style="width:100%;height:100%;object-fit:cover">' : '') +
        '</div>' +
        '<div style="flex:1;min-width:0;padding-top:2px">' +
          '<div style="font-size:17px;font-weight:900;line-height:1.2;margin-bottom:5px">' + escHtml(g2.title) + '</div>' +
          '<div style="font-size:11px;color:var(--text3);margin-bottom:8px">' + escHtml(pick.genres.slice(0,3).join(' · ')) + '</div>' +
          (displayTags.length ?
            '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">' +
              displayTags.map(function(t){ return '<span style="font-size:9px;padding:2px 6px;border-radius:4px;background:var(--surface3);border:1px solid var(--border);color:var(--text3)">' + escHtml(t) + '</span>'; }).join('') +
            '</div>' : '') +
          (g2.metacriticScore ? '<span style="font-size:11px;font-weight:800;color:' + metaColor + ';background:rgba(0,0,0,0.25);padding:2px 8px;border-radius:5px">' + g2.metacriticScore + ' MC</span>' : '') +
        '</div>' +
      '</div>' +
      '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:9px 12px;margin-bottom:14px;font-size:11px;color:var(--text3)">' +
        '&#10022; ' + escHtml(fullDesc) +
      '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="settings-btn" style="flex:1;font-size:12px;padding:9px;background:var(--steam);color:#000;border-color:var(--steam);font-weight:800;justify-content:center" ' +
          'onclick="closeRandomPicker();openGameDetailById(' + g2.id + ')">&#9658; Play This</button>' +
        '<button class="settings-btn" style="font-size:12px;padding:9px 14px" onclick="spinRandomGame()">&#9861; Try Again</button>' +
      '</div>';

  }, 800);
};

// ── BULK COVER ART FETCH ──

async function bulkFetchMissingArt(forceAll) {
  if (!igdbClientId || !igdbClientSecret) {
    var fb = document.getElementById('igdbFeedback');
    if (fb) { fb.textContent = '⚠ Add IGDB credentials and save them first.'; fb.className = 'settings-feedback err'; }
    showStatus('⚠ Add IGDB credentials in Settings first', 100, {type:'error'});
    return;
  }

  var btn = document.getElementById(forceAll ? 'igdbRefetchAllBtn' : 'igdbRefreshBtn');
  var fb  = document.getElementById('igdbFeedback');
  var missing = games.filter(function(g) { return !coverCache[g.id] && !coverCache[String(g.id)]; }).length;

  if (btn) { btn.disabled = true; btn.textContent = forceAll ? 'Starting re-fetch…' : 'Starting fetch…'; }
  if (fb) {
    fb.textContent = forceAll
      ? '↻ Re-fetching all cover art from scratch — this runs in the background and may take several minutes.'
      : '↻ Fetching cover art for ' + missing + ' game' + (missing !== 1 ? 's' : '') + ' — running in the background.';
    fb.className = 'settings-feedback ok';
  }

  if (forceAll) {
    coverCache = {};
    await window.nexus.covers.saveCache({});
  }

  await fetchCoversInBackground();

  if (btn) { btn.disabled = false; btn.textContent = forceAll ? '⚠ Re-fetch All Art' : '🔄 Fetch Missing Art'; }
  if (fb) { fb.textContent = '✓ Cover art fetch complete.'; fb.className = 'settings-feedback ok'; }
}

// ── FULL RESET ──

function openFullResetDialog() {
  document.getElementById('resetConfirmInput').value = '';
  document.getElementById('resetConfirmBtn').disabled = true;
  document.getElementById('fullResetOverlay').classList.add('open');
}

function closeFullResetDialog() {
  document.getElementById('fullResetOverlay').classList.remove('open');
}

function openResetSessionsDialog() {
  document.getElementById('resetSessionsOverlay').classList.add('open');
}

function closeResetSessionsDialog() {
  document.getElementById('resetSessionsOverlay').classList.remove('open');
}

async function executeResetSessions() {
  try {
    showStatus('Wiping session history…', -1);
    var sessionData = await window.nexus.store.getByPrefix('sessions:') || {};
    for (var key of Object.keys(sessionData)) {
      await window.nexus.store.delete(key);
    }
    closeResetSessionsDialog();
    showStatus('✓ Session history cleared', 100, {type:'success'});
  } catch(e) {
    showStatus('✗ Failed: ' + e.message, 100, {type:'error'});
  }
}

async function executeFullReset() {
  try {
    showStatus('Wiping all data…', -1);
    await window.nexus.app.fullReset();
    // Wipe cover cache file too
    await window.nexus.covers.saveCache({});

    // Wipe all session data (stored as sessions:{gameId} keys)
    try {
      var sessionData = await window.nexus.store.getByPrefix('sessions:') || {};
      for (var key of Object.keys(sessionData)) {
        await window.nexus.store.delete(key);
      }
    } catch(e) {}

    // Wipe goals, wishlist, friend history, hint-seen flags, sync reminders
    var storeKeysToClear = [
      'playtimeGoals', 'friendHistory',
      'syncReminderDismissed'
    ];
    for (var k of storeKeysToClear) {
      try { await window.nexus.store.set(k, null); } catch(e) {}
    }
    // Clear all hint.seen.* flags
    try {
      var pages = ['library','discovery','stats','habits','goals','friends','wishlist','wrapped','settings'];
      for (var p of pages) { await window.nexus.store.set('hint.seen.' + p, false); }
    } catch(e) {}

    // Wipe wishlist via IPC
    try {
      var wl = await window.nexus.wishlist.getAll();
      for (var w of wl) { await window.nexus.wishlist.delete(w.id); }
      wishlist = [];
    } catch(e) {}

    // Reset ALL in-memory state
    games = [];
    coverCache = {};
    igdbClientId = '';
    igdbClientSecret = '';
    rawgApiKey = '';
    ggdealsApiKey = '';
    openxblApiKey = '';

    // Clear all Settings input fields and placeholders so nothing lingers
    var fieldsToClear = [
      'steamId', 'steamKey',
      'igdbClientId', 'igdbClientSecret',
      'rawgApiKey', 'ggdealsApiKey', 'openxblApiKey'
    ];
    fieldsToClear.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) { el.value = ''; el.placeholder = ''; }
    });

    // Stop any running Steam auto-tracker
    if (typeof stopSteamAutoTracking === 'function') stopSteamAutoTracking();

    closeFullResetDialog();
    renderAll();
    showStatus('✓ Reset complete — all data and credentials wiped', 100, {type:'success'});
    // Launch onboarding after short delay
    setTimeout(function() { openOnboarding(true); }, 1500);
  } catch(e) {
    showStatus('✗ Reset failed: ' + e.message, 100, {type:'error'});
  }
}

// ── ONBOARDING WIZARD ──

var onboardStep = 0;
var onboardSteps = [
  {
    title: 'Welcome to Backlog Zero',
    subtitle: 'Your unified game library, classified.',
    render: function() {
      return '<div style="text-align:center;padding:10px 0 20px">' +
        '<div style="font-size:48px;margin-bottom:16px">🎮</div>' +
        '<div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:10px">Let\'s get you set up</div>' +
        '<div style="font-size:13px;color:var(--text3);line-height:1.7;max-width:400px;margin:0 auto">' +
          'Nexus pulls your games from Steam, GOG, Epic, Xbox, and more into one place. ' +
          'We\'ll walk through connecting each account. You can skip any step and do it later in Settings.' +
        '</div>' +
      '</div>';
    }
  },
  {
    title: 'Steam Integration',
    subtitle: 'Import your Steam library automatically',
    render: function() {
      return '<div class="onboard-platform-card">' +
        '<h3>🔵 Steam</h3>' +
        '<div class="onboard-field-desc">Steam has a public API. You\'ll need your Steam ID (a 17-digit number) and a free API key.</div>' +
        '<div class="onboard-field-group">' +
          '<div class="onboard-field-label">Steam ID</div>' +
          '<div class="onboard-field-row">' +
            '<input class="settings-input" id="ob-steamId" placeholder="76561198000000000" style="flex:1">' +
          '</div>' +
          '<div style="font-size:11px;color:var(--text3);margin-top:5px">Find it at <a href="#" data-href="https://store.steampowered.com/account/" class="settings-link">store.steampowered.com/account</a></div>' +
        '</div>' +
        '<div class="onboard-field-group">' +
          '<div class="onboard-field-label">Steam API Key</div>' +
          '<div class="onboard-field-row">' +
            '<input class="settings-input" id="ob-steamKey" placeholder="Your Steam API key" style="flex:1">' +
            '<button class="settings-btn" onclick="obConnectSteam()">Connect</button>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--text3);margin-top:5px">Get a free key at <a href="#" data-href="https://steamcommunity.com/dev/apikey" class="settings-link">steamcommunity.com/dev/apikey</a></div>' +
        '</div>' +
        '<div id="ob-steamStatus"></div>' +
        '<span class="onboard-skip-link" onclick="obNext()">Skip Steam for now →</span>' +
      '</div>';
    }
  },
  {
    title: 'Steam App Database',
    subtitle: 'A one-time download that powers game search',
    render: function() {
      return '<div class="onboard-platform-card">' +
        '<h3>🗂 Steam App Database</h3>' +
        '<div class="onboard-field-desc" style="margin-bottom:12px">' +
          'Nexus keeps a local copy of Steam\'s full game catalog — over 50,000 titles. ' +
          'This is what powers the game search when adding games manually, and lets Nexus match games across platforms without needing to call Steam\'s servers every time.' +
        '</div>' +
        '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:11px;color:var(--text2);line-height:1.8">' +
          '<strong style="color:var(--text)">What it does:</strong><br>' +
          '· Maps game names → Steam App IDs for accurate cover art and metadata<br>' +
          '· Powers the "Add Game" search across your whole library<br>' +
          '· Stored locally — only downloaded once, refreshed on demand<br><br>' +
          '<strong style="color:var(--text)">⏱ This takes 1–3 minutes</strong> depending on your connection. Steam\'s API is paginated so we fetch it in chunks.' +
        '</div>' +
        '<div id="ob-steamCacheProgress" style="display:none;margin-bottom:12px">' +
          '<div class="steam-dl-bar-track"><div class="steam-dl-bar-fill" id="ob-steamDlFill"></div></div>' +
          '<div id="ob-steamDlLabel" style="font-size:11px;color:var(--text3);margin-top:6px">Starting…</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<button class="settings-btn" id="ob-steamCacheBtn" onclick="obDownloadSteamDB()" style="background:var(--accent);color:#fff;border-color:var(--accent);font-weight:700">Download Database</button>' +
          '<span id="ob-steamCacheStatus" style="font-size:11px;color:var(--text3)"></span>' +
        '</div>' +
        '<div id="ob-steamCacheFeedback" style="margin-top:8px"></div>' +
        '<span class="onboard-skip-link" onclick="obNext()">Skip for now — I\'ll do this in Settings →</span>' +
      '</div>';
    }
  },
  {
    title: 'Cover Art — IGDB',
    subtitle: 'Get beautiful cover art for all your games',
    render: function() {
      return '<div class="onboard-platform-card">' +
        '<h3>🎨 IGDB (Internet Game Database)</h3>' +
        '<div class="onboard-field-desc">Steam games get cover art automatically. For GOG, Epic, and other games, Nexus uses IGDB — free with a Twitch developer account.</div>' +
        '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:14px;font-size:11px;color:var(--text2);line-height:1.7">' +
          '<strong style="color:var(--text)">Quick setup:</strong><br>' +
          '1. Go to <a href="#" data-href="https://dev.twitch.tv/console" class="settings-link">dev.twitch.tv/console</a><br>' +
          '2. Register an application (any name, any URL)<br>' +
          '3. Copy your Client ID and generate a Client Secret' +
        '</div>' +
        '<div class="onboard-field-group">' +
          '<div class="onboard-field-label">IGDB Client ID</div>' +
          '<input class="settings-input" id="ob-igdbId" placeholder="IGDB Client ID" style="width:100%">' +
        '</div>' +
        '<div class="onboard-field-group">' +
          '<div class="onboard-field-label">IGDB Client Secret</div>' +
          '<div class="onboard-field-row">' +
            '<input class="settings-input" id="ob-igdbSecret" placeholder="IGDB Client Secret" style="flex:1">' +
            '<button class="settings-btn" onclick="obSaveIGDB()">Save</button>' +
          '</div>' +
        '</div>' +
        '<div id="ob-igdbStatus"></div>' +
        '<span class="onboard-skip-link" onclick="obNext()">Skip for now →</span>' +
      '</div>';
    }
  },
  {
  title: 'Epic, Amazon & GOG',
  subtitle: 'Import via their respective launchers',
  render: function() {
    return '<div class="onboard-platform-card">' +
      '<h3>🟡 Epic &nbsp;&amp;&nbsp; 🟠 Amazon &nbsp;&amp;&nbsp; 🟣 GOG</h3>' +
      '<div class="onboard-field-desc">These platforms are imported through their desktop launchers. Nexus reads their local library files directly — no API keys needed.</div>' +
      '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:10px;font-size:12px;color:var(--text2);line-height:1.9">' +
        '<strong style="color:var(--text)">🟡 Epic &amp; 🟠 Amazon — via Heroic Games Launcher</strong><br>' +
        '1. Install <a href="#" data-href="https://heroicgameslauncher.com" class="settings-link">Heroic Games Launcher</a><br>' +
        '2. Log into your Epic and/or Amazon account in Heroic<br>' +
        '3. Let the library sync at least once<br>' +
        '4. Then use <strong style="color:var(--text)">Settings → Import Epic / Amazon via Heroic</strong>' +
      '</div>' +
      '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:12px;color:var(--text2);line-height:1.9">' +
        '<strong style="color:var(--text)">🟣 GOG — via GOG Galaxy</strong><br>' +
        '1. Install <a href="#" data-href="https://www.gog.com/galaxy" class="settings-link">GOG Galaxy</a><br>' +
        '2. Log into your GOG account<br>' +
        '3. Let the library sync at least once<br>' +
        '4. Then use <strong style="color:var(--text)">Settings → Import GOG via Galaxy</strong>' +
      '</div>' +
      '<div style="background:rgba(99,179,237,0.07);border:1px solid rgba(99,179,237,0.2);border-radius:8px;padding:10px 14px;font-size:11px;color:var(--text3);line-height:1.7;margin-bottom:14px">' +
        '💡 Nexus reads local library files — no logins or API keys required once the launchers are installed and synced.' +
      '</div>' +
      '<span class="onboard-skip-link" onclick="obNext()">Skip — I\'ll set these up later in Settings →</span>' +
    '</div>';
  }
},
  {
    title: 'Xbox & Game Pass',
    subtitle: 'Connect your Xbox account via OpenXBL',
    render: function() {
      return '<div class="onboard-platform-card">' +
        '<h3>🟩 Xbox / PC Game Pass</h3>' +
        '<div class="onboard-field-desc">Connect via <strong>OpenXBL</strong> — a free community Xbox API. This imports your personal Xbox library and lets you browse the Game Pass catalog.</div>' +
        '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:14px;font-size:11px;color:var(--text2);line-height:1.7">' +
          '<strong style="color:var(--text)">Setup:</strong><br>' +
          '1. Go to <a href="#" data-href="https://xbl.io" class="settings-link">xbl.io</a> and create a free account<br>' +
          '2. Sign in with your Xbox account<br>' +
          '3. Copy your API key from your profile page' +
        '</div>' +
        '<div class="onboard-field-group">' +
          '<div class="onboard-field-label">OpenXBL API Key</div>' +
          '<div class="onboard-field-row">' +
            '<input class="settings-input" id="ob-xblKey" placeholder="OpenXBL API Key" style="flex:1">' +
            '<button class="settings-btn" onclick="obSaveXBL()">Connect</button>' +
          '</div>' +
        '</div>' +
        '<div id="ob-xblStatus"></div>' +
        '<span class="onboard-skip-link" onclick="obNext()">Skip Xbox for now →</span>' +
      '</div>';
    }
  },
  {
    title: 'Optional: Prices & Metadata',
    subtitle: 'Two free API keys that make Backlog Zero significantly more useful',
    render: function() {
      return '<div style="display:flex;flex-direction:column;gap:16px">' +

        '<div class="onboard-platform-card" style="border-color:rgba(74,222,128,0.25)">' +
          '<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px">' +
            '<span style="font-size:22px;line-height:1;flex-shrink:0">&#x1F4B0;</span>' +
            '<div>' +
              '<h3 style="margin:0 0 3px">Price Tracking &mdash; gg.deals</h3>' +
              '<div style="font-size:12px;color:var(--text3);line-height:1.6">' +
                'Backlog Zero can monitor prices for every game on your wishlist across 40+ stores &mdash; Steam, Humble, Epic, Fanatical, key resellers and more. ' +
                'Set a target price or a % discount alert and get notified when a game hits your threshold. ' +
                'You can also see the all-time historical low for any game at a glance.' +
              '</div>' +
              '<div style="margin-top:6px;font-size:11px;color:var(--text3)">Completely free. Get your key at <a href="#" data-href="https://gg.deals/api/" class="settings-link">gg.deals/api</a> &mdash; just sign in and copy it.</div>' +
            '</div>' +
          '</div>' +
          '<div class="onboard-field-row">' +
            '<input class="settings-input" id="ob-ggKey" placeholder="Paste your gg.deals API key here&hellip;" style="flex:1">' +
            '<button class="settings-btn" onclick="obSaveGGDeals()">Save</button>' +
          '</div>' +
          '<div id="ob-ggStatus"></div>' +
        '</div>' +

        '<div class="onboard-platform-card" style="border-color:rgba(168,85,247,0.2)">' +
          '<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px">' +
            '<span style="font-size:22px;line-height:1;flex-shrink:0">&#x1F5C4;&#xFE0F;</span>' +
            '<div>' +
              '<h3 style="margin:0 0 3px">Game Database &mdash; RAWG</h3>' +
              '<div style="font-size:12px;color:var(--text3);line-height:1.6">' +
                'Steam games come pre-loaded with metadata, but GOG, Epic, Xbox and Amazon games often have no descriptions, genres, or scores. ' +
                'RAWG fills that gap &mdash; it enriches your non-Steam library with Metacritic scores, genre tags, and descriptions ' +
                'so every game in Backlog Zero feels complete, regardless of where you bought it.' +
              '</div>' +
              '<div style="margin-top:6px;font-size:11px;color:var(--text3)">Free for personal use. Sign up at <a href="#" data-href="https://rawg.io/apidocs" class="settings-link">rawg.io/apidocs</a> and grab your key.</div>' +
            '</div>' +
          '</div>' +
          '<div class="onboard-field-row">' +
            '<input class="settings-input" id="ob-rawgKey" placeholder="Paste your RAWG API key here&hellip;" style="flex:1">' +
            '<button class="settings-btn" onclick="obSaveRawg()">Save</button>' +
          '</div>' +
          '<div id="ob-rawgStatus"></div>' +
        '</div>' +

      '</div>';
    }
  },
  {
    title: 'You\'re all set!',
    subtitle: 'Start exploring your library',
    render: function() {
      return '<div style="text-align:center;padding:10px 0 20px">' +
        '<div style="font-size:48px;margin-bottom:16px">✅</div>' +
        '<div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:10px">Setup complete!</div>' +
        '<div style="font-size:13px;color:var(--text3);line-height:1.7;max-width:400px;margin:0 auto">' +
          'You can always add or change your API keys in <strong style="color:var(--text)">Settings</strong>. ' +
          'Epic and Amazon Games require <strong style="color:var(--text)">Heroic Games Launcher</strong> to be installed and synced first — then import them from Settings.<br><br>' +
          'Your backlog won\'t clear itself — let\'s change that.' +
        '</div>' +
      '</div>';
    }
  }
];

async function openOnboarding(isFirstLaunch) {
  // Check if already completed (unless forced)
  if (!isFirstLaunch) {
    document.getElementById('onboardingOverlay').classList.add('open');
    onboardStep = 0;
    renderOnboardStep();
    return;
  }
  var done = await window.nexus.store.get('onboardingComplete');
  if (done) return;
  document.getElementById('onboardingOverlay').classList.add('open');
  onboardStep = 0;
  renderOnboardStep();
}

function closeOnboarding() {
  document.getElementById('onboardingOverlay').classList.remove('open');
  window.nexus.store.get('onboardingComplete').then(function(wasDone) {
    window.nexus.store.set('onboardingComplete', true);
    if (!wasDone) showWelcomeHint();
  });
}

function renderOnboardStep() {
  var step = onboardSteps[onboardStep];
  document.getElementById('onboardTitle').textContent = step.title;
  document.getElementById('onboardSubtitle').textContent = step.subtitle;
  document.getElementById('onboardBody').innerHTML = step.render();
  document.getElementById('onboardStepLabel').textContent = (onboardStep + 1) + ' of ' + onboardSteps.length;

  // Dots
  var dotsEl = document.getElementById('onboardDots');
  dotsEl.innerHTML = '';
  onboardSteps.forEach(function(_, i) {
    var d = document.createElement('div');
    d.className = 'onboard-step-dot' + (i === onboardStep ? ' active' : i < onboardStep ? ' done' : '');
    d.onclick = function() { onboardStep = i; renderOnboardStep(); };
    dotsEl.appendChild(d);
  });

  // Buttons
  var prevBtn = document.getElementById('onboardPrevBtn');
  var nextBtn = document.getElementById('onboardNextBtn');
  prevBtn.style.opacity = onboardStep === 0 ? '0.3' : '1';
  prevBtn.disabled = onboardStep === 0;
  var isLast = onboardStep === onboardSteps.length - 1;
  nextBtn.textContent = isLast ? '✓ Done' : 'Next →';
  nextBtn.onclick = isLast ? closeOnboarding : obNext;
  prevBtn.onclick = function() { if (onboardStep > 0) { onboardStep--; renderOnboardStep(); } };

  document.getElementById('onboardCloseBtn').onclick = closeOnboarding;
}

function obNext() {
  if (onboardStep < onboardSteps.length - 1) {
    onboardStep++;
    renderOnboardStep();
  } else {
    closeOnboarding();
  }
}

async function obConnectSteam() {
  var id  = (document.getElementById('ob-steamId')  || {}).value || '';
  var key = (document.getElementById('ob-steamKey') || {}).value || '';
  var st  = document.getElementById('ob-steamStatus');
  if (!id || !key) { st.innerHTML = '<div class="onboard-status err">Please enter both your Steam ID and API key.</div>'; return; }
  st.innerHTML = '<div class="onboard-status info">Connecting to Steam…</div>';
  showStatus('Importing Steam library…', -1);
  try {
    var result = await window.nexus.steam.importLibrary(id.trim(), key.trim());
    games = await window.nexus.games.getAll();
    renderAll();
    hideStatus();
    st.innerHTML = '<div class="onboard-status ok">✓ Connected! Imported ' + result.total + ' games.</div>';
    setTimeout(obNext, 1500);
  } catch(e) {
    hideStatus();
    st.innerHTML = '<div class="onboard-status err">✗ ' + e.message + '</div>';
  }
}

async function obSaveIGDB() {
  var id     = (document.getElementById('ob-igdbId')     || {}).value || '';
  var secret = (document.getElementById('ob-igdbSecret') || {}).value || '';
  var st     = document.getElementById('ob-igdbStatus');
  if (!id || !secret) { st.innerHTML = '<div class="onboard-status err">Enter both Client ID and Secret.</div>'; return; }
  st.innerHTML = '<div class="onboard-status info">Saving…</div>';
  try {
    await window.nexus.covers.saveIGDBCredentials(id.trim(), secret.trim());
    igdbClientId = id.trim();
    igdbClientSecret = secret.trim();
    st.innerHTML = '<div class="onboard-status ok">✓ IGDB credentials saved! Cover art will load automatically.</div>';
    setTimeout(obNext, 1500);
  } catch(e) {
    st.innerHTML = '<div class="onboard-status err">✗ ' + e.message + '</div>';
  }
}

async function obSaveXBL() {
  var key = (document.getElementById('ob-xblKey') || {}).value || '';
  var st  = document.getElementById('ob-xblStatus');
  if (!key) { st.innerHTML = '<div class="onboard-status err">Enter your OpenXBL API key.</div>'; return; }
  st.innerHTML = '<div class="onboard-status info">Testing key…</div>';
  try {
    var result = await window.nexus.xbox.request('/api/v2/account', key.trim());
    if (result.error) throw new Error('Invalid key (HTTP ' + result.status + ')');
    await window.nexus.store.set('openxblApiKey', key.trim());
    openxblApiKey = key.trim();
    var gamertag = '';
    try {
      var gt = result.data.profileUsers[0].settings.find(function(s){ return s.id === 'Gamertag'; });
      if (gt) gamertag = gt.value;
    } catch(e) {}
    st.innerHTML = '<div class="onboard-status ok">✓ Connected' + (gamertag ? ' as ' + gamertag : '') + '!</div>';
    setTimeout(obNext, 1500);
  } catch(e) {
    st.innerHTML = '<div class="onboard-status err">✗ ' + e.message + '</div>';
  }
}

async function obSaveGGDeals() {
  var key = (document.getElementById('ob-ggKey') || {}).value || '';
  var st  = document.getElementById('ob-ggStatus');
  if (!key) return;
  await window.nexus.prices.saveKey(key.trim());
  ggdealsApiKey = key.trim();
  st.innerHTML = '<div class="onboard-status ok">✓ gg.deals key saved!</div>';
}

async function obSaveRawg() {
  var key = (document.getElementById('ob-rawgKey') || {}).value || '';
  var st  = document.getElementById('ob-rawgStatus');
  if (!key) return;
  await window.nexus.store.set('rawgApiKey', key.trim());
  rawgApiKey = key.trim();
  st.innerHTML = '<div class="onboard-status ok">✓ RAWG key saved!</div>';
}

async function obDownloadSteamDB() {
  var btn      = document.getElementById('ob-steamCacheBtn');
  var progress = document.getElementById('ob-steamCacheProgress');
  var barFill  = document.getElementById('ob-steamDlFill');
  var barLabel = document.getElementById('ob-steamDlLabel');
  var feedback = document.getElementById('ob-steamCacheFeedback');
  var status   = document.getElementById('ob-steamCacheStatus');

  if (btn) { btn.disabled = true; btn.textContent = 'Downloading…'; }
  if (progress) progress.style.display = 'block';
  if (barFill) { barFill.style.width = '0%'; barFill.classList.remove('indeterminate'); }
  if (barLabel) barLabel.textContent = 'Connecting to Steam…';
  if (feedback) { feedback.textContent = ''; feedback.className = 'settings-feedback'; }

  window.nexusEvents.onSteamAppListProgress(function(data) {
    if (!barFill || !barLabel) return;
    if (data.stage === 'downloading') {
      if (data.pct >= 0) {
        barFill.classList.remove('indeterminate');
        barFill.style.width = data.pct + '%';
        barLabel.textContent = 'Fetching… ' + data.mb + ' (' + data.pct + '%)';
      } else {
        barFill.classList.add('indeterminate');
        barLabel.textContent = 'Fetching… ' + data.mb;
      }
    } else if (data.stage === 'parsing')  { barFill.style.width = '85%'; barLabel.textContent = 'Parsing game list…'; }
    else if (data.stage === 'indexing')   { barFill.style.width = '90%'; barLabel.textContent = 'Building search index…'; }
    else if (data.stage === 'saving')     { barFill.style.width = '97%'; barLabel.textContent = 'Saving to disk…'; }
    else if (data.stage === 'done')       { barFill.style.width = '100%'; barLabel.textContent = data.count.toLocaleString() + ' games indexed — done!'; }
  });

  try {
    var result = await window.nexus.steam.refreshAppList();
    if (barFill) barFill.style.width = '100%';
    if (feedback) {
      feedback.textContent = '✓ Downloaded ' + result.count.toLocaleString() + ' Steam titles.';
      feedback.className = 'settings-feedback ok';
    }
    if (status) status.textContent = result.count.toLocaleString() + ' titles ready';
    if (btn) { btn.textContent = '✓ Done'; btn.style.background = '#4ade80'; btn.style.borderColor = '#4ade80'; }
  } catch(e) {
    if (feedback) { feedback.textContent = '✗ ' + e.message; feedback.className = 'settings-feedback err'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
  }
}

// ══════════════════════════════════════════════════════
// PLAY NEXT — PERSISTENT BACKLOG RECOMMENDATIONS
// ══════════════════════════════════════════════════════

var playNextCollapsed  = (localStorage.getItem('playNextCollapsed') === 'true');
var playNextShownIds   = new Set(); // session exclusion — no repeats on refresh

function renderPlayNext() {
  var section = document.getElementById('playNextSection');
  if (!section) return;

  var backlog = games.filter(function(g) { return (g.playtimeHours||0) === 0 && !g.hidden && !g.gpCatalog; });
  if (backlog.length < 3) { section.innerHTML = ''; return; }

  var scored = scorePlayNext(backlog);
  if (!scored.length) { section.innerHTML = ''; return; }

  // Split into stable top band and varied lower band
  var topScore  = scored[0].score;
  var stable    = scored.filter(function(s) { return s.score >= topScore * 0.75; }).slice(0, 2);
  var varied    = scored.filter(function(s) { return s.score < topScore * 0.75 && !playNextShownIds.has(s.game.id); });
  // Jitter the varied band
  varied = varied.map(function(s) {
    return { game: s.game, score: s.score * (0.7 + Math.random() * 0.6) };
  }).sort(function(a,b) { return b.score - a.score; });

  var picks = [];
  // Add stable picks (always shown, no exclusion)
  stable.forEach(function(s) { if (picks.length < 2) picks.push(s.game); });
  // Fill remaining 3 slots from varied band, excluding shown
  var fresh = varied.filter(function(s) { return !playNextShownIds.has(s.game.id); });
  fresh.forEach(function(s) { if (picks.length < 5) picks.push(s.game); });
  // If not enough fresh, relax exclusion
  if (picks.length < 4) {
    playNextShownIds = new Set();
    varied.forEach(function(s) { if (picks.length < 5 && !picks.find(function(p){return p.id===s.game.id;})) picks.push(s.game); });
  }

  picks.forEach(function(g) { playNextShownIds.add(g.id); });

  // Auto-assign 'playnext' intent to stable top picks
  picks.slice(0, 2).forEach(async function(g) {
    if (!g.intent && INTENT_ELIGIBLE(g)) {
      await window.nexus.games.update(g.id, { intent: 'playnext' });
      g.intent = 'playnext';
    }
  });

  var count = picks.length;
  section.innerHTML =
    '<div style="border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:12px;background:var(--surface)">' +
      // Header
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;cursor:pointer;user-select:none" onclick="togglePlayNext()">' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="font-size:12px">' + (playNextCollapsed ? '▶' : '▼') + '</span>' +
          '<span style="font-size:12px;font-weight:700;color:var(--text)">Play Next</span>' +
          '<span style="font-size:10px;color:var(--text3)">' + count + ' picks from your backlog</span>' +
        '</div>' +
        '<button class="settings-btn" style="font-size:10px;padding:4px 10px" ' +
          'onclick="event.stopPropagation();refreshPlayNext()">↻ Refresh</button>' +
      '</div>' +
      // Cards
      (playNextCollapsed ? '' :
        '<div style="display:flex;gap:10px;padding:0 14px 14px;overflow-x:auto;scrollbar-width:thin">' +
          picks.map(function(g) { return buildPlayNextCard(g, scored); }).join('') +
        '</div>'
      ) +
    '</div>';
}

function scorePlayNext(backlog) {
  // Build affinity weights from play history
  var genreWeight = {}, tagWeight = {};
  var played = games.filter(function(g) { return (g.playtimeHours||0) > 0; });
  var avgSession = 60; // default minutes

  // Calculate average session length from history
  var totalSessions = 0, totalMins = 0;
  played.forEach(function(g) {
    if (g.sessions && g.sessions.length) {
      g.sessions.forEach(function(s) {
        if (s.durationMins && s.durationMins > 5 && s.durationMins < 480) {
          totalMins += s.durationMins; totalSessions++;
        }
      });
    }
  });
  if (totalSessions > 3) avgSession = totalMins / totalSessions;

  // Accumulate genre and tag weights (log scale to prevent dominance)
  played.forEach(function(g) {
    var hrs = Math.log(1 + (g.playtimeHours || 0));
    var gGenres = g.genres && g.genres.length ? g.genres : (g.genre ? [g.genre] : []);
    gGenres.forEach(function(gn) {
      if (gn && gn !== 'Other') genreWeight[gn.toLowerCase()] = (genreWeight[gn.toLowerCase()]||0) + hrs;
    });
    var allTags = [...(g.tags||[]),...(g.steamTags||[])];
    allTags.forEach(function(t) {
      if (t) tagWeight[t.toLowerCase()] = (tagWeight[t.toLowerCase()]||0) + hrs;
    });
  });

  // Normalise weights to 0–1
  var maxG = Math.max.apply(null, Object.values(genreWeight).concat([1]));
  var maxT = Math.max.apply(null, Object.values(tagWeight).concat([1]));
  Object.keys(genreWeight).forEach(function(k) { genreWeight[k] /= maxG; });
  Object.keys(tagWeight).forEach(function(k)   { tagWeight[k]   /= maxT; });

  var now = Date.now();

  return backlog.map(function(g) {
    var score = 0;

    // 1. Genre affinity (max 9)
    var gGenres = g.genres && g.genres.length ? g.genres : (g.genre ? [g.genre] : []);
    var genreBonus = 0;
    gGenres.forEach(function(gn) { genreBonus += (genreWeight[gn.toLowerCase()]||0) * 3; });
    score += Math.min(genreBonus, 9);

    // 2. Tag similarity (max 9)
    var allTags = [...new Set([...(g.tags||[]),...(g.steamTags||[])].map(function(t){return t.toLowerCase();}))];
    var tagBonus = 0;
    allTags.forEach(function(t) { tagBonus += (tagWeight[t]||0) * 1.5; });
    score += Math.min(tagBonus, 9);

    // 3. Library age — rediscovery boost (max 4)
    if (g.addedAt) {
      var daysSince = (now - new Date(g.addedAt).getTime()) / 86400000;
      if      (daysSince > 730) score += 4;   // 2+ years
      else if (daysSince > 180) score += 2.5; // 6+ months
      else if (daysSince > 30)  score += 1;   // 1+ month
      else                      score += 0.5; // new purchase bias
    }

    // 4. Session length fit (max 2)
    if (g.avgPlaytime) {
      var gameMins = g.avgPlaytime * 60;
      var ratio    = gameMins > 0 ? Math.min(avgSession, gameMins) / Math.max(avgSession, gameMins) : 0;
      score += ratio * 2;
    }

    // 5. Quality (max 3)
    if (g.metacriticScore >= 90)      score += 3;
    else if (g.metacriticScore >= 80) score += 2;
    else if (g.metacriticScore >= 70) score += 1;
    if (g.userRating > 0) score += g.userRating * 0.3;

    // 6. Momentum boost — decaying boost from recent Steam session (max ~3)
    if (g.momentumAt) {
      var daysMom = (now - new Date(g.momentumAt).getTime()) / 86400000;
      if (daysMom < 7) {
        var boost = 3.0 * Math.pow(0.5, daysMom / 3.5);
        score += boost;
      }
    }

    // 7. Not for me decay penalty
    if (g.notForMeAt) {
      var daysNFM = (now - new Date(g.notForMeAt).getTime()) / 86400000;
      var pen = 8 * Math.pow(0.5, daysNFM / 7);
      if (pen > 0.25) score -= pen;
    }

    return { game: g, score: score, genres: gGenres, tags: allTags };
  }).filter(function(s) { return s.score > 0; })
    .sort(function(a, b) { return b.score - a.score; });
}

function buildPlayNextCard(g, scored) {
  var entry  = scored.find(function(s) { return s.game.id === g.id; }) || { genres: [], tags: [] };
  var cUrl   = coverCache[g.id] || coverCache[String(g.id)];
  var pal    = COVER_PALETTES[(g.pal||0) % COVER_PALETTES.length];
  var genres = entry.genres.slice(0, 2).join(' · ');
  var mc     = g.metacriticScore;
  var mcColor = mc >= 80 ? '#4ade80' : mc >= 60 ? '#facc15' : '#f87171';

  // Session suitability label
  var sessionLabel = '';
  if (g.avgPlaytime) {
    var hrs = g.avgPlaytime;
    sessionLabel = hrs <= 5 ? 'Short (under 5h)' : hrs <= 15 ? 'Medium (5–15h)' : 'Long (' + Math.round(hrs) + 'h+)';
  }

  // Rediscovery label
  var ageLabel = '';
  if (g.addedAt) {
    var days = (Date.now() - new Date(g.addedAt).getTime()) / 86400000;
    if (days > 730) ageLabel = '⏳ Owned ' + Math.round(days/365) + ' years';
    else if (days > 180) ageLabel = '⏳ Owned ' + Math.round(days/30) + ' months';
  }

  return '<div style="flex-shrink:0;width:140px;cursor:pointer;border-radius:8px;overflow:hidden;background:var(--surface2);border:1px solid var(--border);transition:transform 0.15s" ' +
    'onclick="openGameDetailById(' + g.id + ')" ' +
    'onmouseenter="this.style.transform=\'translateY(-3px)\'" ' +
    'onmouseleave="this.style.transform=\'\'">' +
    // Cover
    '<div style="width:140px;height:100px;overflow:hidden;background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ');position:relative">' +
      (cUrl ? '<img src="' + cUrl + '" style="width:100%;height:100%;object-fit:cover">' : '') +
      (mc ? '<span style="position:absolute;bottom:4px;right:4px;font-size:9px;font-weight:800;color:' + mcColor + ';background:rgba(0,0,0,0.7);padding:1px 5px;border-radius:3px">' + mc + '</span>' : '') +
    '</div>' +
    // Info
    '<div style="padding:7px 8px">' +
      '<div style="font-size:11px;font-weight:800;line-height:1.25;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + escHtml(g.title) + '">' + escHtml(g.title) + '</div>' +
      (genres ? '<div style="font-size:9px;color:var(--text3);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(genres) + '</div>' : '') +
      (sessionLabel ? '<div style="font-size:9px;color:var(--text2);margin-bottom:2px">' + sessionLabel + '</div>' : '') +
      (ageLabel ? '<div style="font-size:9px;color:#fb923c">' + ageLabel + '</div>' : '') +
    '</div>' +
  '</div>';
}

window.togglePlayNext = function() {
  playNextCollapsed = !playNextCollapsed;
  localStorage.setItem('playNextCollapsed', playNextCollapsed);
  renderPlayNext();
};

window.refreshPlayNext = function() {
  // Clear session exclusions so fresh picks can come from the full pool
  playNextShownIds = new Set();
  renderPlayNext();
};

window.animateAndOpenRandomPicker = function(btn) {
  if (btn) {
    btn.classList.remove('rolling');
    void btn.offsetWidth;
    btn.classList.add('rolling');
  }

  setTimeout(function() {
    openRandomPicker();
    if (btn) btn.classList.remove('rolling');
  }, 650);
};


// ══════════════════════════════════════════════════════
// HELP ME DECIDE — QUIZ-BASED GAME PICKER
// ══════════════════════════════════════════════════════

var pickerQuizAnswers  = { energy: null, time: null, mode: null };
var pickerResults      = [];
var pickerResultIndex  = 0;
var pickerShownIds     = new Set(); // tracks all games shown this session across rerolls
var pickerReplayMode   = false;     // true = pick from played games instead of backlog

// Genre lists use your actual Steam/library genres exactly as stored
// Tag matching uses keyword stems — any tag containing the stem matches
// e.g. 'challeng' matches 'challenging', 'challenge', 'hard challenge', etc.

// ── PICKER MAPS ──
// tagStems: any tag CONTAINING the stem scores positively (+1.5 per match)
// penaltyStems: any tag CONTAINING the stem scores negatively (-2 per match)
// Genre matches score +3 each, capped at 9 total across all answers
// Grounded entirely in actual library tag vocabulary

// ── PICKER MAPS ──
// Energy genres: medium — only genres that clearly signal energy level, no broad overlaps
// Mode genres:   narrow — only the single most diagnostic genre per mode
// Tag scoring:   stems match substrings (+1.5 per match, capped at 15)
// Penalty stems: actively score against an answer (-2 per match, capped at 15)

// ── PICKER MAPS ──
// GENRE SCORING: coarse signal — only the most diagnostic genres per answer
// TAG SCORING:   fine signal — stems match substrings, do the real work
// TAG PENALTIES: conservative — only unambiguous tags, NOT broad words like
//                "action", "combat", "simulation" which appear in innocent games
// GENRE PENALTIES are handled implicitly — wrong genres simply don't score

// ── PICKER MAPS ──
// Decisions grounded in actual library tag vocabulary and gameplay reasoning:
// - Setting tags (sci-fi, fantasy, historical): IGNORED — theme not gameplay
// - Mood tags (dark, surreal, emotional except Story): IGNORED — no dedicated axis yet
// - Multiplayer type tags (co-op, split screen): IGNORED — neutral
// - Stealth: IGNORED — mechanic that spans all categories
// - beat em up: light Intense only — can appear on tactical games (Fights in Tight Spaces)
// - hack and slash, shoot em up: strong Intense + Fast-paced — almost always reflex-based
// - souls-like: strong Intense + Skill, penalty for Chill/Cozy
// - metroidvania: Intense + Skill, neutral on time
// - side scroller: moderate Intense + Fast-paced, positive for short sessions
// - great soundtrack: Chill + Cozy positive — correlates with atmospheric relaxed games
// - procedural generation: Thinky + Strategic
// - replay value: Fast-paced + Intense
// - emotional, female protagonist, lore-rich: Story mode
// - cyberpunk, post-apocalyptic, lovecraftian: Cozy penalty

var PICKER_ENERGY_MAP = {
  chill: {
    genres:   ['Casual'],
    tagStems: [
      'relax','atmospher','cozy','wholesome','casual','peaceful','calm','chill',
      'beautiful','nature','meditat','tranquil','minimalist','walking sim',
      'point & click','hidden object','visual novel','farming sim','life sim',
      'puzzle','colorful','hand-drawn','cute','funny','comedy','family friend',
      'fishing','sailing','music','short','great soundtrack'
    ],
    penaltyStems: [
      'fps','gore','survival horror','bullet hell','souls-like','perma death',
      'unforgiving','battle royale','boomer shooter','pvp','online pvp',
      'arena shooter','fast-paced','violent','hack and slash','shoot em up'
    ]
  },
  intense: {
    genres:   ['Action', 'Sports', 'Racing', 'Massively Multiplayer'],
    tagStems: [
      'fps','shoot','gore','violent','horror','difficult','challeng','fast-paced',
      'arcade','bullet hell','souls-like','roguelike','survival','war','battle',
      'brutal','unforgiving','perma death','military','pvp','boomer shoot',
      'twin stick','parkou','action roguelike','beat em up',
      'hack and slash','shoot em up','side scroller','metroidvania',
      'replay value','spectacle','character action'
    ],
    penaltyStems: [
      'farming sim','life sim','walking sim','hidden object','visual novel',
      'fishing','cooking','gardening','point & click','turn-based','4x',
      'grand strat','colony sim','puzzle'
    ]
  },
  think: {
    genres:   ['Strategy', 'Simulation'],
    tagStems: [
      'strateg','tactical','turn-based','turn based','puzzle','manag','resource',
      'grand strat','4x','city build','base build','economy','deck','card game',
      'logic','investigat','detective','mystery','crpg','dungeon crawler',
      'isometric','rts','wargame','hex grid','autom','diplomacy','colony',
      'immersive sim','real time tactics','real-time with pause',
      'political','choices matter','multiple end','party-based rpg',
      'procedural generation'
    ],
    penaltyStems: [
      'fps','gore','fast-paced','bullet hell','souls-like','perma death',
      'boomer shoot','battle royale','arena shooter'
    ]
  },
  surprise: { genres: [], tagStems: [], penaltyStems: [], skip: true }
};

var PICKER_TIME_MAP = {
  // 30min: pick-up-and-play mechanics score here
  30:  {
    genres:   ['Casual', 'Indie', 'Racing', 'Sports'],
    tagStems: ['hack and slash','shoot em up','side scroller','beat em up','arcade','casual'],
    maxHours: 1
  },
  120: { genres: ['Action', 'Adventure', 'Casual', 'Indie', 'Racing', 'Sports'], maxHours: 3 },
  240: { genres: ['Adventure', 'RPG', 'Simulation', 'Strategy'], maxHours: 6 },
  480: { genres: ['Free to Play', 'Massively Multiplayer', 'RPG', 'Simulation', 'Strategy'], maxHours: 999 }
};

var PICKER_MODE_MAP = {
  story: {
    genres:   ['Adventure'],
    tagStems: [
      'story rich','narrativ','atmospher','choice','visual novel','emotion','cinemat',
      'lore','multiple end','point & click','mystery','detective','noir','narrat',
      'interactive fic','walking sim','episodic','drama','psycholog',
      'female protagonist','lgbtq','choices matter','lore-rich','text-based',
      'great soundtrack'
    ],
    penaltyStems: [
      'fps','pvp','battle royale','arena shooter','boomer shoot','e-sport','fast-paced'
    ]
  },
  skill: {
    genres:   ['Action', 'Sports', 'Racing'],
    tagStems: [
      'difficult','challeng','souls-like','precision','bullet hell','fps',
      'shooter','hack and slash','shoot em up','action roguelike','perma death',
      'unforgiving','reflex','timing','mastery','compet','arcade','platfor',
      'parkou','twitch','boomer shoot','spectacle','character action',
      'metroidvania','rogue-like','rogue-lite','roguelike','martial art',
      'swordplay','precision platfor','replay value'
    ],
    penaltyStems: [
      'farming sim','life sim','walking sim','point & click','hidden object',
      'visual novel','fishing','cooking','turn-based','4x','grand strat'
    ]
  },
  strategic: {
    genres:   ['Strategy', 'Simulation'],
    tagStems: [
      'strateg','tactical','turn-based','turn based','manag','resource','4x',
      'grand strat','city build','base build','economy','rts','deck','card game',
      'wargame','hex grid','autom','diplomacy','colony','isometric','crpg',
      'party-based rpg','real time tactics','real-time with pause',
      'political','dungeon','sandbox','puzzle','procedural generation'
    ],
    penaltyStems: [
      'fps','gore','fast-paced','bullet hell','boomer shoot','battle royale',
      'arena shooter','perma death'
    ]
  },
  cozy: {
    genres:   ['Casual'],
    tagStems: [
      'cozy','relax','wholesome','cute','casual','atmospher','beautiful','peaceful',
      'farming sim','life sim','walking sim','puzzle','colorful','cartoon','funny',
      'comedy','family friend','point & click','hidden object','minimalist',
      'hand-drawn','nature','music','fishing','sailing','cooking','short',
      'episodic','interactive fic','visual novel','garden','animal',
      'party game','local co-op','couch co-op','great soundtrack'
    ],
    penaltyStems: [
      'gore','survival horror','bullet hell','pvp','online pvp','battle royale',
      'perma death','unforgiving','boomer shoot','arena shooter',
      'souls-like','hack and slash','shoot em up',
      'dark fantasy','lovecraft','mature','blood','violent','war','military',
      'post-apocalypt','cyberpunk','dystop','zombies','demons',
      'difficult','challeng','third-person shooter','action rpg','open world'
    ]
  },
  fastpaced: {
    genres:   ['Action', 'Racing', 'Sports'],
    tagStems: [
      'fast-paced','arcade','fps','shoot','action roguelike','bullet','racing',
      'sport','hack and slash','shoot em up','beat em up','side scroller',
      'reflex','twitch','compet','parkou','twin stick','boomer shoot','souls-like',
      'spectacle','character action','platfor','metroidvania','rogue-like',
      'rogue-lite','roguelike','shooter','pvp','team-based','difficult','challeng',
      'replay value'
    ],
    penaltyStems: [
      'farming sim','life sim','walking sim','point & click','hidden object',
      'visual novel','turn-based','4x','grand strat','colony sim','fishing',
      'cooking','puzzle'
    ]
  }
};

function openHelpMeDecide() {
  pickerReplayMode  = false;
  pickerQuizAnswers = { energy: null, time: null, mode: null };
  pickerResults     = [];
  pickerResultIndex = 0;
  pickerShownIds    = new Set();
  var overlay = document.getElementById('helpMeDecideOverlay');
  if (overlay) overlay.classList.add('open');
  renderPickerQuiz();
}

function openReplayPicker() {
  pickerReplayMode  = true;
  pickerQuizAnswers = { energy: null, time: null, mode: null };
  pickerResults     = [];
  pickerResultIndex = 0;
  pickerShownIds    = new Set();
  var overlay = document.getElementById('helpMeDecideOverlay');
  if (overlay) overlay.classList.add('open');
  renderPickerQuiz();
}

function closeHelpMeDecide() {
  var overlay = document.getElementById('helpMeDecideOverlay');
  if (overlay) overlay.classList.remove('open');
}

function renderPickerQuiz() {
  var el = document.getElementById('helpMeDecideBody');
  if (!el) return;

  // Update modal title to reflect mode
  var titleEl = document.querySelector('#helpMeDecideOverlay .modal-title');
  var descEl = document.getElementById('helpMeDecideDesc');
  if (titleEl) titleEl.textContent = pickerReplayMode ? '↩ Play Again' : '✦ Curate';
  if (descEl) descEl.textContent = pickerReplayMode
    ? 'Pick up where you left off. Surfaces games from your play history — ready to revisit.'
    : 'Answer 3 quick questions and Backlog Zero will pull three picks from your backlog that match how you feel right now.';

  // Determine current step
  var step = !pickerQuizAnswers.energy ? 1 : !pickerQuizAnswers.time ? 2 : !pickerQuizAnswers.mode ? 3 : 4;

  if (step === 4) { runPickerAndShowResults(); return; }

  var questions = [
    null,
    {
      label: 'Question 1 of 3',
      title: 'How are you feeling right now?',
      icon: '⚡',
      key: 'energy',
      options: [
        { val: 'chill',    icon: '😌', label: 'Chill',   sub: 'Something low-key' },
        { val: 'intense',  icon: '🔥', label: 'Intense', sub: 'I want action' },
        { val: 'think',    icon: '🧠', label: 'Thinky',  sub: 'Make me use my brain' },
        { val: 'surprise', icon: '🎲', label: 'Surprise me', sub: 'Whatever' }
      ]
    },
    {
      label: 'Question 2 of 3',
      title: 'How much time do you have?',
      icon: '⏱',
      key: 'time',
      options: [
        { val: '30',  icon: '⚡', label: '30 minutes', sub: 'Quick session' },
        { val: '120', icon: '☕', label: '1–2 hours',  sub: 'A good sit' },
        { val: '240', icon: '🎮', label: '3–4 hours',  sub: 'Proper session' },
        { val: '480', icon: '🌙', label: 'All night',  sub: 'I\'m committed' }
      ]
    },
    {
      label: 'Question 3 of 3',
      title: 'What sounds good?',
      icon: '🎯',
      key: 'mode',
      options: [
        { val: 'story',     icon: '📖', label: 'Story-driven', sub: 'Narrative & characters' },
        { val: 'skill',     icon: '⚔️', label: 'Skill-based',  sub: 'Test my reflexes' },
        { val: 'strategic', icon: '♟️', label: 'Strategic',    sub: 'Plans & decisions' },
        { val: 'cozy',      icon: '🏡', label: 'Cozy',         sub: 'No pressure' },
        { val: 'fastpaced', icon: '💨', label: 'Fast-paced',   sub: 'High energy' }
      ]
    }
  ];

  var q = questions[step];

  el.innerHTML =
    '<div style="padding:8px 0 4px">' +
      '<div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--text3);margin-bottom:16px">' + q.label + '</div>' +
      '<div style="font-size:20px;font-weight:900;color:var(--text);margin-bottom:20px;line-height:1.2">' + q.icon + '  ' + q.title + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:9px">' +
        q.options.map(function(opt) {
          return '<button onclick="pickerSelectAnswer(\'' + q.key + '\',\'' + opt.val + '\')" style="' +
            'display:flex;align-items:center;gap:14px;padding:13px 16px;' +
            'background:var(--surface2);border:1px solid var(--border2);border-radius:12px;' +
            'cursor:pointer;transition:all 0.15s;text-align:left;width:100%;' +
            'font-family:inherit;color:var(--text)">' +
            '<span style="font-size:22px;width:28px;text-align:center">' + opt.icon + '</span>' +
            '<span style="flex:1">' +
              '<span style="display:block;font-size:13px;font-weight:700;color:var(--text)">' + opt.label + '</span>' +
              '<span style="display:block;font-size:11px;color:var(--text3);margin-top:1px">' + opt.sub + '</span>' +
            '</span>' +
            '<span style="font-size:16px;color:var(--text3);opacity:0.4">›</span>' +
          '</button>';
        }).join('') +
      '</div>' +
    '</div>';
}

window.pickerSelectAnswer = function(key, val) {
  pickerQuizAnswers[key] = val;
  renderPickerQuiz();
};

function runPickerAndShowResults() {
  var el = document.getElementById('helpMeDecideBody');
  var loadMsg = pickerReplayMode ? 'Finding games to replay…' : 'Finding your games…';
  if (el) el.innerHTML = '<div style="text-align:center;padding:48px 0;color:var(--text3);font-size:13px">' + loadMsg + '</div>';

  setTimeout(function() {
    var energy = PICKER_ENERGY_MAP[pickerQuizAnswers.energy] || PICKER_ENERGY_MAP.surprise;
    var time   = PICKER_TIME_MAP[pickerQuizAnswers.time]     || PICKER_TIME_MAP[120];
    var mode   = PICKER_MODE_MAP[pickerQuizAnswers.mode]     || { genres: [], tagStems: [] };
    var isSurprise = !!energy.skip;

    // Merge genre lists from time + mode (energy handled separately per game)
    var timeGenres    = time.genres          || [];
    var timeStems     = time.tagStems        || [];
    var modeGenres    = mode.genres          || [];
    var modeStems     = mode.tagStems        || [];
    var modePenalty   = mode.penaltyStems    || [];
    var energyGenres  = energy.genres        || [];
    var energyStems   = energy.tagStems      || [];
    var energyPenalty = energy.penaltyStems  || [];

    // Helper: does any stem appear as a substring of the tag?
    function stemMatch(tag, stems) {
      var t = tag.toLowerCase();
      return stems.some(function(s) { return t.indexOf(s.toLowerCase()) !== -1; });
    }

    // Candidates — unplayed for normal mode, played for replay mode
    var candidates = pickerReplayMode
      ? games.filter(function(g) { return (g.playtimeHours||0) > 0 && !g.hidden; })
      : games.filter(function(g) { return (g.playtimeHours||0) === 0 && !g.hidden && !g.gpCatalog; });

    if (!candidates.length) {
      el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">' + (pickerReplayMode ? 'No played games found!' : 'No unplayed games found!') + '</div>';
      return;
    }

    // Score every candidate
    var scored = candidates.map(function(g) {
      var quizScore = 0;
      var hasMetadata = (g.genres && g.genres.length) || (g.tags && g.tags.length) || (g.steamTags && g.steamTags.length);
      var gGenres = g.genres && g.genres.length ? g.genres : (g.genre ? [g.genre] : []);
      var allTags = [...new Set([...(g.tags||[]),...(g.steamTags||[])].map(function(t){return t.toLowerCase();}))];

      if (!isSurprise) {
        // --- GENRE SCORING ---
        // Each answer contributes independently; a genre can match multiple answers
        // Cap total genre bonus at 9 so tag-rich games can compete
        var genreBonus = 0;
        gGenres.forEach(function(gn) {
          if (energyGenres.some(function(eg){return eg.toLowerCase()===gn.toLowerCase();})) genreBonus += 3;
          if (timeGenres.some(function(tg){return tg.toLowerCase()===gn.toLowerCase();}))   genreBonus += 3;
          if (modeGenres.some(function(mg){return mg.toLowerCase()===gn.toLowerCase();}))   genreBonus += 3;
        });
        quizScore += Math.min(genreBonus, 9);

        // --- TAG SCORING via stem matching ---
        // Energy stems + mode stems score positively; penalty stems score negatively
        var tagBonus = 0;
        var tagPenalty = 0;
        allTags.forEach(function(t) {
          var posMatch = stemMatch(t, energyStems) || stemMatch(t, modeStems) || stemMatch(t, timeStems);
          if (posMatch) tagBonus += 1.5;
          if (stemMatch(t, energyPenalty)) tagPenalty += 2;
          if (stemMatch(t, modePenalty))   tagPenalty += 2;
        });
        // Cap bonus at 15 (raised from 9 so perfect matches score significantly higher)
        quizScore += Math.min(tagBonus, 15);
        quizScore -= Math.min(tagPenalty, 15);
      }

      // Time filter — soft penalty if game is way over time budget
      var maxH = time.maxHours;
      var est = g.avgPlaytime || 0;
      if (maxH < 999 && est > 0 && est > maxH * 2) quizScore -= 4;

      // "Not for me" decaying penalty — -8 on day 1, halves every 7 days, gone after ~4 weeks
      if (g.notForMeAt) {
        var daysSince = (Date.now() - new Date(g.notForMeAt).getTime()) / (1000 * 60 * 60 * 24);
        var demotePenalty = 8 * Math.pow(0.5, daysSince / 7);
        if (demotePenalty > 0.25) quizScore -= demotePenalty;
      }

      // Quality signals
      if (g.metacriticScore >= 90) quizScore += 2;
      else if (g.metacriticScore >= 80) quizScore += 1;
      if (g.userRating > 0) quizScore += g.userRating * 0.3;

      // No metadata — deprioritize but don't exclude
      if (!hasMetadata) quizScore = Math.min(quizScore, 1);

      // Surprise: score based purely on quality signals — truly random across library
      var finalScore = isSurprise
        ? (1 + (g.metacriticScore >= 90 ? 2 : g.metacriticScore >= 80 ? 1 : 0) + (g.userRating||0) * 0.3)
        : quizScore;

      return { game: g, score: finalScore, genres: gGenres, tags: allTags, hasMetadata: hasMetadata };
    });

    // For surprise mode use a low threshold so the whole library is eligible
    var MIN_SCORE = isSurprise ? 0.5 : 3.0;
    var qualifying = scored.filter(function(s) { return s.score >= MIN_SCORE; });
    // Fall back to top 15 if sparse metadata means few games qualify
    if (qualifying.length < 6) qualifying = scored.slice(0, Math.min(15, scored.length));

    // Exclude games already shown this session — rerolls always give fresh results
    var fresh = qualifying.filter(function(s) { return !pickerShownIds.has(s.game.id); });
    // If we've exhausted the pool, reset exclusions and start over
    if (fresh.length < 3) { pickerShownIds = new Set(); fresh = qualifying; }

    // Score jitter — ±20% random multiplier so top games don't always win
    // Applied after filtering so bad games can't jitter their way into qualifying
    fresh = fresh.map(function(s) {
      var jitter = 0.8 + Math.random() * 0.4; // 0.8 to 1.2
      return Object.assign({}, s, { score: s.score * jitter });
    }).sort(function(a, b) { return b.score - a.score; });

    function weightedPick(pool) {
      if (!pool.length) return null;
      var total = pool.reduce(function(s,e) { return s + Math.max(0.1, e.score); }, 0);
      var r = Math.random() * total;
      for (var pi = 0; pi < pool.length; pi++) {
        r -= Math.max(0.1, pool[pi].score);
        if (r <= 0) return pool[pi];
      }
      return pool[0];
    }

    // Score bands — wider pools for more variety
    var topScore   = fresh.length ? fresh[0].score : 1;
    var bandStrong = fresh.filter(function(s) { return s.score >= topScore * 0.75; });
    var bandGood   = fresh.filter(function(s) { return s.score >= topScore * 0.4 && s.score < topScore * 0.75; });
    var bandWild   = fresh.filter(function(s) { return s.score < topScore * 0.4; });
    // Ensure bands have enough candidates; fall back up if thin
    if (bandGood.length < 4)  bandGood  = fresh.slice(Math.min(5, fresh.length));
    if (bandWild.length < 4)  bandWild  = fresh.slice(Math.min(10, fresh.length));

    var picks    = [];
    var usedIds  = new Set();
    var usedGenres = new Set();

    // Card 1: strong match band (top scorers)
    var pool1 = bandStrong.filter(function(s) { return !usedIds.has(s.game.id); }).slice(0, 12);
    var card1 = weightedPick(pool1) || weightedPick(fresh.slice(0, 10));
    if (card1) { picks.push(card1); usedIds.add(card1.game.id); usedGenres.add((card1.genres[0]||'none').toLowerCase()); }

    // Card 2: good match band — prefer different genre but fall back to same genre if needed
    var pool2 = bandGood.filter(function(s) {
      return !usedIds.has(s.game.id) && !usedGenres.has((s.genres[0]||'none').toLowerCase());
    }).slice(0, 12);
    // If no different-genre options exist, just pick the next best regardless of genre
    if (!pool2.length) pool2 = fresh.filter(function(s) { return !usedIds.has(s.game.id); }).slice(0, 12);
    var card2 = weightedPick(pool2);
    if (card2) { picks.push(card2); usedIds.add(card2.game.id); usedGenres.add((card2.genres[0]||'none').toLowerCase()); }

    // Card 3: wildcard band — prefer different genre but fall back freely
    var pool3 = bandWild.filter(function(s) {
      return !usedIds.has(s.game.id) && !usedGenres.has((s.genres[0]||'none').toLowerCase());
    }).slice(0, 20);
    if (!pool3.length) pool3 = fresh.filter(function(s) { return !usedIds.has(s.game.id); }).slice(0, 20);
    var card3 = weightedPick(pool3);
    if (card3) picks.push(card3);

    // Record all shown games so rerolls skip them
    picks.forEach(function(p) { if (p) pickerShownIds.add(p.game.id); });

    pickerResults = picks;
    pickerResultIndex = 0;
    renderPickerResult();
  }, 400);
}

function renderPickerResult() {
  var el = document.getElementById('helpMeDecideBody');
  if (!el || !pickerResults.length) return;

  // Update title to reflect mode
  var titleEl = document.querySelector('#helpMeDecideOverlay .modal-title');
  var descEl = document.getElementById('helpMeDecideDesc');
  if (titleEl) titleEl.textContent = pickerReplayMode ? '↩ Play Again' : '✦ Curate';
  if (descEl) descEl.textContent = pickerReplayMode
    ? 'Pick up where you left off. Surfaces games from your play history — ready to revisit.'
    : 'Answer 3 quick questions and Backlog Zero will pull three picks from your backlog that match how you feel right now.';

  var entry  = pickerResults[pickerResultIndex];
  var g      = entry.game;
  var cUrl   = coverCache[g.id] || coverCache[String(g.id)];
  var pal    = COVER_PALETTES[(g.pal||0) % COVER_PALETTES.length];
  var total  = pickerResults.length;
  var idx    = pickerResultIndex;

  // Build "why this" reason string
  var energy = pickerQuizAnswers.energy;
  var mode   = pickerQuizAnswers.mode;
  var reasons = [];
  if (energy && energy !== 'surprise') reasons.push({ chill:'Chill',intense:'Intense',think:'Thinky' }[energy] || energy);
  if (mode) reasons.push({ story:'Story-driven',skill:'Skill-based',strategic:'Strategic',cozy:'Cozy',fastpaced:'Fast-paced' }[mode] || mode);
  var reasonStr = reasons.join(' · ');
  if (!entry.hasMetadata) reasonStr += (reasonStr ? ' · ' : '') + '⚠ Limited metadata';

  var displayGenres = entry.genres.slice(0, 3);
  var displayTags   = entry.tags.slice(0, 6);

  // Matched tags (highlighted)
  var energy2  = PICKER_ENERGY_MAP[pickerQuizAnswers.energy] || { tagStems: [] };
  var mode2    = PICKER_MODE_MAP[pickerQuizAnswers.mode]     || { tagStems: [] };
  var allStems = [...(energy2.tagStems||[]), ...(mode2.tagStems||[])].map(function(s){return s.toLowerCase();});
  function tagIsMatch(tag) {
    var t = tag.toLowerCase();
    return allStems.some(function(s){ return t.indexOf(s) !== -1; });
  }

  var metaColor = g.metacriticScore >= 80 ? '#4ade80' : g.metacriticScore >= 60 ? '#facc15' : '#f87171';

  el.innerHTML =
    // Card counter dots
    '<div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:20px">' +
      [0,1,2].map(function(i) {
        return '<div style="width:' + (i===idx?'20':'7') + 'px;height:7px;border-radius:4px;background:' + (i===idx?'var(--steam)':'var(--surface3)') + ';transition:all 0.3s"></div>';
      }).join('') +
    '</div>' +

    // Cover + core info
    '<div style="display:flex;gap:18px;align-items:flex-start;margin-bottom:18px">' +
      '<div style="width:110px;height:147px;border-radius:10px;overflow:hidden;flex-shrink:0;' +
           'background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ');' +
           'box-shadow:0 12px 32px rgba(0,0,0,0.5)">' +
        (cUrl ? '<img src="' + cUrl + '" style="width:100%;height:100%;object-fit:cover">' : '') +
      '</div>' +
      '<div style="flex:1;min-width:0;padding-top:2px">' +
        '<div style="font-size:18px;font-weight:900;line-height:1.15;margin-bottom:6px;color:var(--text)">' + escHtml(g.title) + '</div>' +
        '<div style="font-size:11px;color:var(--text3);margin-bottom:10px">' + escHtml(displayGenres.join(' · ')) + '</div>' +
        // Tags row
        (displayTags.length ?
          '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">' +
            displayTags.map(function(t) {
              var isMatch = tagIsMatch(t);
              return '<span style="font-size:9px;padding:2px 7px;border-radius:4px;font-weight:' + (isMatch?'700':'500') + ';' +
                'background:' + (isMatch?'rgba(91,163,245,0.15)':'var(--surface3)') + ';' +
                'border:1px solid ' + (isMatch?'rgba(91,163,245,0.35)':'var(--border)') + ';' +
                'color:' + (isMatch?'var(--steam)':'var(--text3)') + '">' + escHtml(t) + '</span>';
            }).join('') +
          '</div>'
        : '') +
        // Metacritic + platform
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
          (g.metacriticScore ? '<span style="font-size:11px;font-weight:800;color:' + metaColor + ';background:rgba(0,0,0,0.25);padding:2px 8px;border-radius:5px">' + g.metacriticScore + ' MC</span>' : '') +
          (g.platforms||[]).slice(0,3).map(function(p) {
            return '<span style="font-size:9px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);background:var(--surface3);padding:2px 6px;border-radius:4px">' + escHtml(p) + '</span>';
          }).join('') +
        '</div>' +
      '</div>' +
    '</div>' +

    // Why this
    '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:9px 12px;margin-bottom:16px;font-size:11px;color:var(--text3)">' +
      '✦ ' + escHtml(reasonStr || 'Matched your vibe') +
    '</div>' +

    // Description
    (g.description ?
      '<div style="font-size:11px;color:var(--text2);line-height:1.65;margin-bottom:16px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">' +
        escHtml(g.description) +
      '</div>'
    : '') +

    // Action buttons
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">' +
      '<button class="settings-btn" style="flex:1;font-size:12px;padding:9px 16px;background:var(--steam);color:#000;border-color:var(--steam);font-weight:800;justify-content:center" ' +
        'onclick="closeHelpMeDecide();openGameDetailById(' + g.id + ')">&#9658; Play This</button>' +
      (idx < total-1 ?
        '<button class="settings-btn" style="font-size:12px;padding:9px 16px" onclick="pickerNextResult()">Next &#8594;</button>'
      : '') +
    '</div>' +

    // Not for me + Show me different row
    '<div style="display:flex;gap:8px;margin-bottom:10px">' +
      '<button class="settings-btn" style="flex:1;font-size:11px;padding:7px 12px;justify-content:center;color:var(--text3);border-color:var(--border)" ' +
        'onclick="event.stopPropagation();pickerNotForMe(' + g.id + ')">&#10005; Not for me</button>' +
      '<button class="settings-btn" style="flex:2;font-size:11px;padding:7px 12px;justify-content:center;color:var(--text3);border-color:var(--border)" ' +
        'onclick="rerollHelpMeDecide()">&#10022; Show me different games</button>' +
    '</div>' +

    // Change answers button
    '<div style="text-align:center;margin-bottom:12px">' +
      '<button class="settings-btn" style="font-size:11px;padding:5px 16px;color:var(--text2);background:var(--surface2);border-color:var(--border)" ' +
        'onclick="pickerReplayMode ? openReplayPicker() : openHelpMeDecide()">&#8634; Change answers</button>' +
    '</div>' +

    // Prev/next nav
    '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<button class="settings-btn" style="font-size:11px;padding:4px 10px;opacity:' + (idx>0?'1':'0.3') + '" ' +
        (idx>0 ? 'onclick="pickerPrevResult()"' : 'disabled') + '>&#8592; Prev</button>' +
      '<span style="font-size:10px;color:var(--text3)">' + (idx+1) + ' of ' + total + '</span>' +
      '<button class="settings-btn" style="font-size:11px;padding:4px 10px;opacity:' + (idx<total-1?'1':'0.3') + '" ' +
        (idx<total-1 ? 'onclick="pickerNextResult()"' : 'disabled') + '>Next &#8594;</button>' +
    '</div>';
}

window.pickerNextResult = function() {
  if (pickerResultIndex < pickerResults.length - 1) { pickerResultIndex++; renderPickerResult(); }
};
window.pickerPrevResult = function() {
  if (pickerResultIndex > 0) { pickerResultIndex--; renderPickerResult(); }
};


window.rerollHelpMeDecide = function() {
  runPickerAndShowResults();
};

window.pickerNotForMe = async function(gameId) {
  var g = games.find(function(g) { return g.id === gameId; });
  if (!g) return;
  g.notForMeAt = new Date().toISOString();
  await window.nexus.games.update(gameId, { notForMeAt: g.notForMeAt });
  // Just move to the next card, or reroll if this was the last one
  if (pickerResultIndex < pickerResults.length - 1) {
    pickerResultIndex++;
    renderPickerResult();
  } else {
    rerollHelpMeDecide();
  }
};


// ════════════════════════════════════════════════════════
// PAGE HINTS — first-visit popups, one per page
// ════════════════════════════════════════════════════════
var PAGE_HINTS = {
  library: {
    icon: '📚',
    title: 'Library',
    body: 'Your entire game collection across every connected platform in one place.\nStart by filtering by Status — set games to Playing, Backlog, or Completed to bring order to your collection. Click any game to see full details, update your status, and leave a personal rating.'
  },
  discovery: {
    icon: '🧭',
    title: 'Discover',
    body: 'Surface games you already own but have never given a real chance.\nRun Hidden Gems to find your most overlooked titles, or use Find Similar to get recommendations based on a game you love. Everything here is already in your library — no purchases needed.'
  },
  habits: {
    icon: '📊',
    title: 'Gaming Habits',
    body: 'A record of how, when, and what you actually play.\nLog a session after you play to build your history. Over time, Habits shows your peak play days, your most consistent games, and whether your playtime patterns are changing.'
  },
  goals: {
    icon: '🎯',
    title: 'Playtime Goals',
    body: 'Set milestones for games you want to put serious time into.\nPick a game, set a target hour count, and track your progress as you play. Games that hit 75% or more appear in the Almost There section. Completed goals go to your Hall of Fame.'
  },
  stats: {
    icon: '📈',
    title: 'Library Stats',
    body: 'A full breakdown of your collection by platform, genre, status, and backlog health.\nMost charts and bars are clickable — tap any segment to jump straight to the matching games in your library.'
  },
  wishlist: {
    icon: '♡',
    title: 'Wishlist',
    body: 'Track games you want and monitor their prices across 40+ stores.\nAdd a game, set a target price or discount threshold, and Backlog Zero will flag it when it hits your number. The historical low is shown for every game so you know when a deal is actually good.'
  },
  friends: {
    icon: '👥',
    title: 'Friends',
    body: 'Compare your Steam library with any friend\'s.\nEnter their Steam ID to see what they own that you don\'t — sorted by their playtime so the most-played recommendations surface first. You can wishlist anything interesting directly from the comparison. Games you both own are shown in the In Common tab.'
  },
  freegames: {
    icon: '🎁',
    title: 'Free Games',
    body: 'Never miss a free game claim.\nThe Epic tab shows what\'s free right now and what\'s coming up next. Check the PC Giveaways tab for active giveaways across other platforms. Mark anything you\'ve claimed so you always know what\'s in your collection.'
  },
  identity: {
    icon: '🗂',
    title: 'Identity Dossier',
    body: 'A classified record of your gaming behavior, updated each quarter.\nYour archetype is calculated from your actual play patterns — not self-reported. The Reality Check card shows how your backlog and activity compare. Open your full dossier to see the complete breakdown.'
  }
};

async function maybeShowPageHint(page) {
  if (!PAGE_HINTS || !PAGE_HINTS[page]) return;
  var seen = await window.nexus.store.get('hint.seen.' + page);
  if (seen) return;
  showPageHint(page);
}

function showWelcomeHint() {
  var existing = document.getElementById('pageHintPopup');
  if (existing) existing.remove();

  var popup = document.createElement('div');
  popup.id = 'pageHintPopup';

  var hdrRow = document.createElement('div');
  hdrRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px';
  var hdrLabel = document.createElement('span');
  hdrLabel.style.cssText = 'font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:var(--accent)';
  hdrLabel.textContent = 'Page Overview';
  var closeBtn = document.createElement('button');
  closeBtn.style.cssText = 'background:none;border:none;color:var(--text3);cursor:pointer;font-size:14px;line-height:1;padding:4px;margin:-4px;opacity:0.7;display:flex;align-items:center;justify-content:center;width:24px;height:24px;flex-shrink:0;box-sizing:border-box';
  closeBtn.innerHTML = '&#x2715;';
  closeBtn.addEventListener('click', function() { document.getElementById('pageHintPopup').remove(); });
  closeBtn.addEventListener('mouseenter', function() { closeBtn.style.opacity = '1'; });
  closeBtn.addEventListener('mouseleave', function() { closeBtn.style.opacity = '0.7'; });
  hdrRow.appendChild(hdrLabel);
  hdrRow.appendChild(closeBtn);

  var titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;align-items:center;gap:9px;margin-bottom:10px';
  titleRow.innerHTML = '<span style="font-size:20px;line-height:1">&#x1F3AE;</span>' +
    '<span style="font-family:Syne,sans-serif;font-size:14px;font-weight:800;color:var(--text)">Welcome to Backlog Zero</span>';
  var sub1 = document.createElement('div');
  sub1.style.cssText = 'font-size:12px;font-weight:600;color:var(--text2);margin-bottom:7px;line-height:1.5';
  sub1.textContent = 'Backlog Zero brings your entire game collection together in one place.';
  var sub2 = document.createElement('div');
  sub2.style.cssText = 'font-size:11px;color:var(--text3);line-height:1.6';
  sub2.textContent = 'Track your backlog, discover hidden gems, and decide what to play next.';

  popup.appendChild(hdrRow);
  popup.appendChild(titleRow);
  popup.appendChild(sub1);
  popup.appendChild(sub2);

  popup.style.cssText = [
    'position:fixed',
    'z-index:200',
    'background:var(--surface)',
    'border:1px solid var(--border)',
    'border-radius:12px',
    'padding:16px 18px',
    'width:320px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.35)',
    'animation:hintFadeIn 0.18s ease',
    'pointer-events:all'
  ].join(';');

  document.body.appendChild(popup);
  popup.style.top   = '60px';
  popup.style.right = '24px';
}

function showPageHint(page) {
  var hint = PAGE_HINTS[page];
  if (!hint) return;

  var existing = document.getElementById('pageHintPopup');
  if (existing) existing.remove();

  // Find anchor — the topbar or stats-header of the active page
  var pageEl   = document.getElementById('page-' + page);
  var headerEl = pageEl ? (pageEl.querySelector('.topbar') || pageEl.querySelector('.stats-header')) : null;

  var lines    = hint.body.split('\n');
  var summary  = lines[0];
  var detail   = lines[1] || '';

  var popup = document.createElement('div');
  popup.id  = 'pageHintPopup';

  // Header row
  var hdrRow = document.createElement('div');
  hdrRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px';
  var hdrLabel = document.createElement('span');
  hdrLabel.style.cssText = 'font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:var(--accent)';
  hdrLabel.textContent = 'Page Overview';
  var closeBtn = document.createElement('button');
  closeBtn.style.cssText = 'background:none;border:none;color:var(--text3);cursor:pointer;font-size:14px;line-height:1;padding:4px;margin:-4px;opacity:0.7;display:flex;align-items:center;justify-content:center;width:24px;height:24px;flex-shrink:0;box-sizing:border-box';
  closeBtn.innerHTML = '&#x2715;';
  closeBtn.addEventListener('click', function() { dismissPageHint(page); });
  closeBtn.addEventListener('mouseenter', function() { closeBtn.style.opacity = '1'; });
  closeBtn.addEventListener('mouseleave', function() { closeBtn.style.opacity = '0.7'; });
  hdrRow.appendChild(hdrLabel);
  hdrRow.appendChild(closeBtn);

  // Body
  var titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;align-items:center;gap:9px;margin-bottom:10px';
  titleRow.innerHTML = '<span style="font-size:20px;line-height:1">' + hint.icon + '</span>' +
    '<span style="font-family:Syne,sans-serif;font-size:14px;font-weight:800;color:var(--text)">' + hint.title + '</span>';
  var summaryEl = document.createElement('div');
  summaryEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--text2);margin-bottom:7px;line-height:1.5';
  summaryEl.textContent = summary;
  popup.appendChild(hdrRow);
  popup.appendChild(titleRow);
  popup.appendChild(summaryEl);
  if (detail) {
    var detailEl = document.createElement('div');
    detailEl.style.cssText = 'font-size:11px;color:var(--text3);line-height:1.6';
    detailEl.textContent = detail;
    popup.appendChild(detailEl);
  }

  popup.style.cssText = [
    'position:fixed',
    'z-index:200',
    'background:var(--surface)',
    'border:1px solid var(--border)',
    'border-radius:12px',
    'padding:16px 18px',
    'width:320px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.35)',
    'animation:hintFadeIn 0.18s ease',
    'pointer-events:all',
    'max-height:calc(100vh - 80px)',
    'overflow-y:auto'
  ].join(';');

  document.body.appendChild(popup);
  popup.style.top   = '60px';
  popup.style.right = '24px';
}

window.dismissPageHint = async function(page) {
  var popup = document.getElementById('pageHintPopup');
  if (popup) {
    popup.style.transition = 'opacity 0.18s, transform 0.18s';
    popup.style.opacity = '0';
    popup.style.transform = 'translateY(6px)';
    setTimeout(function() { if (popup.parentNode) popup.remove(); }, 200);
  }
  await window.nexus.store.set('hint.seen.' + page, true);
  // Show (?) button on topbar after dismissal
  renderHintReopener(page);
};

function renderHintReopener(page) {
  var pageEl   = document.getElementById('page-' + page);
  var headerEl = pageEl ? (pageEl.querySelector('.topbar') || pageEl.querySelector('.stats-header')) : null;
  if (!headerEl || headerEl.querySelector('.hint-reopener')) return;

  var btn = document.createElement('button');
  btn.className = 'hint-reopener';
  btn.textContent = '?';
  btn.onclick = function() { showPageHint(page); };
  btn.style.cssText = [
    'background:none',
    'border:1px solid var(--border)',
    'color:var(--text3)',
    'font-size:10px',
    'font-weight:700',
    'width:18px',
    'height:18px',
    'border-radius:50%',
    'cursor:pointer',
    'line-height:1',
    'padding:0',
    'margin-left:6px',
    'vertical-align:middle',
    'flex-shrink:0',
    'transition:color 0.15s,border-color 0.15s'
  ].join(';');
  btn.onmouseenter = function() { btn.style.color = 'var(--accent)'; btn.style.borderColor = 'var(--accent)'; };
  btn.onmouseleave = function() { btn.style.color = 'var(--text3)'; btn.style.borderColor = 'var(--border)'; };

  // Append into the title row
  var titleEl = headerEl.querySelector('.topbar-title,.stats-title');
  if (titleEl) {
    titleEl.style.display = 'inline-flex';
    titleEl.style.alignItems = 'center';
    titleEl.appendChild(btn);
  } else {
    headerEl.appendChild(btn);
  }
}

window.resetPageHints = async function() {
  // Remove any existing (?) buttons
  document.querySelectorAll('.hint-reopener').forEach(function(b) { b.remove(); });
  for (var page of Object.keys(PAGE_HINTS)) {
    await window.nexus.store.set('hint.seen.' + page, false);
  }
  var btn = document.querySelector('[onclick="resetPageHints()"]');
  if (btn) {
    var orig = btn.textContent;
    btn.textContent = '✓ Done — visit each page to see hints';
    btn.disabled = true;
    setTimeout(function() { btn.textContent = orig; btn.disabled = false; }, 3000);
  }
};