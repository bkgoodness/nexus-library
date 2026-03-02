const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexus', {
  games: {
    getAll:          ()                  => ipcRenderer.invoke('games:getAll'),
    add:             (game)              => ipcRenderer.invoke('games:add', game),
    delete:          (id)               => ipcRenderer.invoke('games:delete', id),
    updatePlatforms: (id, platforms)     => ipcRenderer.invoke('games:updatePlatforms', { id, platforms }),
    update:          (id, fields)        => ipcRenderer.invoke('games:update', { id, fields }),
    bulkSetGenre:    (ids, genre)        => ipcRenderer.invoke('games:bulkSetGenre', { ids, genre }),
    fetchSteamGenres:(appIds)            => ipcRenderer.invoke('games:fetchSteamGenres', appIds),
    testSteamSpy:    (appId)             => ipcRenderer.invoke('games:testSteamSpy', appId),
  },
  steam: {
    importLibrary: (steamId, apiKey) => ipcRenderer.invoke('steam:importLibrary', { steamId, apiKey }),
    getPresence:   ()                => ipcRenderer.invoke('steam:getPresence'),
    getRecentlyPlayed: ()               => ipcRenderer.invoke('steam:getRecentlyPlayed'),
    resync:        ()                => ipcRenderer.invoke('steam:resync'),
    searchApps:    (query)           => ipcRenderer.invoke('steam:searchApps', query),
    refreshAppList:()                => ipcRenderer.invoke('steam:refreshAppList'),
    getCacheStatus:()                => ipcRenderer.invoke('steam:getCacheStatus'),
    importFriend:  (friendId)        => ipcRenderer.invoke('steam:importFriend', friendId),
  },
  gog: {
    importFromDB: () => ipcRenderer.invoke('gog:importFromDB'),
  },
  epic: {
    freeGames: () => ipcRenderer.invoke('epic:freeGames'),
    importFromCSV:    (csvText) => ipcRenderer.invoke('epic:importFromCSV', csvText),
    importFromHeroic: ()        => ipcRenderer.invoke('epic:importFromHeroic'),
  },
  covers: {
    fetchBatch:            (games, igdbClientId, igdbClientSecret) => ipcRenderer.invoke('covers:fetchBatch', { games, igdbClientId, igdbClientSecret }),
    fetchOne:              (game, igdbClientId, igdbClientSecret)  => ipcRenderer.invoke('covers:fetchOne',  { game,  igdbClientId, igdbClientSecret }),
    search:                (query, igdbClientId, igdbClientSecret) => ipcRenderer.invoke('covers:search',    { query, igdbClientId, igdbClientSecret }),
    saveIGDBCredentials:   (clientId, clientSecret)                => ipcRenderer.invoke('covers:saveIGDBCredentials', { clientId, clientSecret }),
    saveCache:             (cache)                                 => ipcRenderer.invoke('covers:saveCache', cache),
    loadCache:             ()                                      => ipcRenderer.invoke('covers:loadCache'),
  },
  wishlist: {
    getAll:               ()       => ipcRenderer.invoke('wishlist:getAll'),
    add:                  (item)   => ipcRenderer.invoke('wishlist:add', item),
    delete:               (id)     => ipcRenderer.invoke('wishlist:delete', id),
    updatePrices:         (updates)=> ipcRenderer.invoke('wishlist:updatePrices', updates),
  },
  prices: {
    check:                (items)  => ipcRenderer.invoke('prices:check', items),
    saveKey:              (key)    => ipcRenderer.invoke('prices:saveKey', key),
    checkWishlistAndNotify: ()     => ipcRenderer.invoke('prices:checkWishlistAndNotify'),
  },
  notif: {
    getHistory:  () => ipcRenderer.invoke('notif:getHistory'),
    clearHistory: () => ipcRenderer.invoke('notif:clearHistory'),
  },
  oc: {
    search: (title) => ipcRenderer.invoke('oc:search', title),
    game:   (id)    => ipcRenderer.invoke('oc:game', id),
  },
  steamStore: {
    get: (appId) => ipcRenderer.invoke('steam:storeData', appId),
  },
  rawg: {
    search: (title, apiKey) => ipcRenderer.invoke('rawg:search', { title, apiKey }),
    game:   (id, apiKey)    => ipcRenderer.invoke('rawg:game',   { id, apiKey }),
  },
  store: {
    get: (key)           => ipcRenderer.invoke('store:get', key),
    set: (key, value)    => ipcRenderer.invoke('store:set', key, value),
    delete: (key)        => ipcRenderer.invoke('store:delete', key),
    getByPrefix: (prefix) => ipcRenderer.invoke('store:getByPrefix', prefix),
  },
  app: {
    fullReset: () => ipcRenderer.invoke('app:fullReset'),
  },
  library: {
    exportJSON: () => ipcRenderer.invoke('library:exportJSON'),
    exportCSV:  () => ipcRenderer.invoke('library:exportCSV'),
  },
  free: {
    giveaways: (type) => ipcRenderer.invoke('free:giveaways', type),
  },
  xbox: {
    request: (endpoint, apiKey) => ipcRenderer.invoke('xbox:request', { endpoint, apiKey }),
    gamepassCatalog: () => ipcRenderer.invoke('xbox:gamepassCatalog'),
  },
});

// Progress events from main process (steam app list download)
contextBridge.exposeInMainWorld('nexusEvents', {
  onSteamAppListProgress:  (cb) => ipcRenderer.on('steam:appListProgress',   (_e, data) => cb(data)),
  offSteamAppListProgress: ()    => ipcRenderer.removeAllListeners('steam:appListProgress'),
  onCoverFuzzyProgress:    (cb) => ipcRenderer.on('covers:fuzzyProgress',    (_e, data) => cb(data)),
  offCoverFuzzyProgress:   ()    => ipcRenderer.removeAllListeners('covers:fuzzyProgress'),
});
