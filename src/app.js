// app.js — Renderer process
// Communicates with main.js via window.nexus (defined in preload.js)

const PLAT_COLOR  = { steam: '#4a9eed', gog: '#e8573e', epic: '#c8a84b', amazon: '#ff9900', xbox: '#107c10', gamepass: '#52b043' };
const STATUS_COLOR = { exploring: '#60a5fa', finished: '#4ade80', 'not-for-me': '#f87171' };
const STATUS_MIGRATE = { playing: 'exploring', completed: 'finished', abandoned: 'not-for-me', backlog: null, unplayed: null };

// Intent system
const INTENT_LABEL = { priority: '🔴 Priority', queue: '📋 Queue', playnext: '▶ Play Next' };
const INTENT_COLOR = { priority: '#f87171', queue: '#60a5fa', playnext: '#4ade80' };
const INTENT_ELIGIBLE = function(g) { return g.status !== 'finished' && g.status !== 'not-for-me'; };

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

// ── INIT ──
// ── THEME ──
function initTheme() {
  var saved = localStorage.getItem('nexusTheme') || 'dark';
  applyTheme(saved);
}

function applyTheme(theme) {
  var isLight = theme === 'light';
  document.body.classList.toggle('light-mode', isLight);
  localStorage.setItem('nexusTheme', theme);
  // Swap icons
  var moonIcon = document.querySelector('.icon-moon');
  var sunIcon  = document.querySelector('.icon-sun');
  if (moonIcon) moonIcon.style.display = isLight ? 'none' : '';
  if (sunIcon)  sunIcon.style.display  = isLight ? '' : 'none';
}

function toggleTheme() {
  var current = document.body.classList.contains('light-mode') ? 'light' : 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

async function init() {
  initTheme();
  games = await window.nexus.games.getAll();
  wishlist = await window.nexus.wishlist.getAll();
  await migrateStatusValues(); // one-time migration: old status values → new
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
  }
  wire('rawgSaveBtn',    'click', saveRawgKey);
  wire('igdbSaveBtn',    'click', saveIGDBAndFetch);
  wire('igdbRefreshBtn', 'click', function() { bulkFetchMissingArt(false); });
  wire('igdbRefetchAllBtn', 'click', function() { bulkFetchMissingArt(true); });
  wire('fillMetadataBtn',      'click', fillMissingMetadata);
  wire('fillMetadataSteamBtn', 'click', fillMissingMetadataSteam);
  wire('fillMetadataRawgBtn',  'click', fillMissingMetadataRawg);
  wire('helpMeDecideBtn', 'click', openHelpMeDecide);
  wire('replayPickerBtn',  'click', openReplayPicker);
  wire('fullResetBtn',   'click', openFullResetDialog);
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

// ── NAVIGATION ──
function showPage(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-page]').forEach(i => i.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  const navEl = document.querySelector('.nav-item[data-page="' + page + '"]');
  if (navEl) navEl.classList.add('active');
  var pnSection = document.getElementById('playNextSection');
  if (pnSection) pnSection.style.display = (page === 'library') ? '' : 'none';
  if (page === 'stats')     renderStats();
  if (page === 'dupes') renderDupesPage();
  if (page === 'wishlist') { renderWishlist(); fetchWishlistCoversInBackground(); renderNotifHistory(); updateDealBadge(); }
  if (page === 'settings') { renderPlatformSyncHealth(); initAutoSessionTracking(); }
  if (page === 'goals')   { populateGoalGameSelect(); loadGoals(); }
  if (page === 'habits')  { renderHabitsPage(); }
  if (page === 'wrapped') { renderWrappedPage(); }
  if (page === 'freegames') { renderFreeGamesPage(); }
  if (page === 'friends') { document.getElementById('friendError').textContent = ''; }
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
  noart:            ['Missing Cover Art',  'Games without cover images'],
  hidden:           ['Hidden Games',       'Games hidden from your library — click 👁 to unhide'],
  recent:           ['Recently Added',     'Games added in the last 30 days'],
  'status:exploring':   ['Exploring',           'Games you are actively playing'],
  'status:finished':    ['Finished',            'Games you have finished'],
  'status:not-for-me': ['Not for Me',          'Games you have stopped playing'],
  'intent:playnext':   ['Intent: Play Next',   'Games flagged to play next'],
  'intent:priority':   ['Intent: Priority',    'Games marked as high priority'],
  'intent:queue':      ['Intent: Queue',       'Games added to your queue'],
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
  document.getElementById('topTitle').textContent = names.join(' + ') + ' Libraries';
  document.getElementById('topSub').textContent = platforms.length > 1 ? 'Showing games from ' + names.join(', ') : (FILTER_TITLES[platforms[0]] || ['',''])[1];
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

async function loadFriendLibrary() {
  var friendId = document.getElementById('friendSteamId').value.trim();
  if (!friendId) return;
  var btn = document.getElementById('friendLoadBtn');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    var result = await window.nexus.steam.importFriend(friendId);
    friendGames = result.games;
    friendName  = result.personaName || ('Friend ' + friendId.slice(-4));
    renderFriendComparison();
    document.getElementById('friendResults').style.display = 'block';
  } catch(e) {
    document.getElementById('friendError').textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Compare';
  }
}

function renderFriendComparison() {
  var myTitles     = new Set(games.map(function(g) { return normalizeTitle(g.title); }));
  var friendTitles = new Set(friendGames.map(function(g) { return normalizeTitle(g.name || ''); }));

  var inCommon = friendGames.filter(function(g) { return myTitles.has(normalizeTitle(g.name || '')); });
  var theyHave = friendGames.filter(function(g) { return !myTitles.has(normalizeTitle(g.name || '')); })
    .sort(function(a,b) { return (b.playtime_forever||0) - (a.playtime_forever||0); });
  var iHave    = games.filter(function(g) { return !friendTitles.has(normalizeTitle(g.title)); });

  var el = document.getElementById('friendResults');

  // Summary stats row
  var summaryHtml =
    '<div class="friend-summary">' +
      '<div class="friend-stat-card">' +
        '<div class="friend-stat-num" style="color:var(--steam)">' + inCommon.length + '</div>' +
        '<div class="friend-stat-label">In Common</div>' +
      '</div>' +
      '<div class="friend-stat-card">' +
        '<div class="friend-stat-num" style="color:#f472b6">' + theyHave.length + '</div>' +
        '<div class="friend-stat-label">' + escHtml(friendName) + ' has, you don\'t</div>' +
      '</div>' +
      '<div class="friend-stat-card">' +
        '<div class="friend-stat-num" style="color:#4ade80">' + iHave.length + '</div>' +
        '<div class="friend-stat-label">You have, they don\'t</div>' +
      '</div>' +
    '</div>';

  el.innerHTML = summaryHtml +
    '<div class="friend-section-header">' +
      '<div class="friend-section-title">🎮 ' + escHtml(friendName) + ' has — you don\'t</div>' +
      '<div class="friend-section-sub">Sorted by their playtime · ' + theyHave.length + ' games</div>' +
    '</div>' +
    '<div class="friend-game-grid" id="friendTheyHaveList"></div>';

  var listEl = document.getElementById('friendTheyHaveList');

  theyHave.slice(0, 100).forEach(function(fg) {
    var title = fg.name || '';
    var hrs   = fg.playtime_forever ? Math.round(fg.playtime_forever / 60) : 0;
    var inWish = wishlist.find(function(w) { return normalizeTitle(w.title) === normalizeTitle(title); });
    var myGame = games.find(function(g) { return normalizeTitle(g.title) === normalizeTitle(title); });
    // Try to get a Steam cover via appid
    var coverUrl = fg.appid ? 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + fg.appid + '/library_600x900.jpg' : null;
    var pal = COVER_PALETTES[Math.abs(title.charCodeAt(0) || 0) % COVER_PALETTES.length];

    var row = document.createElement('div');
    row.className = 'friend-game-card';
    row.innerHTML =
      '<div class="friend-game-cover">' +
        (coverUrl ? '<img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display=\'none\'">' : '') +
        '<div class="friend-game-cover-bg" style="background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')"></div>' +
      '</div>' +
      '<div class="friend-game-body">' +
        '<div class="friend-game-title">' + escHtml(title) + '</div>' +
        (hrs > 0 ? '<div class="friend-game-hrs">' + hrs + 'h played by ' + escHtml(friendName) + '</div>' : '<div class="friend-game-hrs">No playtime data</div>') +
        '<div class="friend-game-actions">' +
          (myGame
            ? '<span class="friend-in-library">✓ In your library</span>'
            : '<button class="friend-wish-btn' + (inWish ? ' wishlisted' : '') + '">' + (inWish ? '♥ Wishlisted' : '♡ Add to Wishlist') + '</button>') +
        '</div>' +
      '</div>';

    var wishBtn = row.querySelector('.friend-wish-btn');
    if (wishBtn && !inWish) {
      wishBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var input = document.getElementById('wishGameTitle');
        input.value = title;
        input.dispatchEvent(new Event('input'));
        document.getElementById('wishOverlay').classList.add('open');
        wishBtn.textContent = '♥ Wishlisted';
        wishBtn.classList.add('wishlisted');
        wishBtn.disabled = true;
      });
    }

    listEl.appendChild(row);
  });

  if (!theyHave.length) {
    listEl.innerHTML = '<div class="friend-empty">You already own everything ' + escHtml(friendName) + ' has!</div>';
  } else if (theyHave.length > 100) {
    var more = document.createElement('div');
    more.className = 'friend-more';
    more.textContent = '+ ' + (theyHave.length - 100) + ' more games not shown';
    listEl.appendChild(more);
  }
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
                '<div style="font-size:10px;color:var(--text3);margin-top:1px">Reach ' + s.milestone + 'h · currently ' + (s.game.playtimeHours||0) + 'h</div>' +
              '</div>' +
              '<div style="font-size:10px;font-weight:700;color:var(--steam);flex-shrink:0">Click to set →</div>' +
            '</div>';
          }).join('') +
        '</div>'
      : '';
    el.innerHTML =
      '<div class="empty-state" style="padding:40px 0"><div class="empty-icon">🎯</div><h3>No goals set</h3><p>Track how close you are to your playtime milestones.</p></div>' +
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
          '<div style="font-size:10px;color:var(--text3);margin-top:1px">Next milestone: ' + s.milestone + 'h · currently ' + (s.game.playtimeHours||0) + 'h</div>' +
        '</div>' +
        '<div style="font-size:10px;font-weight:700;color:var(--steam);flex-shrink:0">Click to set →</div>' +
      '</div>';
    }).join('');
  }

  el.innerHTML = html;
}


// ── COLLECTION VALUE ──
function renderCollectionValue() {
  var el = document.getElementById('collectionValueArea');
  if (!el) return;

  var valued = [];
  games.forEach(function(g) {
    var wEntry = wishlist.find(function(w) { return normalizeTitle(w.title) === normalizeTitle(g.title); });
    if (wEntry && wEntry.bestPrice !== null && wEntry.bestPrice !== undefined) {
      valued.push({ title: g.title, price: wEntry.bestPrice });
    }
  });

  var totalValue     = valued.reduce(function(s, v) { return s + v.price; }, 0);
  var trackedCount   = valued.length;
  var untrackedCount = games.length - trackedCount;
  var coveragePct    = games.length ? Math.round(trackedCount / games.length * 100) : 0;
  var avgPrice       = trackedCount ? (totalValue / trackedCount).toFixed(2) : null;

  var rows = valued.slice().sort(function(a,b) { return b.price - a.price; }).slice(0, 10)
    .map(function(v) {
      return '<div class="stat-bar-row">' +
        '<div class="stat-bar-label" style="flex:1">' + escHtml(v.title) + '</div>' +
        '<div style="font-size:12px;color:#4ade80;font-weight:700">$' + v.price.toFixed(2) + '</div>' +
      '</div>';
    }).join('');

  el.innerHTML =
    '<div class="stat-bar-title" style="margin-bottom:12px">Collection Value</div>' +
    '<div class="stats-cols" style="margin-bottom:16px">' +
      '<div class="stats-panel">' +
        '<div class="stat-bar-title">Tracked Value</div>' +
        '<div style="font-size:28px;font-weight:800;color:#4ade80;margin:8px 0">$' + totalValue.toFixed(2) + '</div>' +
        '<div style="font-size:11px;color:var(--text3)">' + trackedCount + ' games with known prices</div>' +
      '</div>' +
      '<div class="stats-panel">' +
        '<div class="stat-bar-title">Coverage</div>' +
        '<div style="font-size:28px;font-weight:800;color:var(--text2);margin:8px 0">' + coveragePct + '%</div>' +
        '<div style="font-size:11px;color:var(--text3)">' + untrackedCount + ' unpriced · add to wishlist to track</div>' +
      '</div>' +
      '<div class="stats-panel">' +
        '<div class="stat-bar-title">Avg Price</div>' +
        '<div style="font-size:28px;font-weight:800;color:var(--steam);margin:8px 0">' + (avgPrice ? '$' + avgPrice : '—') + '</div>' +
        '<div style="font-size:11px;color:var(--text3)">per tracked title</div>' +
      '</div>' +
    '</div>' +
    (rows ? '<div class="stats-panel"><div class="stat-bar-title" style="margin-bottom:10px">Top Valued Games</div>' + rows + '</div>' : '');
}

function populateGoalGameSelect() {
  var sel = document.getElementById('goalGameSelect');
  if (!sel) return;
  var sorted = games.slice().sort(function(a,b) { return a.title.localeCompare(b.title); });
  sel.innerHTML = '<option value="">Select a game…</option>' +
    sorted.map(function(g) {
      var hrs = g.playtimeHours ? ' (' + g.playtimeHours + 'h)' : '';
      return '<option value="' + g.id + '">' + escHtml(g.title) + escHtml(hrs) + '</option>';
    }).join('');
}


// ── PRICE ALERT HISTORY ──
async function renderNotifHistory() {
  var el = document.getElementById('notifHistoryArea');
  if (!el) return;
  var history = await window.nexus.notif.getHistory();
  if (!history.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:12px 0">No price alerts yet. Set a target price on a wishlist game.</div>';
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
function renderDiscovery() {
  var el = document.getElementById('discoveryArea');
  if (!el) return;

  var played = games.filter(function(g) { return (g.playtimeHours || 0) > 0; });
  if (played.length < 3) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:12px 0">Play more games to unlock recommendations.</div>';
    return;
  }

  var genreScore = {}, tagScore = {};
  played.forEach(function(g) {
    var hrs = Math.log(1 + (g.playtimeHours || 0));
    (g.genres && g.genres.length ? g.genres : [g.genre || 'Other']).forEach(function(gn) {
      if (gn) genreScore[gn] = (genreScore[gn] || 0) + hrs;
    });
    (g.tags || []).forEach(function(t) {
      if (t) tagScore[t] = (tagScore[t] || 0) + hrs;
    });
  });
  var topGenres = Object.entries(genreScore).sort(function(a,b){return b[1]-a[1];}).slice(0,5).map(function(e){return e[0];});
  var topTags   = Object.entries(tagScore).sort(function(a,b){return b[1]-a[1];}).slice(0,10).map(function(e){return e[0];});

  var candidates = games.filter(function(g) {
    return (!g.playtimeHours || g.playtimeHours === 0) && g.status !== 'abandoned';
  });

  var scored = candidates.map(function(g) {
    var score = 0;
    var gGenres = (g.genres && g.genres.length ? g.genres : [g.genre || 'Other']);
    gGenres.forEach(function(gn) { if (topGenres.includes(gn)) score += 3; });
    (g.tags || []).forEach(function(t) { if (topTags.includes(t)) score += 1; });
    if ((g.playtimeHours||0) === 0) score += 2;
    return { game: g, score: score };
  }).filter(function(s) { return s.score > 0; })
    .sort(function(a,b) { return b.score - a.score; })
    .slice(0, 12);

  if (!scored.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:12px 0">No unplayed matches found. Try tagging your games.</div>';
    return;
  }

  el.innerHTML =
    '<div style="font-size:11px;color:var(--text3);margin-bottom:12px">Based on your top genres: ' +
      topGenres.slice(0,3).map(function(g){ return '<strong style="color:var(--text2)">' + escHtml(g) + '</strong>'; }).join(', ') +
    '</div>' +
    '<div class="discovery-grid">' +
      scored.map(function(s) {
        var g = s.game;
        var coverUrl = coverCache[g.id] || coverCache[String(g.id)];
        var pal = COVER_PALETTES[(g.pal||0) % COVER_PALETTES.length];
        var gGenres = (g.genres && g.genres.length ? g.genres : [g.genre||'Other']).join(' · ');
        return '<div class="discovery-card" onclick="openGameDetail(games.find(function(gm){return gm.id===' + g.id + '}))">' +
          '<div class="discovery-cover">' +
            (coverUrl
              ? '<img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover">'
              : '<div style="width:100%;height:100%;background:linear-gradient(145deg,' + pal.join(',') + ');display:flex;align-items:flex-end;padding:6px;box-sizing:border-box">' +
                  '<div style="font-size:9px;font-weight:700;color:rgba(255,255,255,0.9);line-height:1.2">' + escHtml(g.title) + '</div>' +
                '</div>') +
            '</div>' +
          '<div style="padding:6px 4px">' +
            '<div style="font-size:10px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(g.title) + '</div>' +
            '<div style="font-size:9px;color:var(--text3);margin-top:1px">' + escHtml(gGenres) + '</div>' +
          '</div>' +
        '</div>';
      }).join('') +
    '</div>';
}


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
  renderPlayNext();
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
  setText('sb-count-hidden',    games.filter(function(g) { return !!g.hidden; }).length);
  setText('sb-count-exploring', games.filter(function(g) { return g.status === 'exploring'; }).length);
  setText('sb-count-unplayed',   games.filter(function(g) { return (g.playtimeHours||0) === 0 && g.status !== 'not-for-me' && !g.gpCatalog; }).length);
  setText('sb-count-finished',   games.filter(function(g) { return g.status === 'finished'; }).length);
}

// ── LIBRARY RENDER ──
function renderLibrary() {
  kbFocusIdx = -1;
  updateCounts();
  const list = getFiltered();
  const area = document.getElementById('gameArea');

  if (list.length === 0) {
    area.innerHTML = '<div class="empty-state"><div class="empty-icon">\uD83C\uDFAE</div><h3>No games found</h3><p>Try a different search or add games using the button above.</p></div>';
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
                return '<div class="plat-dot" style="background:' + (PLAT_COLOR[p] || '#888') + '" title="' + (PLAT_LABEL[p] || p) + '"></div>';
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
      var color = PLAT_COLOR[g.platforms[0]] || '#888';
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
        '<div class="list-playtime">' + (g.playtimeHours > 0 ? (g.playtimeHours >= 1000 ? (g.playtimeHours/1000).toFixed(1)+'k' : g.playtimeHours) + 'h' : '<span style="color:var(--text3)">—</span>') + '</div>' +
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
function renderStats() {
  const area = document.getElementById('statsArea');
  const dupes = getDupes();
  const sc = function(p) { return games.filter(g => g.platforms.includes(p)).length; };

  // Platform data
  const platData = [
    ['Steam','steam',sc('steam'),'var(--steam)'],
    ['GOG','gog',sc('gog'),'var(--gog)'],
    ['Epic','epic',sc('epic'),'var(--epic)'],
    ['Amazon','amazon',sc('amazon'),'var(--amazon)'],
    ['Xbox','xbox',sc('xbox'),'#107c10'],
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

  // Recently added (last 30 days)
  const cutoff = Date.now() - 30*24*60*60*1000;
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
      statCard(totalHours >= 1000 ? (totalHours/1000).toFixed(1) + 'k' : totalHours, 'Hours Played', 'var(--steam)') +
      statCard(withTime.length, 'Games Played', '#7fc8f8', 'playtime') +      statCard(dupes.length, 'Duplicates', 'var(--dupe)', 'dupes') +
      statCard(games.length - dupes.length, 'Unique Titles', 'var(--text3)') +
      statCard(wishlist.length, 'Wishlisted', 'var(--epic)') +
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
    '<div class="stats-panel" id="discoveryPanel"><div class="stat-bar-title" style="margin-bottom:8px">🎮 Play Next — Personalized Picks</div><div id="discoveryArea"></div></div>' +
    '<div class="stats-panel" id="collectionValueArea"><div style="font-size:11px;color:var(--text3)">Loading…</div></div>';

  // Render deferred panels (need DOM to exist first)
  requestAnimationFrame(function() {
    renderStatusPanel();
    renderDiscovery();
    renderCollectionValue();
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
    area.innerHTML = '<div class="empty-state"><div class="empty-icon">\u2705</div><h3>No duplicates found!</h3><p>Every game in your library is unique.</p></div>';
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
    var color = PLAT_COLOR[g.platforms[0]] || '#888';
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
  if (!confirm('Merge ' + duplicates.length + ' record(s) into "' + canonical.title + '"?\n\nThis will combine platforms, keep the best playtime, and delete the duplicate records.')) return;

  // Build merged fields
  var allPlatforms = [...canonical.platforms];
  var bestPlaytime = canonical.playtimeHours || 0;
  var mergedTags   = [...(canonical.tags || [])];
  var mergedGenres = [...(canonical.genres || (canonical.genre ? [canonical.genre] : []))];

  duplicates.forEach(function(d) {
    d.platforms.forEach(function(p) { if (!allPlatforms.includes(p)) allPlatforms.push(p); });
    if ((d.playtimeHours || 0) > bestPlaytime) bestPlaytime = d.playtimeHours;
    (d.tags || []).forEach(function(t) { if (!mergedTags.includes(t)) mergedTags.push(t); });
    (d.genres || (d.genre ? [d.genre] : [])).forEach(function(g) { if (!mergedGenres.includes(g)) mergedGenres.push(g); });
  });

  // Update canonical record
  var fields = {
    platforms: allPlatforms,
    playtimeHours: bestPlaytime,
    tags: mergedTags,
    genres: mergedGenres,
    genre: mergedGenres[0] || canonical.genre || 'Other',
    steamAppId: canonical.steamAppId || duplicates.find(function(d) { return d.steamAppId; })?.steamAppId,
  };
  await window.nexus.games.update(canonical.id, fields);

  // Transfer cover if canonical has none but duplicate does
  var canonicalHasCover = coverCache[canonical.id] || coverCache[String(canonical.id)];
  if (!canonicalHasCover) {
    for (var i = 0; i < duplicates.length; i++) {
      var dupCover = coverCache[duplicates[i].id] || coverCache[String(duplicates[i].id)];
      if (dupCover) { coverCache[canonical.id] = dupCover; break; }
    }
  }

  // Delete duplicate records
  for (var j = 0; j < duplicates.length; j++) {
    await window.nexus.games.delete(duplicates[j].id);
  }

  // Refresh local state
  games = await window.nexus.games.getAll();
  renderAll();
  if (currentPage === 'dupes') renderDupesPage();
  showStatus('\u2713 Merged "' + canonical.title + '"', 100);
  setTimeout(hideStatus, 3000);
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
    for (var i = 0; i < games.length; i++) {
      await window.nexus.games.delete(games[i].id);
    }
    games = [];
    renderAll();
  }
}

// ── EXPORT ──
async function exportJSON() {
  var fb = document.getElementById('exportFeedback');
  try {
    var result = await window.nexus.library.exportJSON();
    if (result.cancelled) return;
    fb.textContent = '\u2713 Exported ' + result.count + ' games to ' + result.path;
    fb.className = 'settings-feedback ok';
  } catch(e) {
    fb.textContent = 'Export failed: ' + e.message;
    fb.className = 'settings-feedback err';
  }
}

async function exportCSV() {
  var fb = document.getElementById('exportFeedback');
  try {
    var result = await window.nexus.library.exportCSV();
    if (result.cancelled) return;
    fb.textContent = '\u2713 Exported ' + result.count + ' games to ' + result.path;
    fb.className = 'settings-feedback ok';
  } catch(e) {
    fb.textContent = 'Export failed: ' + e.message;
    fb.className = 'settings-feedback err';
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

    document.getElementById('steam-sync-status').textContent = 'Synced at ' + syncTime;
    document.getElementById('steam-sync-status').className = 'account-status status-ok';
    document.getElementById('steam-status').textContent = 'Connected';
    document.getElementById('steamResyncBtn').disabled = false;
    document.getElementById('steamResyncBtn').style.opacity = '1';
    document.getElementById('steamLastSyncLabel').textContent = 'Last synced: ' + syncTime;
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
    document.getElementById('steamLastSyncLabel').textContent = 'Last synced: ' + syncTime;
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
    document.getElementById('steam-status').textContent = 'Connected';
    var syncText = lastSync ? 'Last synced ' + new Date(lastSync).toLocaleDateString() : 'Connected';
    document.getElementById('steam-sync-status').textContent = syncText;
    document.getElementById('steam-sync-status').className = 'account-status status-ok';
    document.getElementById('steamResyncBtn').disabled = false;
    document.getElementById('steamResyncBtn').style.opacity = '1';
    if (lastSync) document.getElementById('steamLastSyncLabel').textContent = 'Last synced: ' + new Date(lastSync).toLocaleString();
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
    // update sidebar
    var gogStatus = document.querySelector('.sidebar-row[data-filter="gog"] .sidebar-row-sub');
    if (gogStatus) gogStatus.textContent = 'Synced ✓';
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
    var epicStatus = document.getElementById('epic-status');
    if (epicStatus) epicStatus.textContent = 'Synced ✓';
    var amazonStatus = document.getElementById('amazon-status');
    if (amazonStatus && result.amazon.total > 0) amazonStatus.textContent = 'Synced ✓';
  } catch (err) {
    feedback.textContent = 'Error: ' + err.message;
    feedback.className = 'settings-feedback err';
    showStatus('✗ Heroic import failed: ' + err.message, 100, {type:'error'});
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import via Heroic';
  }
}

// ── LOAD SAVED PLATFORM SYNC STATUS ──
async function loadPlatformSyncStatus() {
  var gogSync  = await window.nexus.store.get('gogLastSync');
  var epicSync = await window.nexus.store.get('epicLastSync');
  if (gogSync) {
    document.getElementById('gogLastSyncLabel').textContent = 'Last synced: ' + new Date(gogSync).toLocaleString();
    var gogStatus = document.querySelector('.sidebar-row[data-filter="gog"] .sidebar-row-sub');
    if (gogStatus) gogStatus.textContent = 'Synced ✓';
  }
  if (epicSync) {
    var epicStatus = document.querySelector('.sidebar-row[data-filter="epic"] .sidebar-row-sub');
    if (epicStatus) epicStatus.textContent = 'Synced ✓';
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
  var needsArt = games.filter(function(g) {
    var sid = String(g.id);
    return !manualOverrides[sid] && !manualOverrides[g.id] &&
           !coverCache[g.id]     && !coverCache[sid];
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
    var ptText = (game.playtimeHours >= 1000
      ? (game.playtimeHours/1000).toFixed(1) + 'k' : game.playtimeHours) + ' hours played';
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
  }
  renderLibrary();
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
    // Strip trademark/copyright symbols, replacing with a space to avoid joining words
    .replace(/\s*[\u2122\u00ae\u00a9]\s*/g, ' ')
    // Strip Amazon/Epic/GOG/Prime service suffixes
    .replace(/\s*[-–]\s*Amazon\s*(Prime\s*(Gaming)?|Luna|Gaming)?\s*$/i, '')
    .replace(/\s*\(Amazon\s*(Prime\s*(Gaming)?|Luna|Gaming)?\)\s*$/i, '')
    .replace(/\s*[-–]\s*Prime\s*(Gaming|Giveaway)?\s*$/i, '')
    .replace(/\s*\(Prime\s*(Gaming|Giveaway)?\)\s*$/i, '')
    .replace(/\s*[-–]\s*Epic\s*Games?\s*$/i, '')
    .replace(/\s*[-–]\s*GOG\.?CO?M?\s*$/i, '')
    // Strip Xbox platform suffixes — covers dash, space, or "for" variants,
    // and mangled separators: X|S, X/S, XIS, "X S"
    .replace(/\s+for\s+Xbox\b.*$/i, '')
    .replace(/\s*[-–]\s*Xbox\b.*$/i, '')
    .replace(/\s+Xbox\s+Series\s+X[\|\/\s]?I?S?\s*$/i, '')
    .replace(/\s+Xbox\s+(One|360|Series\s*X?\s*S?)?\s*$/i, '')
    // Strip platform/OS suffixes
    .replace(/\s*[-–]\s*Windows\s*(Edition|Version|10|11)?\s*$/i, '')
    .replace(/\s*\((WIN|Windows|PC)\)\s*$/i, '')
    .replace(/\s*\[(WIN|Windows|PC)\]\s*$/i, '')
    // Strip collector's/special edition shorthands
    .replace(/\s*[-–]\s*(CE|SE|GE|VE)\s*$/i, '')
    // Strip edition/version noise
    .replace(/\s*[:\-–]\s*(Complete|Gold|GOTY|Definitive|Enhanced|Remaster(ed)?|Standard|Premium|Deluxe|Ultimate|Anniversary|Special|Legacy|Directors? Cut)\s+(Edition|Version|Cut)?\s*$/i, '')
    .replace(/\s*[:\-–]\s*(Complete|Gold|GOTY|Definitive|Enhanced|Remaster(ed)?|Standard|Premium|Deluxe|Ultimate|Anniversary|Special|Legacy|Directors? Cut)\s*$/i, '')
    .replace(/\s*\(GOTY\)\s*$/i, '')
    .replace(/\s+(Edition|Version)\s*$/i, '')
    .replace(/^ARCADE GAME SERIES:\s*/i, '')
    .replace(/\s*\((PC|Windows|Mac|Steam|GOG|Epic|Amazon|Prime Gaming|Heroic)\)\s*$/i, '')
    .replace(/\s*\[(PC|Windows|Mac|Steam|GOG|Epic|Amazon|Prime Gaming)\]\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
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
}

async function removeFromWishlist(id) {
  if (confirm('Remove this game from your wishlist?')) {
    await window.nexus.wishlist.delete(id);
    wishlist = await window.nexus.wishlist.getAll();
    renderWishlist();
    updateNavWishPip();
  }
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
        '<h3>' + (q ? 'No results' : 'Your wishlist is empty') + '</h3>' +
        '<p>' + (q ? 'Try a different search.' : 'Click \u201cAdd to Wishlist\u201d to track games and get sale alerts.') + '</p>' +
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
          (owned ? '<div class="wish-owned-badge">\u2713 Owned on ' + owned.platforms.map(function(p) { return PLAT_LABEL[p] || p; }).join(', ') + '</div>' : '') +
          (w.targetPrice || w.discountThreshold
            ? '<div class="wish-target">' +
                (w.targetPrice ? 'Alert at <span>$' + w.targetPrice.toFixed(2) + '</span>' : '') +
                (w.targetPrice && w.discountThreshold ? ' \u00B7 ' : '') +
                (w.discountThreshold ? '<span>' + w.discountThreshold + '% off</span>' : '') +
              '</div>'
            : '<div class="wish-target">No price target set</div>') +
          makeSparkline(w.priceHistory) +
        '</div>' +
        '<button class="wish-delete" data-id="' + w.id + '">' +
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>' +
        '</button>' +
      '</div>' +
      priceHtml +
      '<div class="wish-actions">' +
        '<button class="wish-action-btn primary gg-btn">View on gg.deals</button>' +
        (w.priceHistory && w.priceHistory.length >= 2 ? '<button class="wish-action-btn hist-btn">📈 History</button>' : '') +
        '<button class="wish-action-btn" data-action="remove">Remove</button>' +
      '</div>';

    card.querySelector('.wish-delete').addEventListener('click', function() { removeFromWishlist(w.id); });
    card.querySelector('[data-action="remove"]').addEventListener('click', function() { removeFromWishlist(w.id); });
    card.querySelector('.gg-btn').addEventListener('click', function() { window.open(ggUrl, '_blank'); });
    var histBtn = card.querySelector('.hist-btn');
    if (histBtn) histBtn.addEventListener('click', function() { showPriceHistory(w); });

    grid.appendChild(card);
  });

  area.innerHTML = '';
  area.appendChild(grid);

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
  if (!key) { feedback.textContent = 'Please enter your RAWG API key.'; feedback.className = 'settings-feedback err'; return; }
  try {
    var results = await window.nexus.rawg.search('Hades', key);
    if (!results || !results.length) throw new Error('Test search returned no results');
    await window.nexus.store.set('rawgApiKey', key);
    rawgApiKey = key;
    document.getElementById('rawgApiKey').value = '';
    document.getElementById('rawgApiKey').placeholder = 'RAWG API Key saved \u2713';
    feedback.textContent = '\u2713 Key saved! RAWG will now be used for non-Steam games.';
    feedback.className = 'settings-feedback ok';
  } catch(e) {
    feedback.textContent = '\u2717 ' + e.message;
    feedback.className = 'settings-feedback err';
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
  el.innerHTML = ''; // clear before re-render

  var statusCounts = { exploring: 0, finished: 0, 'not-for-me': 0, none: 0 };
  games.forEach(function(g) {
    if (g.status && statusCounts[g.status] !== undefined) statusCounts[g.status]++;
    else statusCounts.none++;
  });
  var completionRate = games.length ? Math.round((statusCounts.finished / games.length) * 100) : 0;
  var avgPlaytime    = games.filter(function(g){return(g.playtimeHours||0)>0;}).length
    ? Math.round(games.reduce(function(s,g){return s+(g.playtimeHours||0);},0) / games.filter(function(g){return(g.playtimeHours||0)>0;}).length) : 0;

  var tagCounts = {};
  games.forEach(function(g) {
    (g.tags||[]).forEach(function(t) { if(t) tagCounts[t] = (tagCounts[t]||0)+1; });
  });
  var topTags = Object.entries(tagCounts).sort(function(a,b){return b[1]-a[1];}).slice(0,20);

  var rows = [
    ['▶ Exploring',   'exploring',   '#60a5fa', statusCounts.exploring],
    ['✓ Finished',    'finished',    '#4ade80', statusCounts.finished],
    ['✕ Not for Me',  'not-for-me',  '#f87171', statusCounts['not-for-me']],
    ['— Untracked', '',          '#555',    statusCounts.none],
  ];

  // Status panel
  var statusEl = document.createElement('div');
  statusEl.className = 'stats-cols';

  var leftPanel = document.createElement('div');
  leftPanel.className = 'stats-panel';
  leftPanel.innerHTML = '<div class="stat-bar-title">Library Status</div>';

  var barsEl = document.createElement('div');
  barsEl.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:10px';

  rows.forEach(function(row) {
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

  var footer = document.createElement('div');
  footer.style.cssText = 'font-size:10px;color:var(--text3);margin-top:8px;border-top:1px solid var(--border);padding-top:6px';
  footer.innerHTML = 'Completion rate: <strong style="color:#4ade80">' + completionRate + '%</strong> · Avg playtime: <strong style="color:var(--steam)">' + avgPlaytime + 'h</strong>';

  leftPanel.appendChild(barsEl);
  leftPanel.appendChild(footer);

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

  var noArtGames   = games.filter(function(g) { return !coverCache[g.id] && !coverCache[String(g.id)]; });
  var noGenreGames = games.filter(function(g) { return !g.genre || g.genre === 'Other'; });
  var noTagGames   = games.filter(function(g) { return !g.tags || !g.tags.length; });
  var noStatusGames= games.filter(function(g) { return !g.status; });
  var noPlatGames  = games.filter(function(g) { return !g.platforms || !g.platforms.length; });
  var dupeGames    = getDupes ? getDupes() : [];
  var noTimeGames  = games.filter(function(g) { return !g.playtimeHours && g.platforms.includes('steam'); });
  var totalIssues  = noArtGames.length + noGenreGames.length + noTagGames.length + noStatusGames.length;
  var healthScore  = games.length ? Math.max(0, Math.round(100 - (totalIssues / (games.length * 4)) * 100)) : 0;
  var scoreColor   = healthScore >= 80 ? '#4ade80' : healthScore >= 60 ? '#facc15' : '#f87171';

  var healthRows = [
    { label: '🖼 Missing Cover Art',  count: noArtGames.length,    filter: 'noart',  action: noArtGames.length > 0 ? '<button onclick="fetchCoversInBackground();this.textContent=\'Fetching…\';this.disabled=true" style="font-size:9px;padding:1px 7px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text3);cursor:pointer;margin-left:auto">Auto Fetch</button>' : '' },
    { label: '🏷 Genre is "Other"',   count: noGenreGames.length,  filter: 'all',    action: '' },
    { label: '🔖 No Tags',            count: noTagGames.length,    filter: 'all',    action: '' },
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

    // Review summary
    var reviewText = '';
    if (d.recommendations && d.recommendations.total)
      reviewText = d.recommendations.total.toLocaleString() + ' reviews';

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
    if (currentDetailGame.genre === 'Other' && d.genres && d.genres.length)
      updates.genre = d.genres[0].description;

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
async function fillMissingMetadata()      { await _fillMetadata(true, true);  }
async function fillMissingMetadataSteam() { await _fillMetadata(true, false); }
async function fillMissingMetadataRawg()  { await _fillMetadata(false, true); }

async function _fillMetadata(doSteam, doRawg) {
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
        if (!sResult) { console.warn('[FillMetadata] No result for', sGame.title, sGame.steamAppId); continue; }
        console.log('[FillMetadata]', sGame.title, '| tags:', sResult.tags);
        var fields = {};
        if (sResult.genres && sResult.genres.length) {
          var mapped = mapSteamGenres(sResult.genres);
          fields.genres = mapped;
          if (!sGame.genre || sGame.genre === 'Other') fields.genre = mapped[0];
        }
        if (sResult.tags && sResult.tags.length) {
          fields.tags = sResult.tags
            .filter(function(t) { return t && typeof t === 'string'; })
            .map(function(t) { return t.toLowerCase(); });
        }
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
    var diff = Math.floor((Date.now() - d) / (1000*60*60*24));
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
async function renderHabitsPage() {
  var el = document.getElementById('habitsContent');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">Loading habits…</div>';

  // Load all sessions in one call
  var allSessionData = {};
  try { allSessionData = await window.nexus.store.getByPrefix('sessions:') || {}; } catch(e) {}

  var allSessions = [];
  Object.entries(allSessionData).forEach(function(entry) {
    var gameId = entry[0].replace('sessions:', '');
    var game   = games.find(function(g) { return String(g.id) === String(gameId); });
    (entry[1] || []).forEach(function(s) {
      allSessions.push({ gameId: gameId, title: game ? game.title : 'Unknown', game: game, date: new Date(s.date), seconds: s.seconds });
    });
  });
  allSessions.sort(function(a,b) { return b.date - a.date; });

  // Recently played (by lastPlayedAt)
  var recentlyPlayed = games
    .filter(function(g) { return g.lastPlayedAt; })
    .sort(function(a,b) { return new Date(b.lastPlayedAt) - new Date(a.lastPlayedAt); })
    .slice(0, 10);

  // Day-of-week data — both totals AND per-day top game
  var dayTotals  = [0,0,0,0,0,0,0];
  var dayGames   = [[],[],[],[],[],[],[]]; // sessions per day
  var dayLabels  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  allSessions.forEach(function(s) {
    var d = s.date.getDay();
    dayTotals[d] += s.seconds;
    dayGames[d].push(s);
  });
  var maxDay = Math.max.apply(null, dayTotals) || 1;

  // Top game per day of week
  var dayTopGame = dayGames.map(function(sessions) {
    var byGame = {};
    sessions.forEach(function(s) { byGame[s.title] = (byGame[s.title]||0) + s.seconds; });
    var top = Object.entries(byGame).sort(function(a,b){return b[1]-a[1];})[0];
    return top ? { title: top[0], hrs: (top[1]/3600).toFixed(1) } : null;
  });

  // Session stats
  var totalSessionSecs = allSessions.reduce(function(t,s) { return t + s.seconds; }, 0);
  var totalSessionHrs  = (totalSessionSecs / 3600).toFixed(1);
  var avgSessionMins   = allSessions.length ? Math.round(totalSessionSecs / allSessions.length / 60) : 0;
  var longestSession   = allSessions.reduce(function(max, s) { return s.seconds > max.seconds ? s : max; }, { seconds: 0, title: '' });

  // Rated games
  var ratedGames = games.filter(function(g) { return g.userRating > 0; })
    .sort(function(a,b) { return b.userRating - a.userRating; });
  var avgRating = ratedGames.length
    ? (ratedGames.reduce(function(t,g) { return t + g.userRating; }, 0) / ratedGames.length).toFixed(1) : null;

  // vs Metacritic
  var bothRated  = ratedGames.filter(function(g) { return g.metacriticScore; });
  var ratingDiff = bothRated.map(function(g) {
    return { title: g.title, yours: g.userRating * 10, meta: g.metacriticScore, diff: (g.userRating * 10) - g.metacriticScore };
  }).sort(function(a,b) { return Math.abs(b.diff) - Math.abs(a.diff); }).slice(0,5);

  // Cost per hour
  var costGames = games.filter(function(g) {
    var w = wishlist.find(function(w) { return normalizeTitle(w.title) === normalizeTitle(g.title); });
    return g.playtimeHours > 0 && w && w.retailPrice;
  }).map(function(g) {
    var w = wishlist.find(function(w) { return normalizeTitle(w.title) === normalizeTitle(g.title); });
    return { title: g.title, cph: (w.retailPrice / g.playtimeHours).toFixed(2), hrs: g.playtimeHours, price: w.retailPrice };
  }).sort(function(a,b) { return a.cph - b.cph; }).slice(0, 8);

  // ── BUILD HTML ──
  function panel(titleText, content) {
    return '<div class="habits-panel">' +
      '<div class="habits-panel-title">' + titleText + '</div>' +
      content +
    '</div>';
  }

  // Summary row
  var longestLabel = longestSession.seconds > 0
    ? Math.round(longestSession.seconds/60) + 'm'
    : '—';
  var summaryHtml =
    '<div class="habits-stat-row">' +
      habitStat(allSessions.length || '—', 'Sessions Logged', '#4a9eed') +
      habitStat(totalSessionHrs + 'h', 'Total Session Time', '#4ade80') +
      habitStat(avgSessionMins > 0 ? avgSessionMins + 'm' : '—', 'Avg Session', '#fb923c') +
      habitStat(longestLabel, 'Longest Session', '#a78bfa') +
    '</div>';

  // Day of week chart — proper proportional bars with tooltip showing top game
  var dowHtml = '';
  if (allSessions.length) {
    dowHtml = '<div class="habits-dow-grid">' +
      dayLabels.map(function(d, i) {
        var pct = dayTotals[i] / maxDay;
        var hrs = (dayTotals[i] / 3600).toFixed(1);
        var barH = Math.max(3, Math.round(pct * 80)); // max 80px, min 3px
        var opacity = dayTotals[i] > 0 ? (0.3 + pct * 0.7) : 0.12;
        var topGame = dayTopGame[i];
        var tooltipContent = dayTotals[i] > 0
          ? hrs + 'h total' + (topGame ? ' · ' + topGame.title.slice(0,18) + (topGame.title.length > 18 ? '…' : '') + ' (' + topGame.hrs + 'h)' : '')
          : 'No sessions';
        return '<div class="habits-dow-col">' +
          '<div class="habits-dow-bar-wrap">' +
            '<div class="habits-dow-tooltip">' + escHtml(tooltipContent) + '</div>' +
            '<div class="habits-dow-bar" style="height:' + barH + 'px;background:var(--steam);opacity:' + opacity.toFixed(2) + '"></div>' +
          '</div>' +
          '<div class="habits-dow-label">' + d + '</div>' +
          '<div class="habits-dow-hrs">' + (dayTotals[i] > 0 ? hrs + 'h' : '') + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  // Recently played rows
  var recentHtml = recentlyPlayed.length
    ? recentlyPlayed.map(function(g) {
        var cover = coverCache[g.id] || coverCache[String(g.id)];
        var d = new Date(g.lastPlayedAt);
        var diff = Math.floor((Date.now() - d) / (1000*60*60*24));
        var when = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff + 'd ago';
        var stars = g.userRating > 0 ? '<span style="color:#facc15;letter-spacing:-1px">' + '★'.repeat(Math.round(g.userRating/2)) + '</span>' : '';
        var pal = COVER_PALETTES[(g.pal||0)%COVER_PALETTES.length];
        return '<div class="session-history-row">' +
          (cover
            ? '<img src="' + cover + '" style="width:34px;height:45px;border-radius:4px;object-fit:cover;flex-shrink:0">'
            : '<div style="width:34px;height:45px;border-radius:4px;flex-shrink:0;background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')"></div>') +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(g.title) + '</div>' +
            '<div style="font-size:10px;color:var(--text3);margin-top:2px">' + (g.playtimeHours||0) + 'h total' + (stars ? ' · ' + stars : '') + '</div>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--text3);flex-shrink:0">' + when + '</div>' +
        '</div>';
      }).join('')
    : '<div style="font-size:12px;color:var(--text3);padding:8px 0">No play history yet. Start a session from any game\'s detail view.</div>';

  // Recent sessions log (last 20)
  var sessionLogHtml = allSessions.slice(0, 20).map(function(s) {
    var d = s.date;
    var diff = Math.floor((Date.now() - d) / (1000*60*60*24));
    var when = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff + 'd ago';
    var dur = s.seconds >= 3600
      ? (s.seconds/3600).toFixed(1) + 'h'
      : Math.round(s.seconds/60) + 'm';
    var cover = s.game ? (coverCache[s.game.id] || coverCache[String(s.game.id)]) : null;
    var pal = s.game ? COVER_PALETTES[(s.game.pal||0)%COVER_PALETTES.length] : COVER_PALETTES[0];
    return '<div class="session-history-row">' +
      (cover
        ? '<img src="' + cover + '" style="width:28px;height:37px;border-radius:3px;object-fit:cover;flex-shrink:0">'
        : '<div style="width:28px;height:37px;border-radius:3px;flex-shrink:0;background:linear-gradient(145deg,' + pal[0] + ',' + pal[1] + ')"></div>') +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(s.title) + '</div>' +
        '<div style="font-size:10px;color:var(--text3);margin-top:1px">' + d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + '</div>' +
      '</div>' +
      '<div style="font-size:12px;font-weight:700;color:var(--steam);flex-shrink:0">' + dur + '</div>' +
    '</div>';
  }).join('') || '<div style="font-size:12px;color:var(--text3)">No sessions logged yet.</div>';

  // Ratings section
  var ratingsHtml = '';
  if (ratedGames.length) {
    var topRatedHtml = ratedGames.slice(0, 6).map(function(g) {
      var stars = Math.round(g.userRating / 2);
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
      : '<div style="font-size:11px;color:var(--text3);padding:6px 0">Rate games that have Metacritic scores to see comparisons.</div>';

    ratingsHtml =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">' +
        '<div class="habits-panel">' +
          '<div class="habits-panel-title">⭐ Your Top Rated</div>' +
          topRatedHtml +
          (avgRating ? '<div style="font-size:10px;color:var(--text3);margin-top:8px;border-top:1px solid var(--border);padding-top:6px">Avg rating: <strong style="color:#facc15">' + avgRating + ' / 10</strong> across ' + ratedGames.length + ' games</div>' : '') +
        '</div>' +
        '<div class="habits-panel">' +
          '<div class="habits-panel-title">📊 You vs Metacritic</div>' +
          vsMetaHtml +
        '</div>' +
      '</div>';
  }

  // Cost per hour
  var cphHtml = '';
  if (costGames.length) {
    var maxCphInverse = 1 / Math.max(0.01, parseFloat(costGames[0].cph));
    cphHtml = panel('💰 Best Value — Cost per Hour',
      '<div style="font-size:10px;color:var(--text3);margin-bottom:10px">Retail price ÷ hours played · lower is better</div>' +
      costGames.map(function(g) {
        var bar = Math.min(100, Math.round((1 / Math.max(0.01, parseFloat(g.cph))) / maxCphInverse * 100));
        return '<div style="margin-bottom:9px">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:3px">' +
            '<span style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%">' + escHtml(g.title) + '</span>' +
            '<span style="font-size:11px;font-weight:700;color:#4ade80;flex-shrink:0">$' + g.cph + '/hr</span>' +
          '</div>' +
          '<div style="height:3px;background:var(--surface2);border-radius:2px">' +
            '<div style="height:100%;width:' + bar + '%;background:linear-gradient(90deg,#4ade80,#7fc8f8);border-radius:2px"></div>' +
          '</div>' +
        '</div>';
      }).join('')
    );
  }

  el.innerHTML =
    panel('📊 Overview', summaryHtml) +
    (allSessions.length
      ? panel('📅 Play Activity by Day of Week', dowHtml)
      : '') +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">' +
      '<div class="habits-panel">' +
        '<div class="habits-panel-title">🕹 Recently Played</div>' +
        recentHtml +
      '</div>' +
      '<div class="habits-panel">' +
        '<div class="habits-panel-title">📝 Session Log</div>' +
        sessionLogHtml +
      '</div>' +
    '</div>' +
    ratingsHtml +
    burnDownSection(allSessions) +
    cphHtml;
}

function habitStat(val, label, color) {
  return '<div class="habits-stat-card">' +
    '<div class="habits-stat-val" style="color:' + color + '">' + val + '</div>' +
    '<div class="habits-stat-label">' + label + '</div>' +
  '</div>';
}

function statMini(val, label, color) {
  return '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center">' +
    '<div style="font-family:\'Syne\',sans-serif;font-size:22px;font-weight:900;color:' + color + '">' + val + '</div>' +
    '<div style="font-size:10px;color:var(--text3);margin-top:4px;text-transform:uppercase;letter-spacing:0.5px">' + label + '</div>' +
  '</div>';
}
async function renderWrappedPage() {
  var el = document.getElementById('wrappedContent');
  if (!el) return;

  // Populate year selector
  var yearSel = document.getElementById('wrappedYear');
  if (yearSel && !yearSel.options.length) {
    var currentYear = new Date().getFullYear();
    for (var y = currentYear; y >= 2020; y--) {
      var opt = document.createElement('option');
      opt.value = y; opt.textContent = y;
      yearSel.appendChild(opt);
    }
    yearSel.addEventListener('change', renderWrappedPage);
  }
  var year = parseInt((yearSel && yearSel.value) || new Date().getFullYear());

  var yearStart = new Date(year + '-01-01');
  var yearEnd   = new Date((year+1) + '-01-01');

  // Games added this year
  var addedThisYear = games.filter(function(g) {
    return g.addedAt && new Date(g.addedAt) >= yearStart && new Date(g.addedAt) < yearEnd;
  });

  // Games completed this year (status=completed and added/last played this year)
  var completedThisYear = games.filter(function(g) {
    return g.status === 'finished' && g.lastPlayedAt &&
      new Date(g.lastPlayedAt) >= yearStart && new Date(g.lastPlayedAt) < yearEnd;
  });

  // Sessions this year — bulk load
  var yearSessions = [];
  try {
    var allSD = await window.nexus.store.getByPrefix('sessions:') || {};
    Object.entries(allSD).forEach(function(entry) {
      var gameId = entry[0].replace('sessions:', '');
      var game   = games.find(function(g) { return String(g.id) === String(gameId); });
      (entry[1] || []).forEach(function(s) {
        var d = new Date(s.date);
        if (d >= yearStart && d < yearEnd) {
          yearSessions.push({ gameId: gameId, title: game ? game.title : gameId, date: d, seconds: s.seconds });
        }
      });
    });
  } catch(e) {}

  var totalYearSecs = yearSessions.reduce(function(t,s) { return t + s.seconds; }, 0);
  var totalYearHrs  = (totalYearSecs / 3600).toFixed(1);

  // Most played game this year by session time
  var gameSessionTime = {};
  yearSessions.forEach(function(s) {
    gameSessionTime[s.gameId] = (gameSessionTime[s.gameId] || 0) + s.seconds;
  });
  var topGameId   = Object.keys(gameSessionTime).sort(function(a,b) { return gameSessionTime[b]-gameSessionTime[a]; })[0];
  var topGame     = topGameId ? games.find(function(g) { return String(g.id) === String(topGameId); }) : null;
  var topGameHrs  = topGame ? (gameSessionTime[topGameId] / 3600).toFixed(1) : 0;

  // Genre breakdown this year
  var genreCounts = {};
  addedThisYear.forEach(function(g) {
    var genre = g.genre || 'Other';
    genreCounts[genre] = (genreCounts[genre] || 0) + 1;
  });
  var topGenres = Object.entries(genreCounts).sort(function(a,b){return b[1]-a[1];}).slice(0,5);

  // Top rated this year
  var topRatedYear = games
    .filter(function(g) { return g.userRating > 0 && g.lastPlayedAt && new Date(g.lastPlayedAt) >= yearStart && new Date(g.lastPlayedAt) < yearEnd; })
    .sort(function(a,b) { return b.userRating - a.userRating; })
    .slice(0, 5);

  // Backlog stat
  var backlogCount = games.filter(function(g) { return (g.playtimeHours||0) === 0 && g.status !== 'not-for-me' && !g.gpCatalog; }).length;
  var backlogHrsEst = backlogCount * 20; // rough 20hr estimate per game

  el.innerHTML =
    // Year card
    '<div style="background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);border-radius:16px;padding:28px;margin-bottom:20px;position:relative;overflow:hidden" id="wrappedCard">' +
      '<div style="position:absolute;top:-30px;right:-30px;width:150px;height:150px;border-radius:50%;background:rgba(74,158,237,0.08)"></div>' +
      '<div style="position:absolute;bottom:-20px;left:30px;width:100px;height:100px;border-radius:50%;background:rgba(251,146,60,0.08)"></div>' +
      '<div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.4);letter-spacing:3px;text-transform:uppercase;margin-bottom:4px">Nexus Library</div>' +
      '<div style="font-size:36px;font-weight:900;color:#fff;margin-bottom:20px">' + year + ' Wrapped</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px">' +
        wrappedStat(addedThisYear.length, 'Games Added') +
        wrappedStat(completedThisYear.length, 'Completed') +
        wrappedStat(totalYearHrs + 'h', 'Session Time') +
      '</div>' +
      (topGame ? '<div style="background:rgba(255,255,255,0.06);border-radius:10px;padding:14px;margin-bottom:16px">' +
        '<div style="font-size:10px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Most Played</div>' +
        '<div style="font-size:18px;font-weight:800;color:#fff">' + escHtml(topGame.title) + '</div>' +
        '<div style="font-size:12px;color:rgba(255,255,255,0.5);margin-top:2px">' + topGameHrs + ' hours logged</div>' +
      '</div>' : '') +
      (topRatedYear.length ? '<div style="background:rgba(255,255,255,0.06);border-radius:10px;padding:14px;margin-bottom:16px">' +
        '<div style="font-size:10px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Your Top Rated</div>' +
        topRatedYear.map(function(g,i) {
          return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
            '<span style="font-size:10px;color:rgba(255,255,255,0.3);min-width:14px">#' + (i+1) + '</span>' +
            '<span style="font-size:12px;color:#fff;flex:1">' + escHtml(g.title) + '</span>' +
            '<span style="color:#facc15;font-size:12px;font-weight:800">' + g.userRating + '</span>' +
          '</div>';
        }).join('') +
      '</div>' : '') +
      (topGenres.length ? '<div style="background:rgba(255,255,255,0.06);border-radius:10px;padding:14px">' +
        '<div style="font-size:10px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Top Genres Added</div>' +
        topGenres.map(function(g) {
          return '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
            '<span style="font-size:11px;color:rgba(255,255,255,0.8)">' + escHtml(g[0]) + '</span>' +
            '<span style="font-size:11px;color:rgba(255,255,255,0.4)">' + g[1] + ' games</span>' +
          '</div>';
        }).join('') +
      '</div>' : '') +
      '<div style="margin-top:16px;font-size:10px;color:rgba(255,255,255,0.25);text-align:right">nexus-library.app</div>' +
    '</div>' +

    // Backlog burn-down
    '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px">' +
      '<div style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:8px;text-transform:uppercase;letter-spacing:1px">📚 Backlog Snapshot</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">' +
        statMini(backlogCount, 'In Backlog', '#fb923c') +
        statMini('~' + Math.round(backlogHrsEst/10)*10 + 'h', 'Est. Play Time', '#fb923c') +
        statMini(yearSessions.length, 'Sessions This Year', '#4a9eed') +
      '</div>' +
    '</div>';

  // Wire export button
  var exportBtn = document.getElementById('exportLibraryCard');
  if (exportBtn) {
    exportBtn.onclick = exportLibraryCard;
  }
}

function wrappedStat(val, label) {
  return '<div style="text-align:center">' +
    '<div style="font-size:28px;font-weight:900;color:#fff">' + val + '</div>' +
    '<div style="font-size:10px;color:rgba(255,255,255,0.4);margin-top:2px;text-transform:uppercase;letter-spacing:0.5px">' + label + '</div>' +
  '</div>';
}

async function exportLibraryCard() {
  showStatus('Drawing library card…', -1);
  try {
    var year     = parseInt(document.getElementById('wrappedYear')?.value || new Date().getFullYear());
    var yearStart = new Date(year + '-01-01');
    var yearEnd   = new Date((year+1) + '-01-01');

    // Collect data
    var added     = games.filter(function(g) { return g.addedAt && new Date(g.addedAt) >= yearStart && new Date(g.addedAt) < yearEnd; }).length;
    var completed = games.filter(function(g) { return g.status === 'finished' && g.lastPlayedAt && new Date(g.lastPlayedAt) >= yearStart && new Date(g.lastPlayedAt) < yearEnd; }).length;
    var topRated  = games.filter(function(g) { return g.userRating > 0 && g.lastPlayedAt && new Date(g.lastPlayedAt) >= yearStart && new Date(g.lastPlayedAt) < yearEnd; }).sort(function(a,b){return b.userRating-a.userRating;}).slice(0,3);

    // Sessions this year — bulk load
    var sessionSecs = 0;
    try {
      var allSD2 = await window.nexus.store.getByPrefix('sessions:') || {};
      Object.values(allSD2).forEach(function(sessions) {
        (sessions || []).forEach(function(s) {
          var d = new Date(s.date);
          if (d >= yearStart && d < yearEnd) sessionSecs += s.seconds;
        });
      });
    } catch(e) {}
    var sessionHrs = (sessionSecs / 3600).toFixed(1);

    // Draw on canvas
    var W = 600, H = 400, DPR = 2;
    var canvas = document.createElement('canvas');
    canvas.width  = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    var ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);

    // Background gradient
    var bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0,   '#1a1a2e');
    bg.addColorStop(0.5, '#16213e');
    bg.addColorStop(1,   '#0f3460');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Decorative circles
    ctx.beginPath(); ctx.arc(W - 40, 40, 80, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(74,158,237,0.06)'; ctx.fill();
    ctx.beginPath(); ctx.arc(60, H - 40, 60, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(251,146,60,0.06)'; ctx.fill();

    // Header
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.letterSpacing = '3px';
    ctx.fillText('NEXUS LIBRARY', 36, 50);
    ctx.letterSpacing = '0px';

    ctx.fillStyle = '#ffffff';
    ctx.font = '900 52px system-ui, sans-serif';
    ctx.fillText(year + ' Wrapped', 36, 116);

    // Stats row
    function drawStat(label, val, x) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 36px system-ui, sans-serif';
      ctx.fillText(val, x, 196);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillText(label.toUpperCase(), x, 216);
    }
    drawStat('Games Added',  String(added),         36);
    drawStat('Completed',    String(completed),      210);
    drawStat('Session Time', sessionHrs + 'h',       370);

    // Divider
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(36, 236); ctx.lineTo(W - 36, 236); ctx.stroke();

    // Top rated games
    if (topRated.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '700 10px system-ui, sans-serif';
      ctx.fillText('TOP RATED', 36, 260);
      topRated.forEach(function(g, i) {
        var y = 284 + i * 28;
        // Rating stars
        ctx.fillStyle = '#facc15';
        ctx.font = '700 13px system-ui, sans-serif';
        ctx.fillText('★'.repeat(Math.round(g.userRating / 2)), 36, y);
        ctx.fillStyle = '#ffffff';
        ctx.font = '600 13px system-ui, sans-serif';
        ctx.fillText(g.title.slice(0, 38), 120, y);
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = '700 13px system-ui, sans-serif';
        ctx.fillText(g.userRating + '/10', W - 80, y);
      });
    }

    // Footer
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.font = '500 10px system-ui, sans-serif';
    ctx.fillText('nexus-library · ' + new Date().toLocaleDateString(), 36, H - 20);

    // Save
    var link = document.createElement('a');
    link.download = 'nexus-wrapped-' + year + '.png';
    link.href = canvas.toDataURL('image/png');
    link.click();

    hideStatus();
    showStatus('✓ Library card saved!', 100);
    setTimeout(hideStatus, 3000);
  } catch(e) {
    hideStatus();
    showStatus('Export failed: ' + e.message, 100);
    setTimeout(hideStatus, 4000);
    console.error('[LibraryCard]', e);
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
    var card = document.createElement('div');
    card.className = 'free-game-card' + (isClaimed ? ' is-claimed' : '');
    card.dataset.title = g.title;

    var platformBadge = g.platform ? '<span class="free-platform-badge">' + escHtml(g.platform) + '</span>' : '';
    var typeBadge = g.type ? '<span class="free-type-badge">' + escHtml(g.type) + '</span>' : '';
    var worth = g.worth && g.worth !== 'N/A' ? '<span class="free-worth">Was ' + escHtml(String(g.worth)) + '</span>' : '';
    var endText = g.endDate ? 'Until ' + new Date(g.endDate).toLocaleDateString('en-US', {month:'short',day:'numeric'}) : (g.status === 'Active' ? 'Active now' : '');

    card.innerHTML =
      '<div class="free-card-img">' +
        (g.imageUrl ? '<img src="' + escHtml(g.imageUrl) + '" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.style.background=\'var(--surface3)\';this.remove()">' : '') +
        (isClaimed ? '<div class="free-claimed-badge">CLAIMED ✓</div>' : '') +
        '<div class="free-card-badges">' + platformBadge + typeBadge + '</div>' +
      '</div>' +
      '<div class="free-card-body">' +
        '<div class="free-card-title' + (isClaimed ? ' is-claimed' : '') + '">' + escHtml(g.title) + '</div>' +
        (g.description ? '<div class="free-card-desc">' + escHtml(g.description.slice(0,100) + (g.description.length > 100 ? '…' : '')) + '</div>' : '') +
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

  // Build tab UI
  el.innerHTML =
    '<div class="free-tabs">' +
      '<button class="free-tab active" data-tab="epic">🟡 Epic Free Games</button>' +
      '<button class="free-tab" data-tab="steam">🔵 PC Giveaways</button>' +
      '<button class="free-tab" data-tab="loot">🏆 Free Loot</button>' +
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
  var backlog = games.filter(function(g) { return g.status === 'unplayed' || (!g.status && !g.playtimeHours); });
  if (!backlog.length) return '';

  // Average session length from history
  var avgSessionSecs = allSessions.length
    ? allSessions.reduce(function(t,s) { return t + s.seconds; }, 0) / allSessions.length
    : 2 * 3600; // default 2h if no history

  // Sessions per week from last 4 weeks
  var fourWeeksAgo = Date.now() - 28 * 24 * 60 * 60 * 1000;
  var recentSessions = allSessions.filter(function(s) { return s.date.getTime() > fourWeeksAgo; });
  var sessionsPerWeek = recentSessions.length / 4 || 1;

  // Estimate hours to clear backlog (rough: 15h avg per game)
  var avgHrsPerGame   = 15;
  var totalBacklogHrs = backlog.length * avgHrsPerGame;
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
      statMini(backlog.length, 'In Backlog', '#fb923c') +
      statMini('~' + Math.round(totalBacklogHrs) + 'h', 'Est. Total', '#fb923c') +
      statMini(weeksToFinish ? (weeksToFinish > 104 ? yearsToFinish + ' yrs' : weeksToFinish + ' wks') : '?', 'At Your Pace', '#f87171') +
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
      '</div>' +
    '</div>' +

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
        '<button style="font-size:11px;padding:5px 12px;background:rgba(248,113,113,0.15);border:1px solid rgba(248,113,113,0.4);border-radius:6px;color:#f87171;cursor:pointer;flex-shrink:0">Merge & Delete</button>';
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
  renderAll();
  showStatus('✓ "' + ctxGame.title + '" → ' + status, 100);
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
    '<div style="text-align:center;padding:32px 16px">' +
      '<div style="font-size:28px;margin-bottom:16px">🎲</div>' +
      '<div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:12px">Rolling the dice…</div>' +
      '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">' +
        '<span style="font-size:11px;padding:4px 10px;background:var(--surface3);border:1px solid var(--border);border-radius:6px;color:var(--text2)">' + energyLabels[chosenEnergy] + '</span>' +
        '<span style="font-size:11px;padding:4px 10px;background:var(--surface3);border:1px solid var(--border);border-radius:6px;color:var(--text2)">⏱ ' + timeLabels[chosenTime] + '</span>' +
        '<span style="font-size:11px;padding:4px 10px;background:var(--surface3);border:1px solid var(--border);border-radius:6px;color:var(--text2)">' + modeLabels[chosenMode] + '</span>' +
      '</div>' +
    '</div>';

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
    showStatus('⚠ Add IGDB credentials in Settings first', 100, {type:'error'});
    return;
  }
  if (forceAll) {
    // Clear cover cache so everything gets re-fetched
    coverCache = {};
    await window.nexus.covers.saveCache({});
    showStatus('Re-fetching all cover art from scratch…', 0);
  } else {
    showStatus('Fetching missing cover art…', 0);
  }
  await fetchCoversInBackground();
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

async function executeFullReset() {
  try {
    showStatus('Wiping all data…', -1);
    await window.nexus.app.fullReset();
    // Wipe cover cache file too
    await window.nexus.covers.saveCache({});

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
    title: 'Welcome to Nexus Library',
    subtitle: 'Your unified game library across all platforms',
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
          '<div style="font-size:11px;color:var(--text3);margin-top:5px">Find it at <a href="https://store.steampowered.com/account/" class="settings-link">store.steampowered.com/account</a></div>' +
        '</div>' +
        '<div class="onboard-field-group">' +
          '<div class="onboard-field-label">Steam API Key</div>' +
          '<div class="onboard-field-row">' +
            '<input class="settings-input" id="ob-steamKey" placeholder="Your Steam API key" style="flex:1">' +
            '<button class="settings-btn" onclick="obConnectSteam()">Connect</button>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--text3);margin-top:5px">Get a free key at <a href="https://steamcommunity.com/dev/apikey" class="settings-link">steamcommunity.com/dev/apikey</a></div>' +
        '</div>' +
        '<div id="ob-steamStatus"></div>' +
        '<span class="onboard-skip-link" onclick="obNext()">Skip Steam for now →</span>' +
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
          '1. Go to <a href="https://dev.twitch.tv/console" class="settings-link">dev.twitch.tv/console</a><br>' +
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
    title: 'Epic & Amazon Games',
    subtitle: 'Import via Heroic Games Launcher',
    render: function() {
      return '<div class=\"onboard-platform-card\">' +
        '<h3>🟡 Epic &nbsp;&amp;&nbsp; 🟠 Amazon Games</h3>' +
        '<div class=\"onboard-field-desc\">Nexus imports your Epic and Amazon libraries through <strong style=\"color:var(--text)\">Heroic Games Launcher</strong> — a free, open-source app that manages both platforms on Mac, Windows, and Linux.</div>' +
        '<div style=\"background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:12px;color:var(--text2);line-height:1.8\">' +
          '<strong style=\"color:var(--text)\">To enable Epic &amp; Amazon import:</strong><br>' +
          '1. Download &amp; install <a href=\"https://heroicgameslauncher.com\" class=\"settings-link\" target=\"_blank\">Heroic Games Launcher</a><br>' +
          '2. Log into your Epic Games account in Heroic<br>' +
          '3. Log into your Amazon Games account in Heroic<br>' +
          '4. Let both libraries sync at least once<br>' +
          '5. Then use <strong style=\"color:var(--text)\">Settings → Import Epic via Heroic</strong>' +
        '</div>' +
        '<div style=\"background:rgba(99,179,237,0.07);border:1px solid rgba(99,179,237,0.2);border-radius:8px;padding:10px 14px;font-size:11px;color:var(--text3);line-height:1.7\">' +
          '💡 No API keys needed — Nexus reads Heroic\'s local library files directly.<br>' +
          'GOG is also supported the same way via Heroic, or directly from the GOG Galaxy database.' +
        '</div>' +
        '<span class=\"onboard-skip-link\" onclick=\"obNext()\">Skip — I\'ll set this up later in Settings →</span>' +
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
          '1. Go to <a href="https://xbl.io" class="settings-link">xbl.io</a> and create a free account<br>' +
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
    title: 'Optional: More Integrations',
    subtitle: 'These are all free and optional',
    render: function() {
      return '<div style="display:flex;flex-direction:column;gap:12px">' +
        '<div class="onboard-platform-card" style="border-color:rgba(91,163,245,0.15)">' +
          '<h3 style="margin-bottom:4px">💰 Price Tracking — gg.deals</h3>' +
          '<div style="font-size:12px;color:var(--text3);margin-bottom:10px">Track game prices across 40+ stores. Free API key at <a href="https://gg.deals/api/" class="settings-link">gg.deals/api</a>.</div>' +
          '<div class="onboard-field-row">' +
            '<input class="settings-input" id="ob-ggKey" placeholder="gg.deals API Key (optional)" style="flex:1">' +
            '<button class="settings-btn" onclick="obSaveGGDeals()">Save</button>' +
          '</div>' +
          '<div id="ob-ggStatus"></div>' +
        '</div>' +
        '<div class="onboard-platform-card" style="border-color:rgba(91,163,245,0.15)">' +
          '<h3 style="margin-bottom:4px">🎮 Game Database — RAWG</h3>' +
          '<div style="font-size:12px;color:var(--text3);margin-bottom:10px">Enriches non-Steam games with descriptions & Metacritic scores. Free key at <a href="https://rawg.io/apiv2" class="settings-link">rawg.io/apiv2</a>.</div>' +
          '<div class="onboard-field-row">' +
            '<input class="settings-input" id="ob-rawgKey" placeholder="RAWG API Key (optional)" style="flex:1">' +
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
          'Enjoy your library!' +
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
  window.nexus.store.set('onboardingComplete', true);
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

    // 6. Not for me decay penalty
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
  if (titleEl) titleEl.textContent = pickerReplayMode ? '↩ Play Again' : '✦ Help Me Decide';

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
  if (titleEl) titleEl.textContent = pickerReplayMode ? '↩ Play Again' : '✦ Help Me Decide';

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

