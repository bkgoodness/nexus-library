const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const Store = require('electron-store');

const store      = new Store({ name: 'nexus-library' });
const coverStore = new Store({ name: 'nexus-covers' }); // separate file to avoid bloating main store

// ── STEAM APP LIST CACHE ──
// Stored as a flat JSON file in userData — persists between sessions.
// Format: { fetchedAt: ISO string, apps: { "appid": "name", ... } }
let steamAppCache = null; // in-memory after first load

function steamCachePath() {
  return path.join(app.getPath('userData'), 'steam-app-list.json');
}

function loadSteamCacheFromDisk() {
  if (steamAppCache) return steamAppCache;
  try {
    const raw = fs.readFileSync(steamCachePath(), 'utf8');
    steamAppCache = JSON.parse(raw);
    console.log('[steamCache] Loaded', Object.keys(steamAppCache.apps).length, 'apps from disk');
  } catch(e) {
    steamAppCache = null;
  }
  return steamAppCache;
}

async function fetchAndCacheSteamAppList(win) {
  const zlib = require('zlib');
  console.log('[steamCache] Fetching full Steam app list via IStoreService...');

  const apiKey = store.get('steamApiKey');
  if (!apiKey) throw new Error('No Steam API key saved. Import your Steam library in Settings first — Nexus will reuse that key.');

  const sendProgress = (msg) => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('steam:appListProgress', msg); } catch(e) {}
    }
  };

  // IStoreService/GetAppList is paginated — keep fetching until have_more_results is false
  const apps = {};
  let lastAppId = 0;
  let page = 0;
  let totalFetched = 0;
  const PAGE_SIZE = 50000;

  sendProgress({ stage: 'downloading', pct: 0, mb: '0.0' });

  while (true) {
    const url = 'https://api.steampowered.com/IStoreService/GetAppList/v1/' +
      '?key=' + apiKey +
      '&include_games=1&include_dlc=0&include_software=0&include_videos=0&include_hardware=0' +
      '&max_results=' + PAGE_SIZE +
      (lastAppId > 0 ? '&last_appid=' + lastAppId : '');

    const buf = await new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { 'Accept-Encoding': 'gzip, deflate' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          res.resume();
          // Simple single-level redirect follow
          https.get(res.headers.location, (res2) => {
            collectResponse(res2, resolve, reject);
          }).on('error', reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('Steam API returned HTTP ' + res.statusCode + ' — check that your Steam API key is valid'));
        }
        collectResponse(res, resolve, reject);
      });
      req.on('error', (e) => reject(new Error('Network error: ' + e.message)));
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timed out')); });
    });

    const data = JSON.parse(buf.toString('utf8'));
    const response = data && data.response;
    if (!response || !response.apps) {
      if (page === 0) throw new Error('Unexpected response from IStoreService/GetAppList — check your Steam API key');
      break;
    }

    for (const a of response.apps) {
      if (a.name && a.name.trim()) apps[String(a.appid)] = a.name;
    }
    totalFetched += response.apps.length;
    page++;

    const pct = Math.min(80, Math.floor((totalFetched / 60000) * 80));
    sendProgress({ stage: 'downloading', pct, mb: (totalFetched / 1000).toFixed(0) + 'k games' });
    console.log('[steamCache] Page', page, '— fetched', totalFetched, 'apps so far');

    if (!response.have_more_results) break;
    lastAppId = response.last_appid;
    // Small delay to be polite to Steam's servers
    await new Promise(r => setTimeout(r, 200));
  }

  sendProgress({ stage: 'indexing', pct: 90 });
  const nameLower = {};
  for (const [appid, name] of Object.entries(apps)) {
    nameLower[name.toLowerCase()] = appid;
  }

  sendProgress({ stage: 'saving', pct: 97 });
  const count = Object.keys(apps).length;
  steamAppCache = { fetchedAt: new Date().toISOString(), apps, nameLower };
  fs.writeFileSync(steamCachePath(), JSON.stringify(steamAppCache), 'utf8');

  console.log('[steamCache] Cached', count, 'apps total');
  sendProgress({ stage: 'done', pct: 100, count });
  return steamAppCache;
}

// Helper: collect + decompress an https response into a Buffer
function collectResponse(res, resolve, reject) {
  const zlib = require('zlib');
  const encoding = (res.headers['content-encoding'] || '').toLowerCase();
  let stream;
  if (encoding.includes('gzip'))    stream = res.pipe(zlib.createGunzip());
  else if (encoding.includes('deflate')) stream = res.pipe(zlib.createInflate());
  else stream = res;
  const chunks = [];
  stream.on('data', c => chunks.push(c));
  stream.on('end',  () => resolve(Buffer.concat(chunks)));
  stream.on('error', e => reject(new Error('Stream error: ' + e.message)));
}

function isCacheStale() {
  const c = loadSteamCacheFromDisk();
  if (!c) return true;
  const age = Date.now() - new Date(c.fetchedAt).getTime();
  return age > 7 * 24 * 60 * 60 * 1000; // 7 days
}

// Search steam app list by partial name — returns top matches [{appid, name}]
function searchSteamApps(query, limit = 10) {
  const c = loadSteamCacheFromDisk();
  if (!c) return [];
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const results = [];
  // Exact prefix match first, then contains
  const exact = [];
  const contains = [];

  for (const [appid, name] of Object.entries(c.apps)) {
    const nl = name.toLowerCase();
    if (nl === q) { exact.unshift({ appid, name }); }
    else if (nl.startsWith(q)) { exact.push({ appid, name }); }
    else if (nl.includes(q)) { contains.push({ appid, name }); }
    if (exact.length >= limit) break;
  }

  return [...exact, ...contains].slice(0, limit);
}

ipcMain.handle('steam:searchApps', async (_event, query) => {
  // If cache is missing or stale, fetch in background (don't block the search UI)
  if (isCacheStale()) {
    fetchAndCacheSteamAppList().catch(e => console.error('[steamCache] fetch error:', e.message));
    // If we have a stale cache, still use it for now
    if (!loadSteamCacheFromDisk()) return { results: [], cacheReady: false };
  }
  return { results: searchSteamApps(query), cacheReady: true };
});

ipcMain.handle('steam:refreshAppList', async (_event) => {
  const win = BrowserWindow.getAllWindows()[0];
  const result = await fetchAndCacheSteamAppList(win);
  return { count: Object.keys(result.apps).length, fetchedAt: result.fetchedAt };
});

ipcMain.handle('steam:getCacheStatus', () => {
  const c = loadSteamCacheFromDisk();
  if (!c) return { ready: false };
  return {
    ready: true,
    count: Object.keys(c.apps).length,
    fetchedAt: c.fetchedAt,
    stale: isCacheStale(),
  };
});

function seedIfEmpty() {
  if (!store.has('games')) {
    store.set('games', [
      { id:1,  title:"Cyberpunk 2077",          genre:"RPG",       platforms:["steam","gog"],       pal:0 },
      { id:2,  title:"The Witcher 3",            genre:"RPG",       platforms:["steam","gog","epic"],pal:1 },
      { id:3,  title:"Doom Eternal",             genre:"FPS",       platforms:["steam","epic"],      pal:2 },
      { id:4,  title:"Hades",                    genre:"Action",    platforms:["steam","epic"],      pal:3 },
      { id:5,  title:"Death Stranding",          genre:"Adventure", platforms:["steam"],             pal:4 },
      { id:6,  title:"Disco Elysium",            genre:"RPG",       platforms:["gog"],               pal:5 },
      { id:7,  title:"Control",                  genre:"Action",    platforms:["epic"],              pal:6 },
      { id:8,  title:"Alan Wake 2",              genre:"Horror",    platforms:["epic"],              pal:7 },
      { id:9,  title:"Red Dead Redemption 2",    genre:"Action",    platforms:["steam","epic"],      pal:8 },
      { id:10, title:"Baldur's Gate 3",          genre:"RPG",       platforms:["steam","gog"],       pal:9 },
      { id:11, title:"Half-Life: Alyx",          genre:"FPS",       platforms:["steam"],             pal:0 },
      { id:12, title:"Divinity: Original Sin 2", genre:"RPG",       platforms:["gog","epic"],        pal:1 },
      { id:13, title:"Metro Exodus",             genre:"FPS",       platforms:["steam","epic"],      pal:2 },
      { id:14, title:"A Plague Tale",            genre:"Adventure", platforms:["epic","gog"],        pal:3 },
      { id:15, title:"Celeste",                  genre:"Puzzle",    platforms:["steam"],             pal:4 },
    ]);
    store.set('nextId', 16);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#09090d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });
  win.loadFile('src/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  seedIfEmpty();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Warm the Steam app list cache in the background on startup if stale
  if (isCacheStale()) {
    setTimeout(() => {
      const win = BrowserWindow.getAllWindows()[0];
      fetchAndCacheSteamAppList(win).catch(e => console.error('[startup] Steam app list fetch failed:', e.message));
    }, 3000); // Wait 3s for window to fully load before streaming
  }

  // Check wishlist prices every 3 hours in the background
  const THREE_HOURS = 3 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) await ipcMain.emit('prices:checkWishlistAndNotify', { sender: win.webContents });
    } catch(e) { console.error('Background price check error:', e.message); }
  }, THREE_HOURS);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// HTTPS helper — runs in main process, no CORS restrictions
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept-Encoding': 'gzip, deflate' } }, (res) => {
      const zlib = require('zlib');
      const encoding = (res.headers['content-encoding'] || '').toLowerCase();
      let stream;
      if (encoding.includes('gzip'))         stream = res.pipe(zlib.createGunzip());
      else if (encoding.includes('deflate')) stream = res.pipe(zlib.createInflate());
      else                                   stream = res;

      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          // Try to include API error message if JSON
          let msg = 'HTTP ' + res.statusCode;
          try {
            const j = JSON.parse(raw);
            // Handle nested formats like gg.deals: {success:false, data:{message:"..."}}
            const apiMsg = j.message || j.error || (j.data && j.data.message) || (j.data && j.data.name) || JSON.stringify(j).slice(0, 120);
            msg += ': ' + apiMsg;
          } catch(e) { msg += ': ' + raw.slice(0, 120); }
          return reject(new Error(msg));
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Could not parse response as JSON (' + raw.slice(0, 80) + ')')); }
      });
      stream.on('error', e => reject(new Error('Stream error: ' + e.message)));
    }).on('error', (e) => reject(new Error('Network error: ' + e.message)));
  });
}

// ── IPC HANDLERS ──

ipcMain.handle('games:getAll', () => store.get('games', []));

ipcMain.handle('games:add', (_event, game) => {
  const games = store.get('games', []);
  const nextId = store.get('nextId', 1);
  const existingIndex = games.findIndex(g =>
    g.title.toLowerCase() === game.title.toLowerCase()
  );
  if (existingIndex !== -1) {
    game.platforms.forEach(p => {
      if (!games[existingIndex].platforms.includes(p))
        games[existingIndex].platforms.push(p);
    });
    store.set('games', games);
    return { merged: true, game: games[existingIndex] };
  } else {
    const newGame = { ...game, id: nextId, pal: nextId % 10 };
    games.push(newGame);
    store.set('games', games);
    store.set('nextId', nextId + 1);
    return { merged: false, game: newGame };
  }
});

ipcMain.handle('games:delete', (_event, id) => {
  store.set('games', store.get('games', []).filter(g => g.id !== id));
  return true;
});

ipcMain.handle('games:updatePlatforms', (_event, { id, platforms }) => {
  const games = store.get('games', []);
  const idx = games.findIndex(g => g.id === id);
  if (idx !== -1) { games[idx].platforms = platforms; store.set('games', games); return games[idx]; }
  return null;
});

// Update arbitrary fields on a single game (notes, tags, status, genre, etc.)
ipcMain.handle('games:update', (_event, { id, fields }) => {
  const games = store.get('games', []);
  const idx = games.findIndex(g => g.id === id);
  if (idx !== -1) {
    Object.assign(games[idx], fields);
    store.set('games', games);
    return games[idx];
  }
  return null;
});

// Bulk update genre for multiple games at once (genre editor)
ipcMain.handle('games:bulkSetGenre', (_event, { ids, genre }) => {
  const games = store.get('games', []);
  ids.forEach(id => {
    const idx = games.findIndex(g => g.id === id);
    if (idx !== -1) games[idx].genre = genre;
  });
  store.set('games', games);
  return true;
});

// Fetch genre from Steam Store API for games with genre 'Other'
ipcMain.handle('games:fetchSteamGenres', async (_event, steamAppIds) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const results = {};
  for (const appId of steamAppIds) {
    try {
      // Step 1: Steam appdetails for genres (reliable)
      const storeUrl = 'https://store.steampowered.com/api/appdetails?appids=' + appId + '&filters=genres';
      const storeData = await httpsGet(storeUrl);
      const entry = storeData && storeData[String(appId)];
      const genres = (entry && entry.success && entry.data && entry.data.genres || [])
        .map(g => g.description).filter(Boolean);

      // Step 2: SteamSpy for real community tags (FPS, Atmospheric, Roguelike, etc.)
      // Returns { tagName: voteCount } — sort by votes, take top 12
      let tags = [];
      try {
        const spyUrl = 'https://steamspy.com/api.php?request=appdetails&appid=' + appId;
        const spyData = await httpsGet(spyUrl);
        if (spyData && spyData.tags && typeof spyData.tags === 'object') {
          tags = Object.entries(spyData.tags)
            .sort((a, b) => b[1] - a[1])   // sort by vote count descending
            .slice(0, 12)
            .map(([name]) => name.toLowerCase())
            .filter(Boolean);
        }
      } catch(e) {
        console.warn('[SteamSpy] Failed for appId', appId, ':', e.message);
      }

      results[appId] = { genres, tags };
    } catch(e) {
      // skip silently
    }
    await sleep(1000); // SteamSpy rate limit: ~1 req/sec
  }
  return results;
});

ipcMain.handle('store:get', (_event, key) => store.get(key));
ipcMain.handle('store:set', (_event, key, value) => { store.set(key, value); return true; });

// Bulk read all keys matching a prefix — used for fast session loading
ipcMain.handle('store:getByPrefix', (_event, prefix) => {
  const data = store.store; // electron-store exposes the whole object
  const result = {};
  Object.keys(data).forEach(k => { if (k.startsWith(prefix)) result[k] = data[k]; });
  return result;
});

// ── STEAM PRESENCE (what game is playing right now) ──
ipcMain.handle('steam:getPresence', async () => {
  const steamId = store.get('steamId');
  const apiKey  = store.get('steamApiKey');
  if (!steamId || !apiKey) return { error: 'no_credentials' };
  try {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${steamId}`;
    const data = await new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'NexusLibrary/1.0' } }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch(e) { reject(e); }
        });
      }).on('error', reject);
    });
    const player = data?.response?.players?.[0];
    if (!player) return { error: 'no_player' };
    return {
      gameId:    player.gameid    || null,
      gameName:  player.gameextrainfo || null,
      personaState: player.personastate, // 0=offline,1=online,2=busy,3=away
    };
  } catch(e) {
    return { error: e.message };
  }
});

// ── STEAM RECENTLY PLAYED (playtime delta detection) ──
ipcMain.handle('steam:getRecentlyPlayed', async () => {
  const steamId = store.get('steamId');
  const apiKey  = store.get('steamApiKey');
  if (!steamId || !apiKey) return { error: 'no_credentials' };
  try {
    const url = `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v0001/?key=${apiKey}&steamid=${steamId}&count=20&format=json`;
    const data = await new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'NexusLibrary/1.0' } }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch(e) { reject(e); }
        });
      }).on('error', reject);
    });
    return data?.response?.games || [];
  } catch(e) {
    return { error: e.message };
  }
});

// ── STEAM API ──
ipcMain.handle('steam:importLibrary', async (_event, { steamId, apiKey }) => {
  if (!steamId || !apiKey)
    throw new Error('Steam ID and API Key are both required.');

  if (!/^\d{17}$/.test(steamId.trim()))
    throw new Error('Steam ID must be a 17-digit number (e.g. 76561198012345678).\nFind it at: Steam → account name → Account Details.');

  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey.trim()}&steamid=${steamId.trim()}&include_appinfo=true&include_played_free_games=1&format=json`;

  let data;
  try {
    data = await httpsGet(url);
  } catch (e) {
    throw new Error(`Could not reach Steam. Check your internet connection.\n(${e.message})`);
  }

  if (!data.response || Object.keys(data.response).length === 0) {
    throw new Error(
      'Steam returned an empty response. This means either:\n\n' +
      '• Your API Key is incorrect — double-check at steamcommunity.com/dev/apikey\n' +
      '• Your game list is set to Private\n\n' +
      'To fix privacy: Steam app → username (top right) → Privacy Settings → Game Details → set to Public.'
    );
  }

  const steamGames = data.response.games || [];
  if (steamGames.length === 0)
    throw new Error('No games found on this Steam account.');

  // Save credentials for future re-syncs
  store.set('steamId', steamId.trim());
  store.set('steamApiKey', apiKey.trim());
  store.set('steamLastSync', new Date().toISOString());

  const games = store.get('games', []);
  let nextId = store.get('nextId', 1);
  let added = 0, merged = 0;

  for (const sg of steamGames) {
    if (!sg.name) continue;
    const existingIndex = games.findIndex(g =>
      g.title.toLowerCase() === sg.name.toLowerCase()
    );
    if (existingIndex !== -1) {
      if (!games[existingIndex].platforms.includes('steam'))
        games[existingIndex].platforms.push('steam');
      // Always refresh playtime and steamAppId so resync keeps data current
      games[existingIndex].steamAppId    = sg.appid;
      games[existingIndex].playtimeHours = Math.round((sg.playtime_forever || 0) / 60);
      if (!games[existingIndex].addedAt)
        games[existingIndex].addedAt = new Date().toISOString();
      merged++;
    } else {
      games.push({
        id: nextId++,
        title: sg.name,
        genre: 'Other',
        platforms: ['steam'],
        pal: nextId % 10,
        steamAppId: sg.appid,
        playtimeHours: Math.round((sg.playtime_forever || 0) / 60),
        addedAt: new Date().toISOString(),
      });
      added++;
    }
  }

  store.set('games', games);
  store.set('nextId', nextId);

  return {
    total: steamGames.length,
    added,
    merged,
    lastSync: store.get('steamLastSync'),
  };
});

// Re-sync with saved credentials
ipcMain.handle('steam:resync', async () => {
  const steamId = store.get('steamId');
  const apiKey  = store.get('steamApiKey');
  if (!steamId || !apiKey)
    throw new Error('No Steam credentials saved. Please connect Steam first in Settings.');
  
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${steamId}&include_appinfo=true&include_played_free_games=1&format=json`;
  const data = await httpsGet(url);
  if (!data.response || !data.response.games) throw new Error('Steam sync failed. Check your credentials in Settings.');
  
  const steamGames = data.response.games;
  const games = store.get('games', []);
  let nextId = store.get('nextId', 1);
  let added = 0, merged = 0;

  for (const sg of steamGames) {
    if (!sg.name) continue;
    const idx = games.findIndex(g => g.title.toLowerCase() === sg.name.toLowerCase());
    if (idx !== -1) {
      if (!games[idx].platforms.includes('steam')) games[idx].platforms.push('steam');
      games[idx].steamAppId    = sg.appid;
      games[idx].playtimeHours = Math.round((sg.playtime_forever || 0) / 60);
      if (!games[idx].addedAt) games[idx].addedAt = new Date().toISOString();
      merged++;
    } else {
      games.push({ id: nextId++, title: sg.name, genre: 'Other', platforms: ['steam'], pal: nextId % 10, steamAppId: sg.appid, playtimeHours: Math.round((sg.playtime_forever || 0) / 60), addedAt: new Date().toISOString() });
      added++;
    }
  }

  store.set('games', games);
  store.set('nextId', nextId);
  store.set('steamLastSync', new Date().toISOString());

  return { total: steamGames.length, added, merged, lastSync: store.get('steamLastSync') };
});

// ── GOG DIRECT DATABASE IMPORT ──
ipcMain.handle('gog:importFromDB', async () => {
  const os = require('os');
  const fs = require('fs');

  // GOG Galaxy 2.0 database locations per platform
  const dbPaths = {
    darwin: '/Users/Shared/GOG.com/Galaxy/Storage/galaxy-2.0.db',
    win32:  'C:\\ProgramData\\GOG.com\\Galaxy\\storage\\galaxy-2.0.db',
    linux:  path.join(os.homedir(), '.config/GOG.com/Galaxy/storage/galaxy-2.0.db'),
  };

  const dbPath = dbPaths[process.platform];
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error(
      'GOG Galaxy database not found.\n\n' +
      'Make sure GOG Galaxy is installed and you have logged in at least once.\n\n' +
      'Expected location: ' + (dbPath || 'Unknown platform')
    );
  }

  // Use better-sqlite3 if available, otherwise fall back to reading via child_process sqlite3
  let sqlite3;
  try {
    sqlite3 = require('better-sqlite3');
  } catch(e) {
    // Fallback: copy DB and use node's built-in
    throw new Error(
      'SQLite module not installed.\n\n' +
      'Run this in your terminal from the nexus-library folder:\n\n' +
      '  npm install better-sqlite3\n\n' +
      'Then restart the app and try again.'
    );
  }

  // Open in read-only mode so we never modify GOG's database
  const db = sqlite3(dbPath, { readonly: true });

  try {
    // Query owned GOG games — joins purchase dates with game piece metadata
    const rows = db.prepare(`
      SELECT DISTINCT
        gp_title.value AS title,
        gp_genre.value AS genres
      FROM ProductPurchaseDates ppd
      LEFT JOIN GamePieces gp_title
        ON ppd.gameReleaseKey = gp_title.releaseKey
        AND gp_title.gamePieceTypeId = (SELECT id FROM GamePieceTypes WHERE type = 'title' LIMIT 1)
      LEFT JOIN GamePieces gp_genre
        ON ppd.gameReleaseKey = gp_genre.releaseKey
        AND gp_genre.gamePieceTypeId = (SELECT id FROM GamePieceTypes WHERE type = 'genre' LIMIT 1)
      WHERE ppd.gameReleaseKey LIKE 'gog_%'
        AND gp_title.value IS NOT NULL
    `).all();

    if (!rows.length) {
      throw new Error('No GOG games found in the database. Make sure you are logged into GOG Galaxy and your library has synced.');
    }

    const games = store.get('games', []);
    let nextId = store.get('nextId', 1);
    let added = 0, merged = 0;

    for (const row of rows) {
      // GOG stores title as JSON string: {"*": "Game Title"}
      let title = row.title;
      try {
        const parsed = JSON.parse(row.title);
        title = parsed['*'] || parsed[Object.keys(parsed)[0]] || row.title;
      } catch(e) { /* use raw value */ }

      // Parse genre similarly
      let genre = 'Other';
      if (row.genres) {
        try {
          const parsed = JSON.parse(row.genres);
          const genreList = parsed['*'] || parsed[Object.keys(parsed)[0]];
          if (Array.isArray(genreList) && genreList.length) genre = genreList[0];
          else if (typeof genreList === 'string') genre = genreList;
        } catch(e) { /* keep Other */ }
      }

      if (!title || title.trim() === '') continue;

      const existingIndex = games.findIndex(g =>
        g.title.toLowerCase() === title.toLowerCase()
      );
      if (existingIndex !== -1) {
        if (!games[existingIndex].platforms.includes('gog'))
          games[existingIndex].platforms.push('gog');
        merged++;
      } else {
        games.push({ id: nextId++, title: title.trim(), genre, platforms: ['gog'], pal: nextId % 10, addedAt: new Date().toISOString() });
        added++;
      }
    }

    store.set('games', games);
    store.set('nextId', nextId);
    store.set('gogLastSync', new Date().toISOString());

    return { total: rows.length, added, merged, lastSync: store.get('gogLastSync') };

  } finally {
    db.close();
  }
});

// ── EPIC CSV IMPORT (via main process for file path access) ──
ipcMain.handle('epic:importFromCSV', async (_event, csvText) => {
  if (!csvText || !csvText.trim()) throw new Error('CSV file appears to be empty.');

  const lines = csvText.trim().split('\n');
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one game.');

  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
  const titleIdx = headers.findIndex(h => h.includes('title') || h.includes('name') || h.includes('game'));
  const genreIdx = headers.findIndex(h => h.includes('genre') || h.includes('category'));

  if (titleIdx === -1) throw new Error('Could not find a title/name column. Make sure your CSV has a "Title" or "Name" column header.');

  function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQuotes = !inQuotes; }
      else if (line[i] === ',' && !inQuotes) { result.push(current); current = ''; }
      else { current += line[i]; }
    }
    result.push(current);
    return result;
  }

  const games = store.get('games', []);
  let nextId = store.get('nextId', 1);
  let added = 0, merged = 0;

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);
    const title = cols[titleIdx] ? cols[titleIdx].replace(/"/g, '').trim() : '';
    const genre = (genreIdx !== -1 && cols[genreIdx]) ? cols[genreIdx].replace(/"/g, '').trim() : 'Other';
    if (!title) continue;

    const existingIndex = games.findIndex(g => g.title.toLowerCase() === title.toLowerCase());
    if (existingIndex !== -1) {
      if (!games[existingIndex].platforms.includes('epic'))
        games[existingIndex].platforms.push('epic');
      merged++;
    } else {
      games.push({ id: nextId++, title, genre: genre || 'Other', platforms: ['epic'], pal: nextId % 10, addedAt: new Date().toISOString() });
      added++;
    }
  }

  store.set('games', games);
  store.set('nextId', nextId);
  store.set('epicLastSync', new Date().toISOString());

  return { total: added + merged, added, merged, lastSync: store.get('epicLastSync') };
});

// ── COVER ART ──

// Persist cover URLs to disk so restarts don't re-fetch everything
// Uses a separate store file (nexus-covers.json) to keep main store lean
ipcMain.handle('covers:saveCache', (_event, cache) => {
  try {
    coverStore.set('cache', cache);
  } catch(e) {
    console.warn('Cover cache save failed:', e.message);
  }
  return true;
});
ipcMain.handle('covers:loadCache', () => {
  try {
    return coverStore.get('cache', {});
  } catch(e) {
    console.warn('Cover cache load failed:', e.message);
    return {};
  }
});
// Steam cover art via CDN (no API key needed, uses stored steamAppId)
// IGDB cover art via Twitch API (for GOG, Epic, and manually added games)

// Cache IGDB token in memory to avoid re-fetching on every request
let igdbTokenCache = null;

async function getIGDBToken(clientId, clientSecret) {
  // Return cached token if still valid
  if (igdbTokenCache && igdbTokenCache.expires > Date.now()) {
    return igdbTokenCache.token;
  }
  const url = `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`;
  const data = await httpsPost(url, '');
  if (!data.access_token) throw new Error('Failed to get IGDB token. Check your Client ID and Client Secret.');
  // Cache token with 10 minute buffer before expiry
  igdbTokenCache = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in - 600) * 1000,
  };
  return igdbTokenCache.token;
}

function httpsPost(url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const zlib = require('zlib');
    const urlObj = new URL(url);
    const bodyBuf = Buffer.from(body);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: Object.assign({
        'Content-Length': bodyBuf.length,
        'Accept-Encoding': 'gzip, deflate',
      }, extraHeaders || { 'Content-Type': 'application/json' }),
    };
    const req = https.request(options, (res) => {
      const encoding = (res.headers['content-encoding'] || '').toLowerCase();
      let stream;
      if (encoding.includes('gzip'))         stream = res.pipe(zlib.createGunzip());
      else if (encoding.includes('deflate')) stream = res.pipe(zlib.createInflate());
      else                                   stream = res;

      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let msg = 'HTTP ' + res.statusCode;
          try { const j = JSON.parse(raw); msg += ': ' + (j.message || j.title || JSON.stringify(j).slice(0, 120)); } catch(e) {}
          return reject(new Error(msg));
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Invalid JSON from API (' + raw.slice(0, 80) + ')')); }
      });
      stream.on('error', e => reject(new Error('Stream error: ' + e.message)));
    });
    req.on('error', e => reject(new Error('Network error: ' + e.message)));
    req.write(bodyBuf);
    req.end();
  });
}

// Fetch cover art for a batch of games
ipcMain.handle('covers:fetchBatch', async (_event, { games, igdbClientId, igdbClientSecret }) => {
  const win = BrowserWindow.getAllWindows()[0] || null;
  const results = {};

  // Separate games by source
  const steamGames  = games.filter(g => g.steamAppId);
  const igdbGames   = games.filter(g => !g.steamAppId);

  // Steam covers - free CDN, no auth needed
  for (const g of steamGames) {
    results[g.id] = 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + g.steamAppId + '/library_600x900.jpg';
  }

  // Helper: clean a title for IGDB search (strips platform/edition noise)
  const cleanTitleForSearch = (title) => title
    .replace(/\s*[:\-–]\s*(Complete|Gold|GOTY|Definitive|Enhanced|Remaster(ed)?|Standard|Premium|Deluxe|Ultimate|Anniversary|Special|Legacy|Directors? Cut)\s+(Edition|Version|Cut)?\s*$/i, '')
    .replace(/\s*[:\-–]\s*(Complete|Gold|GOTY|Definitive|Enhanced|Remaster(ed)?|Standard|Premium|Deluxe|Ultimate|Anniversary|Special|Legacy|Directors? Cut)\s*$/i, '')
    .replace(/\s+(Edition|Version)\s*$/i, '')
    .replace(/^ARCADE GAME SERIES:\s*/i, '')
    .replace(/\s*\((PC|Windows|Mac|Steam|GOG|Epic|Amazon|Prime Gaming|Heroic)\)\s*$/i, '')
    .replace(/\s*\[(PC|Windows|Mac|Steam|GOG|Epic|Amazon|Prime Gaming)\]\s*$/i, '')
    .replace(/[\u2122\u00ae\u00a9]/g, '')
    .trim();

  // IGDB covers - needs credentials
  if (igdbGames.length > 0 && igdbClientId && igdbClientSecret) {
    try {
      const token = await getIGDBToken(igdbClientId, igdbClientSecret);

      const IGDB_HEADERS = {
        'Client-ID': igdbClientId,
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'text/plain',
      };

      const IGDB_GENRE_MAP = {
        'Point-and-click': 'Adventure', 'Fighting': 'Action', 'Shooter': 'FPS',
        'Music': 'Other', 'Platform': 'Action', 'Puzzle': 'Puzzle', 'Racing': 'Racing',
        'Real Time Strategy (RTS)': 'Strategy', 'Role-playing (RPG)': 'RPG',
        'Simulator': 'Simulation', 'Sport': 'Sports', 'Strategy': 'Strategy',
        'Turn-based strategy (TBS)': 'Strategy', 'Tactical': 'Strategy',
        "Hack and slash/Beat 'em up": 'Action', 'Quiz/Trivia': 'Other',
        'Pinball': 'Other', 'Adventure': 'Adventure', 'Arcade': 'Action',
        'Visual Novel': 'Adventure', 'Card & Board Game': 'Puzzle',
        'MOBA': 'Action', 'Horror': 'Horror', 'Indie': 'Other',
      };

      const allGames = store.get('games', []);
      let genresUpdated = false;

      const applyResult = (result, match) => {
        if (result.cover && result.cover.image_id) {
          results[match.id] = 'https://images.igdb.com/igdb/image/upload/t_cover_big/' + result.cover.image_id + '.jpg';
        }
        if (result.genres && result.genres.length) {
          const mappedGenre = IGDB_GENRE_MAP[result.genres[0].name] || result.genres[0].name;
          const gameIdx = allGames.findIndex(g => g.id === match.id);
          if (gameIdx !== -1 && (!allGames[gameIdx].genre || allGames[gameIdx].genre === 'Other')) {
            allGames[gameIdx].genre = mappedGenre;
            genresUpdated = true;
          }
        }
      };

      // Pass 1: Exact batch name match — use cleaned titles, match against both
      // original and cleaned versions
      const unmatched = [];
      const CHUNK = 500;
      for (let i = 0; i < igdbGames.length; i += CHUNK) {
        const chunk = igdbGames.slice(i, i + CHUNK);

        // Build a map of cleaned title -> original game for matching
        const cleanedMap = new Map(); // cleanedTitle.lower -> game
        const originalMap = new Map(); // originalTitle.lower -> game
        for (const g of chunk) {
          originalMap.set(g.title.toLowerCase(), g);
          const cleaned = cleanTitleForSearch(g.title);
          if (cleaned !== g.title) cleanedMap.set(cleaned.toLowerCase(), g);
        }

        // Build query using both original and cleaned titles (deduped)
        const allTitles = new Set([...chunk.map(g => g.title), ...chunk.map(g => cleanTitleForSearch(g.title))]);
        const titles = [...allTitles].map(t => '"' + t.replace(/"/g, '') + '"').join(',');
        const query = 'fields name,cover.image_id,genres.name; where name = (' + titles + '); limit ' + Math.min(allTitles.size, CHUNK) + ';';
        const igdbResults = await httpsPost('https://api.igdb.com/v4/games', query, IGDB_HEADERS);

        if (Array.isArray(igdbResults)) {
          const matchedGameIds = new Set();
          for (const result of igdbResults) {
            const rName = result.name.toLowerCase();
            // Try original title first, then cleaned
            const match = originalMap.get(rName) || cleanedMap.get(rName);
            if (match && !matchedGameIds.has(match.id)) {
              applyResult(result, match);
              matchedGameIds.add(match.id);
            }
          }
          for (const g of chunk) {
            if (!matchedGameIds.has(g.id) && !results[g.id]) unmatched.push(g);
          }
        }
      }

      // Pass 2: Fuzzy search for unmatched games — throttled to 4 req/sec (IGDB limit)
      // Also sends progress events so the UI can show a counter
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (let ui = 0; ui < unmatched.length; ui++) {
        const g = unmatched[ui];
        // Send progress to renderer
        if (win && !win.isDestroyed()) {
          try { win.webContents.send('covers:fuzzyProgress', { done: ui, total: unmatched.length, title: g.title }); } catch(e) {}
        }
        try {
          const searchTitle = cleanTitleForSearch(g.title);
          const searchQuery = 'search "' + searchTitle.replace(/"/g, '') + '"; fields name,cover.image_id,genres.name; limit 5;';
          const searchResults = await httpsPost('https://api.igdb.com/v4/games', searchQuery, IGDB_HEADERS);
          if (Array.isArray(searchResults) && searchResults.length) {
            const best = searchResults.find(r => r.cover) || searchResults[0];
            if (best) {
              console.log('[IGDB fuzzy]', g.title, '->', best.name);
              applyResult(best, g);
            }
          }
        } catch(e) {
          console.error('[IGDB fuzzy] failed for ' + g.title + ':', e.message);
          if (e.message && e.message.includes('429')) await sleep(2000); // back off on rate limit
        }
        await sleep(260); // ~3.8 req/sec — safely under 4/sec limit
      }
      // Done signal
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('covers:fuzzyProgress', { done: unmatched.length, total: unmatched.length, finished: true }); } catch(e) {}
      }
      if (genresUpdated) store.set('games', allGames);

    } catch (e) {
      console.error('IGDB fetch failed:', e.message);
    }
  }

  return results;
});

// Save IGDB credentials
ipcMain.handle('covers:saveIGDBCredentials', (_event, { clientId, clientSecret }) => {
  store.set('igdbClientId', clientId);
  store.set('igdbClientSecret', clientSecret);
  igdbTokenCache = null; // clear cached token so it refreshes with new credentials
  console.log('[Nexus] IGDB credentials saved — ID:', clientId ? clientId.slice(0,8) + '...' : 'empty');
  return true;
});

// Fetch single cover (used when adding a new game manually, or as CDN fallback)
ipcMain.handle('covers:fetchOne', async (_event, { game, igdbClientId, igdbClientSecret }) => {
  // Steam game with valid App ID — CDN. Caller sets steamAppId=null to force IGDB fallback.
  if (game.steamAppId) {
    return 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + game.steamAppId + '/library_600x900.jpg';
  }
  if (!igdbClientId || !igdbClientSecret) return null;
  try {
    const token = await getIGDBToken(igdbClientId, igdbClientSecret);
    const hdrs = { 'Client-ID': igdbClientId, 'Authorization': 'Bearer ' + token, 'Content-Type': 'text/plain' };
    const igdbUrl = id => 'https://images.igdb.com/igdb/image/upload/t_cover_big/' + id + '.jpg';

    // 1. Exact name match
    const eq = await httpsPost('https://api.igdb.com/v4/games',
      'fields name,cover.image_id; where name = "' + game.title.replace(/"/g,'') + '"; limit 1;', hdrs);
    if (Array.isArray(eq) && eq[0] && eq[0].cover) return igdbUrl(eq[0].cover.image_id);

    // 2. Strip known prefixes/suffixes, then search
    const clean = game.title
      .replace(/^ARCADE GAME SERIES:\s*/i, '')
      .replace(/\s*[-]\s*(Complete|Gold|GOTY|Definitive|Enhanced|Remastered?|Edition)\s*$/i, '')
      .replace(/[\u2122\u00ae\u00a9]/g, '')
      .trim();
    const sq = await httpsPost('https://api.igdb.com/v4/games',
      'search "' + clean.replace(/"/g,'') + '"; fields name,cover.image_id; limit 5;', hdrs);
    if (Array.isArray(sq) && sq.length) {
      const best = sq.find(r => r.cover) || sq[0];
      if (best && best.cover) return igdbUrl(best.cover.image_id);
    }
  } catch (e) {
    console.error('IGDB single fetch failed:', e.message);
  }
  return null;
});

// Search IGDB by title — returns up to 8 results with cover thumbnails for user to pick from
ipcMain.handle('covers:search', async (_event, { query, igdbClientId, igdbClientSecret }) => {
  if (!igdbClientId || !igdbClientSecret) throw new Error('No IGDB credentials saved.');
  const token = await getIGDBToken(igdbClientId, igdbClientSecret);
  const hdrs = { 'Client-ID': igdbClientId, 'Authorization': 'Bearer ' + token, 'Content-Type': 'text/plain' };
  const igdbQuery = 'search "' + query.replace(/"/g, '') + '"; fields name,cover.image_id,first_release_date; where cover != null; limit 8;';
  const results = await httpsPost('https://api.igdb.com/v4/games', igdbQuery, hdrs);
  if (!Array.isArray(results)) return [];
  return results.map(r => ({
    igdbId:    r.id,
    name:      r.name,
    year:      r.first_release_date ? new Date(r.first_release_date * 1000).getFullYear() : null,
    thumbUrl:  r.cover ? 'https://images.igdb.com/igdb/image/upload/t_cover_small/' + r.cover.image_id + '.jpg' : null,
    coverUrl:  r.cover ? 'https://images.igdb.com/igdb/image/upload/t_cover_big/'   + r.cover.image_id + '.jpg' : null,
  })).filter(r => r.thumbUrl);
});

// ── HEROIC IMPORT (Epic + Amazon) ──
ipcMain.handle('epic:importFromHeroic', async () => {
  const os = require('os');
  const fs = require('fs');

  const heroicBase = [
    path.join(os.homedir(), 'Library/Application Support/heroic/store_cache'),
    path.join(os.homedir(), '.config/heroic/store_cache'),
  ];

  const baseDir = heroicBase.find(p => fs.existsSync(p));
  if (!baseDir) {
    throw new Error(
      'Heroic Games Launcher data not found.\n\n' +
      'Make sure Heroic is installed, you are logged in, and your library has synced at least once.\n\n' +
      'Expected location: ' + heroicBase[0]
    );
  }

  // Parse a Heroic library JSON file safely
  function readLibraryFile(filename) {
    const filePath = path.join(baseDir, filename);
    if (!fs.existsSync(filePath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return Array.isArray(data) ? data : (data.library || data.games || []);
    } catch(e) {
      console.error('Could not parse ' + filename + ':', e.message);
      return [];
    }
  }

  // Epic games via Legendary
  const epicGames  = readLibraryFile('legendary_library.json');
  // Amazon games via Nile
  const amazonGames = readLibraryFile('nile_library.json');

  if (!epicGames.length && !amazonGames.length) {
    throw new Error(
      'No games found in Heroic library files.\n\n' +
      'Make sure you are logged into Epic and/or Amazon in Heroic, and that your library has synced.'
    );
  }

  // Read Heroic playtime data (stored in a separate JSON per game)
  function readPlaytime(appName) {
    const playtimePaths = [
      path.join(os.homedir(), 'Library/Application Support/heroic/GamesConfig', appName + '.json'),
      path.join(os.homedir(), '.config/heroic/GamesConfig', appName + '.json'),
    ];
    for (const p of playtimePaths) {
      if (fs.existsSync(p)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
          // Heroic stores playtime in seconds under 'playtime' or 'total_playtime'
          const secs = cfg.playtime || cfg.total_playtime || 0;
          return Math.round(secs / 3600);
        } catch(e) {}
      }
    }
    return 0;
  }

  const games = store.get('games', []);
  let nextId = store.get('nextId', 1);
  let epicAdded = 0, epicMerged = 0;
  let amazonAdded = 0, amazonMerged = 0;

  // Helper to import a list of games for a given platform
  function importList(list, platform) {
    let added = 0, merged = 0;
    for (const eg of list) {
      const title = eg.title || eg.app_title;
      if (!title || title.trim() === '') continue;
      if (eg.is_dlc || eg.isDlc) continue;

      let genre = 'Other';
      if (eg.metadata && eg.metadata.genres && eg.metadata.genres.length) {
        genre = eg.metadata.genres[0].name || eg.metadata.genres[0] || 'Other';
      }

      const appName = eg.app_name;
      const playtimeHours = appName ? readPlaytime(appName) : 0;

      const existingIndex = games.findIndex(g =>
        g.title.toLowerCase() === title.toLowerCase()
      );
      if (existingIndex !== -1) {
        if (!games[existingIndex].platforms.includes(platform))
          games[existingIndex].platforms.push(platform);
        if (playtimeHours > 0) games[existingIndex].playtimeHours = playtimeHours;
        if (appName && platform === 'epic') games[existingIndex].epicAppName = appName;
        if (!games[existingIndex].addedAt) games[existingIndex].addedAt = new Date().toISOString();
        if (genre && genre !== 'Other' && (!games[existingIndex].genre || games[existingIndex].genre === 'Other'))
          games[existingIndex].genre = genre;
        merged++;
      } else {
        games.push({
          id: nextId++,
          title: title.trim(),
          genre,
          platforms: [platform],
          pal: nextId % 10,
          addedAt: new Date().toISOString(),
          ...(playtimeHours > 0 ? { playtimeHours } : {}),
          ...(platform === 'epic' && appName ? { epicAppName: appName } : {}),
        });
        added++;
      }
    }
    return { added, merged };
  }

  const epicResult   = importList(epicGames,   'epic');
  const amazonResult = importList(amazonGames, 'amazon');

  epicAdded   = epicResult.added;   epicMerged   = epicResult.merged;
  amazonAdded = amazonResult.added; amazonMerged = amazonResult.merged;

  store.set('games', games);
  store.set('nextId', nextId);
  store.set('epicLastSync',   new Date().toISOString());
  store.set('amazonLastSync', new Date().toISOString());

  return {
    epic:   { total: epicGames.length,   added: epicAdded,   merged: epicMerged   },
    amazon: { total: amazonGames.length, added: amazonAdded, merged: amazonMerged },
    lastSync: new Date().toISOString(),
  };
});

// ── FRIEND STEAM COMPARISON ──
ipcMain.handle('steam:importFriend', async (_event, friendSteamId) => {
  const steamId = store.get('steamId');
  const apiKey  = store.get('steamApiKey');
  if (!apiKey) throw new Error('Steam API key not configured. Add it in Settings.');
  if (!/^\d{17}$/.test(friendSteamId.trim()))
    throw new Error('Friend Steam ID must be a 17-digit number.');

  // Get friend's profile name
  let personaName = null;
  try {
    const profileUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${friendSteamId}`;
    const profileData = await httpsGet(profileUrl);
    const players = profileData?.response?.players;
    if (players && players.length) personaName = players[0].personaname;
  } catch(e) {}

  // Get friend's game library
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${friendSteamId.trim()}&include_appinfo=true&include_played_free_games=1&format=json`;
  const data = await httpsGet(url);
  const friendGameList = data?.response?.games || [];
  if (!friendGameList.length) throw new Error('No games found — the friend\'s library may be private.');

  return { games: friendGameList, personaName, total: friendGameList.length };
});

// ── WISHLIST STORE ──
ipcMain.handle('wishlist:getAll', () => store.get('wishlist', []));

ipcMain.handle('wishlist:add', (_event, item) => {
  const wishlist = store.get('wishlist', []);
  const nextId = store.get('wishNextId', 1);
  const exists = wishlist.find(w => w.title.toLowerCase() === item.title.toLowerCase());
  if (exists) return { exists: true, item: exists };
  const newItem = { ...item, id: nextId, addedAt: new Date().toISOString(), currentPrice: null, lowestPrice: null, lastChecked: null };
  wishlist.push(newItem);
  store.set('wishlist', wishlist);
  store.set('wishNextId', nextId + 1);
  return { exists: false, item: newItem };
});

ipcMain.handle('wishlist:delete', (_event, id) => {
  store.set('wishlist', store.get('wishlist', []).filter(w => w.id !== id));
  return true;
});

ipcMain.handle('wishlist:updatePrices', (_event, updates) => {
  const wishlist = store.get('wishlist', []);
  updates.forEach(u => {
    const idx = wishlist.findIndex(w => w.id === u.id);
    if (idx !== -1) {
      // Append to price history (keep last 90 entries)
      if (u.bestPrice !== null && u.bestPrice !== undefined) {
        const history = wishlist[idx].priceHistory || [];
        history.push({ date: new Date().toISOString().slice(0, 10), price: u.bestPrice });
        if (history.length > 90) history.splice(0, history.length - 90);
        u.priceHistory = history;
      }
      Object.assign(wishlist[idx], u);
    }
  });
  store.set('wishlist', wishlist);
  return wishlist;
});

// ── GG.DEALS PRICE CHECK ──
// API: GET https://api.gg.deals/v1/prices/by-steam-app-id/?key=KEY&ids=APPID1,APPID2
// Only works with Steam App IDs. For non-Steam games, we open gg.deals search in browser.
ipcMain.handle('prices:check', async (_event, wishlistItems) => {
  const apiKey = store.get('ggdealsApiKey');
  if (!apiKey) throw new Error('No gg.deals API key saved. Add one in Settings → Price Tracking.');

  // Separate Steam games (have steamAppId) from non-Steam
  const steamItems = wishlistItems.filter(w => w.steamAppId);
  const nonSteamItems = wishlistItems.filter(w => !w.steamAppId);

  const results = {};

  // Batch Steam lookups (up to 100 IDs per request)
  if (steamItems.length) {
    const ids = steamItems.map(w => w.steamAppId).join(',');
    const url = 'https://api.gg.deals/v1/prices/by-steam-app-id/?key=' + apiKey + '&ids=' + ids;
    const data = await httpsGet(url); // let errors propagate to caller
    if (data && data.success && data.data) {
      steamItems.forEach(w => {
        const entry = data.data[String(w.steamAppId)];
        if (!entry || !entry.prices) {
          // Game not in gg.deals DB — mark as no data so UI shows search link
          results[w.id] = {
            title: w.title,
            ggdealsUrl: 'https://gg.deals/search/?title=' + encodeURIComponent(w.title),
            retailPrice: null, keyshopPrice: null, bestPrice: null,
            lastChecked: new Date().toISOString(), noApiData: true,
          };
          return;
        }
        const p = entry.prices;
        const retailPrice  = p.currentRetail   ? parseFloat(p.currentRetail)   : null;
        const keyshopPrice = p.currentKeyshops  ? parseFloat(p.currentKeyshops) : null;
        const histRetail   = p.historicalRetail  ? parseFloat(p.historicalRetail)  : null;
        const histKeyshop  = p.historicalKeyshops ? parseFloat(p.historicalKeyshops) : null;
        results[w.id] = {
          title:       entry.title || w.title,
          ggdealsUrl:  entry.url   || ('https://gg.deals/search/?title=' + encodeURIComponent(w.title)),
          retailPrice, keyshopPrice,
          bestPrice:   retailPrice !== null && keyshopPrice !== null
                         ? Math.min(retailPrice, keyshopPrice)
                         : (retailPrice ?? keyshopPrice),
          histRetail, histKeyshop,
          currency:    p.currency || 'USD',
          lastChecked: new Date().toISOString(),
        };
      });
    } else if (data && !data.success) {
      throw new Error('gg.deals API error: ' + (data.message || JSON.stringify(data).slice(0, 120)));
    }
  }

  // Non-Steam: just attach a gg.deals search URL — no API lookup possible
  nonSteamItems.forEach(w => {
    results[w.id] = {
      title:       w.title,
      ggdealsUrl:  'https://gg.deals/search/?title=' + encodeURIComponent(w.title),
      retailPrice:  null,
      keyshopPrice: null,
      bestPrice:    null,
      lastChecked:  new Date().toISOString(),
      noApiData:    true,
    };
  });

  return results;
});

// Save gg.deals key
ipcMain.handle('prices:saveKey', (_event, key) => {
  store.set('ggdealsApiKey', key);
  return true;
});

// Background price check with Mac notifications
ipcMain.handle('prices:checkWishlistAndNotify', async () => {
  const { Notification } = require('electron');
  const apiKey = store.get('ggdealsApiKey');
  if (!apiKey) return { checked: 0, alerts: 0 };

  const wishlist = store.get('wishlist', []);
  if (!wishlist.length) return { checked: 0, alerts: 0 };

  try {
    const priceResults = await ipcMain.listeners('prices:check')[0](null, wishlist);
    const updates = [];
    let alerts = 0;

    for (const item of wishlist) {
      const info = priceResults[item.id];
      if (!info || info.noApiData) continue;

      const update = {
        id:           item.id,
        retailPrice:  info.retailPrice,
        keyshopPrice: info.keyshopPrice,
        bestPrice:    info.bestPrice,
        ggdealsUrl:   info.ggdealsUrl,
        lastChecked:  info.lastChecked,
      };
      if (info.histRetail)  update.histRetail  = info.histRetail;
      if (info.histKeyshop) update.histKeyshop = info.histKeyshop;

      if (info.bestPrice !== null) {
        if (!item.lowestPrice || info.bestPrice < item.lowestPrice) {
          update.lowestPrice = info.bestPrice;
        }
        // Check target price OR discount threshold
        const hitTarget = (item.targetPrice && info.bestPrice <= item.targetPrice);
        const hitDiscount = (item.discountThreshold && item.retailPrice && item.retailPrice > 0 &&
          ((item.retailPrice - info.bestPrice) / item.retailPrice * 100) >= item.discountThreshold);
        if (hitTarget || hitDiscount) {
          if (Notification.isSupported()) {
            const discountPct = item.retailPrice && item.retailPrice > 0
              ? Math.round((item.retailPrice - info.bestPrice) / item.retailPrice * 100) : null;
            const reasonStr = hitTarget
              ? 'Target: $' + item.targetPrice.toFixed(2)
              : discountPct + '% off (threshold: ' + item.discountThreshold + '%)';
            const notif = new Notification({
              title: 'Deal Alert: ' + item.title,
              body:  'Now $' + info.bestPrice.toFixed(2) + ' \u2014 ' + reasonStr,
              silent: false,
            });
            notif.on('click', () => {
              const { shell } = require('electron');
              shell.openExternal(info.ggdealsUrl || ('https://gg.deals/search/?title=' + encodeURIComponent(item.title)));
            });
            notif.show();
            const notifHistory = store.get('notifHistory', []);
            notifHistory.unshift({ title: item.title, price: info.bestPrice, target: item.targetPrice, discountThreshold: item.discountThreshold, url: info.ggdealsUrl, ts: new Date().toISOString() });
            store.set('notifHistory', notifHistory.slice(0, 50));
          }
          alerts++;
        }
      }
      updates.push(update);
    }

    const stored = store.get('wishlist', []);
    updates.forEach(u => {
      const idx = stored.findIndex(w => w.id === u.id);
      if (idx !== -1) Object.assign(stored[idx], u);
    });
    store.set('wishlist', stored);
    return { checked: updates.length, alerts };
  } catch(e) {
    console.error('Background price check error:', e.message);
    return { checked: 0, alerts: 0, error: e.message };
  }
});;



// ── OPENCRITIC ──
// Free public API, no key required
ipcMain.handle('oc:search', async (_event, title) => {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(title);
    https.get('https://api.opencritic.com/api/game/search?criteria=' + encoded, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Origin': 'https://opencritic.com',
        'Referer': 'https://opencritic.com/',
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch(e) { reject(new Error('OC search parse error: ' + e.message)); }
      });
    }).on('error', e => reject(new Error('OC search network error: ' + e.message)));
  });
});

ipcMain.handle('oc:game', async (_event, id) => {
  return new Promise((resolve, reject) => {
    https.get('https://api.opencritic.com/api/game/' + id, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Origin': 'https://opencritic.com',
        'Referer': 'https://opencritic.com/',
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch(e) { reject(new Error('OC game parse error: ' + e.message)); }
      });
    }).on('error', e => reject(new Error('OC game network error: ' + e.message)));
  });
});

// ── NOTIFICATION HISTORY ──
ipcMain.handle('notif:getHistory', () => store.get('notifHistory', []));
ipcMain.handle('notif:clearHistory', () => { store.set('notifHistory', []); return true; });

// ── STORE DELETE ──
ipcMain.handle('store:delete', (_event, key) => { store.delete(key); return true; });

// ── FULL RESET ──
ipcMain.handle('app:fullReset', () => {
  // Wipe all game library data
  store.set('games', []);
  store.set('nextId', 1);
  store.set('wishlist', []);
  store.set('notifHistory', []);

  // Wipe all API credentials
  store.delete('steamId');
  store.delete('steamApiKey');
  store.delete('steamLastSync');
  store.delete('gogLastSync');
  store.delete('epicLastSync');
  store.delete('amazonLastSync');
  store.delete('xboxLastSync');
  store.delete('gamepassLastSync');
  store.delete('igdbClientId');
  store.delete('igdbClientSecret');
  store.delete('rawgApiKey');
  store.delete('openxblApiKey');
  store.delete('ggdealsApiKey');
  store.delete('coverOverrides');
  store.delete('playtimeGoals');
  store.delete('steamAutoTrack');
  store.delete('autoSessionTracking');
  store.delete('steamPlaytimeSnapshot');
  store.delete('claimedFreeGames');
  store.delete('onboardingComplete');

  // Wipe all session data
  const allKeys = Object.keys(store.store);
  allKeys.filter(k => k.startsWith('sessions:')).forEach(k => store.delete(k));

  return true;
});

// ── EXPORT / BACKUP ──
ipcMain.handle('library:exportJSON', async () => {
  const { filePath } = await dialog.showSaveDialog({
    title: 'Export Library',
    defaultPath: 'nexus-library-backup.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!filePath) return { cancelled: true };
  const games = store.get('games', []);
  fs.writeFileSync(filePath, JSON.stringify({ games, exportedAt: new Date().toISOString() }, null, 2), 'utf8');
  return { cancelled: false, path: filePath, count: games.length };
});

ipcMain.handle('library:exportCSV', async () => {
  const { filePath } = await dialog.showSaveDialog({
    title: 'Export Library as CSV',
    defaultPath: 'nexus-library.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (!filePath) return { cancelled: true };
  const games = store.get('games', []);
  const esc   = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const header = [
    'Title', 'Genre', 'Genres', 'Platforms', 'Status',
    'Playtime (hrs)', 'Avg Completion (hrs)', 'Metacritic Score',
    'Developer', 'Publisher', 'Release Date',
    'Description', 'Tags', 'Notes',
    'Date Acquired', 'Date Added', 'Steam App ID', 'RAWG ID',
  ].join(',');
  const rows = games.map(g => [
    esc(g.title),
    esc(g.genre || 'Other'),
    esc((g.genres || [g.genre]).filter(Boolean).join('|')),
    esc((g.platforms || []).join('|')),
    esc(g.status || ''),
    esc(g.playtimeHours || 0),
    esc(g.avgPlaytime || ''),
    esc(g.metacriticScore || ''),
    esc(g.developer || ''),
    esc(g.publisher || ''),
    esc(g.releaseDate || ''),
    esc((g.description || '').replace(/\n/g, ' ')),
    esc((g.tags || []).join('|')),
    esc((g.notes || '').replace(/\n/g, ' ')),
    esc(g.acquiredAt ? g.acquiredAt.slice(0, 10) : ''),
    esc(g.addedAt ? g.addedAt.slice(0, 10) : ''),
    esc(g.steamAppId || ''),
    esc(g.rawgId || ''),
  ].join(','));
  fs.writeFileSync(filePath, [header, ...rows].join('\n'), 'utf8');
  return { cancelled: false, path: filePath, count: games.length };
});

// ── STEAM STORE DATA ──
ipcMain.handle('steam:storeData', async (_event, appId) => {
  const fetchOnce = () => new Promise((resolve, reject) => {
    const url = 'https://store.steampowered.com/api/appdetails?appids=' + appId + '&cc=us&l=en';
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Referer': 'https://store.steampowered.com/',
        'Cookie': 'birthtime=0; mature_content=1; lastagecheckage=1-0-1990',
      }
    }, (res) => {
      const zlib = require('zlib');
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc.includes('gzip'))         stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      if (res.statusCode === 403 || res.statusCode === 429) { resolve({ status: res.statusCode }); return; }
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        try { resolve({ status: res.statusCode, raw: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch(e) { resolve({ status: res.statusCode }); }
      });
    }).on('error', e => reject(new Error('Steam network error: ' + e.message)));
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await fetchOnce();
    if (result.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
    if (!result.raw) return null;
    const appData = result.raw[appId] || result.raw[String(appId)];
    if (!appData || !appData.success) return null;
    return appData.data || null;
  }
  return null;
});

// ── RAWG GAME DATABASE ──
ipcMain.handle('rawg:search', async (_event, { title, apiKey }) => {
  const encoded = encodeURIComponent(title);
  return new Promise((resolve, reject) => {
    https.get(
      'https://api.rawg.io/api/games?search=' + encoded + '&key=' + apiKey + '&page_size=5&search_precise=false',
      { headers: { 'User-Agent': 'NexusLibrary/1.0' } },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(data.results || []);
          } catch(e) { resolve([]); }
        });
      }
    ).on('error', e => reject(new Error('RAWG search error: ' + e.message)));
  });
});

ipcMain.handle('rawg:game', async (_event, { id, apiKey }) => {
  return new Promise((resolve, reject) => {
    https.get(
      'https://api.rawg.io/api/games/' + id + '?key=' + apiKey,
      { headers: { 'User-Agent': 'NexusLibrary/1.0' } },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch(e) { resolve(null); }
        });
      }
    ).on('error', e => reject(new Error('RAWG game error: ' + e.message)));
  });
});

// ── EPIC FREE GAMES ──
ipcMain.handle('epic:freeGames', async () => {
  return new Promise((resolve) => {
    const url = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US';
    https.get(url, { headers: { 'User-Agent': 'NexusLibrary/1.0' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const elements = data?.data?.Catalog?.searchStore?.elements || [];
          const now = new Date();
          const games = elements.map(el => {
            const promo = el.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0];
            const upcoming = el.promotions?.upcomingPromotionalOffers?.[0]?.promotionalOffers?.[0];
            const isFreeNow = promo && new Date(promo.startDate) <= now && new Date(promo.endDate) >= now;
            const isFreeUpcoming = !isFreeNow && upcoming;
            if (!isFreeNow && !isFreeUpcoming) return null;
            const img = (el.keyImages || []).find(i => i.type === 'Thumbnail' || i.type === 'DieselStoreFrontWide');
            return {
              title:      el.title,
              description: el.description || '',
              imageUrl:   img ? img.url : null,
              pageSlug:   el.catalogNs?.mappings?.[0]?.pageSlug || el.urlSlug || '',
              isFree:     isFreeNow,
              isUpcoming: !!isFreeUpcoming,
              endDate:    isFreeNow ? promo.endDate : null,
              startDate:  isFreeUpcoming ? upcoming.startDate : null,
            };
          }).filter(Boolean);
          resolve(games);
        } catch(e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
});

// ── GIVEAWAYS — GamerPower (via main process to bypass CSP) ──
ipcMain.handle('free:giveaways', async (_event, type) => {
  return new Promise((resolve) => {
    const typeParam = type === 'dlc' ? 'dlc' : type === 'loot' ? 'loot' : 'game';
    const url = `https://www.gamerpower.com/api/giveaways?platform=pc&type=${typeParam}&sort-by=popularity`;
    https.get(url, { headers: { 'User-Agent': 'NexusLibrary/1.0' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!Array.isArray(data)) { resolve([]); return; }
          resolve(data.map(g => ({
            title:       g.title,
            description: g.description || '',
            imageUrl:    g.thumbnail || '',
            url:         g.open_giveaway_url || g.gamerpower_url || '',
            platform:    g.platforms || '',
            type:        g.type || '',
            endDate:     g.end_date && g.end_date !== 'N/A' ? g.end_date : null,
            status:      g.status || 'Active',
            worth:       g.worth || null,
          })));
        } catch(e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
});

// ── OPENXBL — Xbox API (via main process to bypass CSP) ──
ipcMain.handle('xbox:request', async (_event, { endpoint, apiKey }) => {
  return new Promise((resolve) => {
    const options = {
      hostname: 'xbl.io',
      path: endpoint,
      headers: { 'X-Authorization': apiKey, 'Accept': 'application/json', 'User-Agent': 'NexusLibrary/1.0' },
    };
    https.get(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            resolve({ error: true, status: res.statusCode, message: 'HTTP ' + res.statusCode });
            return;
          }
          resolve({ error: false, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch(e) {
          resolve({ error: true, message: e.message });
        }
      });
    }).on('error', (e) => resolve({ error: true, message: e.message }));
  });
});

// ── PC GAME PASS CATALOG — Microsoft storefront API ──
ipcMain.handle('xbox:gamepassCatalog', async () => {
  // Microsoft's Game Pass catalog API — returns the actual list of PC Game Pass titles
  const url = 'https://catalog.gamepass.com/sigls/v2?id=fdd9e2a7-0fee-49f6-ad69-4354098401ff&language=en-us&market=US';
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'NexusLibrary/1.0' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          // Response is an array; first element is metadata, rest are { id: "productId" }
          const productIds = raw.filter(item => item.id && !item.siglDefinition).map(item => item.id);
          if (!productIds.length) { resolve([]); return; }
          
          // Fetch product details in batches of 20
          const BATCH = 20;
          const batches = [];
          for (let i = 0; i < Math.min(productIds.length, 300); i += BATCH) {
            batches.push(productIds.slice(i, i + BATCH));
          }
          
          const results = [];
          let done = 0;
          
          function fetchBatch(ids) {
            const bigId = ids.join(',');
            const detailUrl = `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${bigId}&market=US&languages=en-us&MS-CV=DGU1mcuYo0WMMp`;
            return new Promise((res2) => {
              https.get(detailUrl, { headers: { 'User-Agent': 'NexusLibrary/1.0' } }, (r) => {
                const c = [];
                r.on('data', d => c.push(d));
                r.on('end', () => {
                  try {
                    const d = JSON.parse(Buffer.concat(c).toString('utf8'));
                    const prods = (d.Products || []);
                    prods.forEach(p => {
                      const props = p.LocalizedProperties?.[0] || {};
                      const images = p.LocalizedProperties?.[0]?.Images || [];
                      const thumb = images.find(i => i.ImagePurpose === 'Poster') ||
                                    images.find(i => i.ImagePurpose === 'BoxArt') ||
                                    images.find(i => i.ImagePurpose === 'Tile') ||
                                    images[0];
                      const imageUrl = thumb ? ('https:' + (thumb.Uri || '').replace(/^https?:/, '')) : '';
                      results.push({
                        title: props.ProductTitle || p.ProductId || '',
                        productId: p.ProductId || '',
                        imageUrl,
                        category: p.Properties?.Category || '',
                      });
                    });
                    res2();
                  } catch(e) { res2(); }
                });
              }).on('error', () => res2());
            });
          }
          
          // Fetch all batches sequentially to avoid rate limiting
          (async () => {
            for (const batch of batches) {
              await fetchBatch(batch);
              await new Promise(r => setTimeout(r, 100)); // small delay between batches
            }
            resolve(results.filter(r => r.title));
          })();
          
        } catch(e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
});
