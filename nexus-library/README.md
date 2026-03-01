# NEXUS Library — Setup Guide

Your unified game library for Steam, GOG, and Epic Games.

---

## First-Time Setup (do this once)

You only need to do these steps one time.

### Step 1 — Open a terminal

**Windows:** Press `Windows key + R`, type `cmd`, press Enter.
**Mac:** Press `Command + Space`, type `Terminal`, press Enter.

### Step 2 — Navigate to this folder

After unzipping, you'll have a folder called `nexus-library`. Drag that folder into your terminal window after typing `cd ` (with a space), then press Enter. Or type it manually:

```
cd path/to/nexus-library
```

### Step 3 — Install everything

Copy and paste this command, then press Enter:

```
npm install
```

Wait for it to finish (it downloads the necessary files — takes 1-2 minutes).

### Step 4 — Launch the app

```
npm start
```

The Nexus Library window will open! 🎮

---

## Launching the app in the future

Just open your terminal, navigate to this folder, and run:

```
npm start
```

---

## Connecting your platforms

### Steam (automatic)
1. Open the app and click **Settings** (gear icon, bottom left)
2. Find your **Steam ID**: Visit https://store.steampowered.com/account and look for "Steam ID" on the page
3. Get a free **API Key**: Visit https://steamcommunity.com/dev/apikey (requires a Steam account)
4. Paste both into the Settings page and click **Connect Steam**
5. Your entire Steam library imports automatically!

### GOG (CSV import)
1. Log in at https://www.gog.com/account
2. Look for an "Export" or "Download library" option in your account settings
3. Download the CSV file
4. Open Nexus Settings → drag the CSV file into the GOG import section

### Epic Games (manual or CSV)
1. Epic doesn't offer a direct export
2. You can add Epic games manually using the **+ Add Game** button
3. Or use the community tool **Legendary** to export a CSV: https://github.com/derrod/legendary

---

## Building a standalone .exe or .app (optional)

If you want an app that launches from your desktop without needing the terminal:

**Windows:**
```
npm run build:win
```

**Mac:**
```
npm run build:mac
```

The installer will appear in the `dist/` folder.

---

## Troubleshooting

**"npm is not recognized"** — Node.js isn't installed. Download it free from https://nodejs.org

**Steam import fails** — Make sure your Steam profile is set to Public, and double-check your API key has no extra spaces.

**App is blank on launch** — Try closing and running `npm start` again.

---

## Adding an app icon

Replace the file at `assets/icon.png` with your own 512×512 PNG image.
The icon will appear in the taskbar and on the built app.
