# Google Drive Vault Sync

[![CI](https://github.com/heeralaljrahul/obsidian-remote-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/heeralaljrahul/obsidian-remote-sync/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**An Obsidian plugin that keeps your vault in two-way sync with a folder in your own Google Drive, on Windows/Mac, iPhone and iPad.** It works with a vault folder you already have in Google Drive, uses your own free Google Cloud login (no third-party server, nothing to pay), and never deletes anything permanently.

**Made by [heeralaljrahul](https://github.com/heeralaljrahul)**, developed with the help of Claude Code (Anthropic). It is a fork of [remotely-sync](https://github.com/sboesen/remotely-sync) by sboesen, itself a fork of [remotely-save](https://github.com/remotely-save/remotely-save) by fyears, both Apache-2.0. Everyone whose work or ideas this builds on is credited in [Credits and attribution](#credits-and-attribution) at the end.

It's a personal plugin: it isn't in Obsidian's community plugin store, and you install it with the **BRAT** plugin ([guide below](#complete-setup-guide-step-by-step)).

## What it is

- **For:** keeping one Obsidian vault the same on your PC, iPhone and iPad through Google Drive.
- **Not:** Obsidian's official [Obsidian Sync](https://obsidian.md/sync) service, nor affiliated with Google or Obsidian.
- **Where your data goes:** only between your devices and **your** Google Drive. Notes, tokens and keys are never sent to any other server (not even the author's).
- **Platforms:** Obsidian desktop (Windows, macOS, Linux) and Obsidian mobile on iOS/iPadOS. It uses no desktop-only (Node/Electron) code; Android should work but isn't tested.

> ⚠️ **Back up first.** Copy your notes somewhere safe before the first sync (Part 1 of the guide).
>
> ⚠️ **Only one sync system per vault.** Don't let iCloud, Google Drive for Desktop, OneDrive, Dropbox or Obsidian Sync also sync the same vault folder. Two sync systems fight over the same files and can lose data. On iPhone/iPad the vault must be stored **On My iPhone/iPad**, not in iCloud.
>
> ⚠️ **No background sync on iPhone/iPad.** Apple doesn't allow it. Syncing happens while Obsidian is open: when you open it, return to it, leave it, after you stop typing, and when you tap the sync button.

## What it does

- **Two-way sync** of your existing Drive folder (pick it by name, link or ID), between any number of devices.
- **Sync now** ribbon icon and command; sync when Obsidian opens, when you return to it, when you leave it with unsynced edits, optionally shortly after you stop editing, and every N minutes (optional). Automatic syncs skip quietly when offline.
- **Sign-ins that don't expire** once your Google Cloud app is published to "In production"; the plugin warns you if Google ever attaches an expiry (e.g. an app still in "Testing").
- **Knows which side changed**: every file is compared with what both sides looked like at the last sync (MD5, size, modified time), instead of "newest timestamp wins".
- **Conflict view**: a note edited on two devices is never silently overwritten. You get a list of conflicts and, per file, a diff (unified on phones, side-by-side optional on desktop) with **Keep this device / Keep Drive / Keep both**. The losing version is never thrown away: it goes to `.trash`, to Drive's version history, or is kept as `Name (conflict date).md`.
- **Renames** are detected both ways; a local rename moves the Drive file (keeping its ID and revision history).
- **Safe deletions**: always to Obsidian's `.trash` folder or Google Drive's trash, never permanent. The first sync never deletes anything.
- **Dry run**: see planned uploads, downloads, deletions and conflicts without changing anything. It runs automatically before the first sync, which only starts after you approve.
- **Large-deletion guard**: asks before trashing more than 20 items (adjustable).
- **Resumable**: progress is saved after every file, so a sync interrupted by iOS continues safely next time; big uploads (> 5 MB) resume mid-file.
- **Efficient**: incremental updates via Drive's Changes API; paginated listings; exponential backoff on rate limits (403/429).
- **Drive quirks handled**: duplicate names in one folder (identical copies are deduplicated, different ones are skipped and logged, never touched), names that differ only by upper/lower case, Google Docs/Sheets (skipped).
- **Filters**: `.obsidian` ignored by default (optional sync), editable ignore list, file-size limit. The plugin's own folder (with your OAuth tokens) is never synced.
- **Sync log** viewable on the phone, with copy for troubleshooting.
- **Privacy mode** (`drive.file` scope) as an option; see [SETUP.md](SETUP.md#full-drive-access-vs-privacy-mode) for the tradeoff.
- **iOS-safe**: no Node or Electron APIs; every request uses Obsidian's `requestUrl`, hashing uses Web Crypto / a JS MD5. The build fails if `main.js` would need anything but `obsidian`.

## How it works

**The short version:** each device remembers what every file looked like (checksum, size, date) at the last successful sync. On the next sync it compares three things for every file (*this device now*, *Google Drive now*, *the last sync*), so it knows exactly **which side changed** instead of guessing from timestamps. Then it uploads, downloads, renames, moves to trash, or, if both sides changed, asks you.

### Safety guarantees

- **Nothing is deleted permanently:** deletions go to the vault's `.trash` folder or Google Drive's trash; overwritten Drive files keep their version history.
- **The first sync never deletes anything**, and always shows a dry run you must approve.
- **Conflicts are never overwritten silently:** you choose (keep this device / keep Drive / keep both).
- **Interruptions are safe:** progress is saved after every file; an interrupted sync (iOS suspending the app, lost signal) resumes without duplicates.
- **Every risky step re-checks first** that the file hasn't changed since the plan was made.
- **Guards:** asks before trashing more than 20 files; refuses to sync if the vault suddenly looks empty; skips Drive file names that could escape the vault.

### The pieces

| Part | Where | What it does |
|---|---|---|
| Sync engine | `src/sync/` | planner (three-way decisions, rename detection), executor (applies the plan, saves progress), conflict resolution, diff, ignore rules. Pure TypeScript, no Obsidian imports, fully unit-tested. |
| Google Drive | `src/gdrive/` | Drive v3 REST client, OAuth 2.0 + PKCE, cached folder index with the Changes API, resumable uploads, retry/backoff. |
| Obsidian glue | `src/obsidian/`, `src/main.ts` | vault file access, IndexedDB storage, network via Obsidian's `requestUrl`, settings screen, review/conflict/log windows, sync triggers. |
| Sign-in page | `callback/` | tiny static page on GitHub Pages that hands Google's sign-in code back to Obsidian. |

### One sync, step by step

1. **Drive side:** bring the cached Drive index up to date (Changes API, or a full paginated scan the first time).
2. **Local side:** list the vault and hash only the files whose size or modified time changed.
3. **Plan:** compare each path three ways: local now, Drive now, and the last-synced state:

   | local | Drive | last sync | result |
   |---|---|---|---|
   | changed | unchanged | ✓ | upload |
   | unchanged | changed | ✓ | download |
   | changed | changed | ✓ | conflict → you choose (unless identical) |
   | present | present | – | identical: adopt; different: conflict |
   | deleted | unchanged | ✓ | move Drive copy to trash |
   | unchanged | deleted | ✓ | move local copy to `.trash` |
   | deleted | changed | ✓ | restore from Drive (the edit wins) |

4. **Review** if needed (first sync, dry run, many deletions).
   Conflicts are left untouched by the sync itself; you resolve them afterwards in the conflict view.
5. **Execute** one action at a time. Each step re-checks that nothing changed since planning, and the last-synced state is saved after every file.


## Complete setup guide (step by step)

Read every step in order. Each step says **where** you do it: 💻 = your Windows PC, 📱 = iPhone, 📲 = iPad, 🌐 = a web browser.

**Which path are you?**

- **Path A: "My notes are already in a folder in Google Drive."** You uploaded your vault folder to Google Drive some other way and want to keep using that folder. *(This is the normal case.)*
- **Path B: "I want to start fresh."** A new vault, or a vault that isn't in Google Drive yet, with a new, empty Drive folder.

Most steps are the same for both. Where they differ, the step says **Path A** or **Path B**.

**You need:** your PC with Obsidian installed, your iPhone and iPad with the Obsidian app, your Google account, about 45–60 minutes the first time.

---

### Part 1: Make backups (💻, 5 minutes)

Nothing in this plugin deletes files permanently, but always keep a backup before trying something new.

1. 🌐 On your PC, open <https://drive.google.com>.
2. Find the folder that holds your Obsidian notes. **Right-click it → Download.** Google makes a `.zip` file (big folders can come as several zips). Wait until the download finishes.
3. Move the zip(s) to your **Desktop** and rename it to something like `Obsidian backup 2026-11-18.zip`. **Don't unzip it and don't use it as a vault**: it's just your safety copy.
4. 💻 If you also have the vault on your PC already, copy that folder too: right-click the vault folder → **Copy** → go to the Desktop → right-click → **Paste**. Rename the copy `Obsidian vault backup`.
5. Keep these backups until everything has worked for a couple of weeks.

---

### Part 2: Create your own free Google "app" (🌐 on the PC, one time, ~15 minutes)

The plugin needs permission to use your Google Drive. Instead of using someone else's server, you create your own little "app" in Google Cloud. It's free (no credit card).

#### 2.1 Create a project
1. Go to <https://console.cloud.google.com/> and sign in with **the same Google account that has your notes folder**.
2. If asked, pick your country, tick the terms box, click **Agree and continue**.
3. At the top left, next to "Google Cloud", click the **project picker** (it may say "Select a project"). Click **New project**.
4. Project name: `Obsidian Drive Sync`. Click **Create**.
5. When the notification says it's ready, click **Select project** (or choose it in the project picker). The top bar must now show `Obsidian Drive Sync`.

#### 2.2 Turn on the Google Drive API
1. Click the **☰ menu** (top left) → **APIs & Services** → **Library**.
2. Search for **Google Drive API**, click it, click **Enable**.

#### 2.3 Set up the consent screen
1. **☰ menu** → **APIs & Services** → **OAuth consent screen**. (Newer screens call this **Google Auth Platform**; if you see **Get started**, click it.)
2. **App information:** App name `Obsidian Drive Sync`; User support email: your email. Click **Next**.
3. **Audience:** choose **External**. Click **Next**.
4. **Contact information:** your email. Click **Next**.
5. Tick the box to agree to the policy → **Continue** → **Create**.

#### 2.4 Publish the app (so you never have to log in again every 7 days)
1. In the left menu click **Audience**.
2. You'll see **Publishing status: Testing**. Click **Publish app** → **Confirm**.
3. It must now say **In production**.

*Why:* while an app is in "Testing", Google ends every sign-in after **7 days**. "In production" sign-ins don't expire (as long as each device syncs at least once every 6 months). You do **not** need Google to "verify" your app; you'll just click past a warning once per device (Part 6).

#### 2.5 Create the login keys ("OAuth client")
1. In the left menu click **Clients** (older screens: **APIs & Services → Credentials → + Create credentials → OAuth client ID**).
2. Click **+ Create client**.
3. **Application type: Web application.** Name: `Obsidian`.
4. Under **Authorized redirect URIs** click **+ Add URI** and paste this **exactly** (including the `/` at the end):

   `https://heeralaljrahul.github.io/obsidian-remote-sync/callback/`

5. Leave "Authorized JavaScript origins" empty. Click **Create**.
6. A box shows your **Client ID** (ends in `.apps.googleusercontent.com`) and **Client secret** (starts with `GOCSPX-`). Click **Download JSON** and/or copy both into a password manager or a private note **right now**: Google may never show the secret again.
   - *Lost the secret?* Open the client and click **Add secret** to make a new one.
   - *Keep them private.* They're not enough on their own to open your Drive (that also needs your Google login), but don't post them anywhere.

---

### Part 3: Publish the plugin on GitHub (🌐, one time per version, ~5 minutes)

BRAT installs the plugin from a GitHub "release". You only do this once (and again only if there's a new version).

1. Open <https://github.com/heeralaljrahul/obsidian-remote-sync> and sign in.
2. On the right side, under **Releases**, click **Create a new release** (or go to **Releases → Draft a new release**).
3. Click **Choose a tag**, type `0.1.0` (exactly, no "v"), then click **+ Create new tag: 0.1.0 on publish**.
4. **Target:** `main`. **Release title:** `0.1.0`. You can leave the description empty.
5. Click **Publish release**.
6. Click the **Actions** tab (top of the repo) → you'll see a run called **Release** for `0.1.0`. Wait until it has a **green ✓** (about 3–5 minutes; it runs all the tests first).
7. Go back to **Releases → 0.1.0**. Under **Assets** you must now see **main.js**, **manifest.json** and **styles.css**. ✅
   - If the Release run is red ❌, open it and look at the error. Most likely the tag wasn't exactly `0.1.0`: delete that release and tag and try again.

---

### Part 4: Get your vault ready on the PC (💻)

#### Path A: your notes are already in a Google Drive folder

First find out **where the vault you open in Obsidian on your PC lives**: in Obsidian, right-click any note → **Show in system explorer**. File Explorer opens inside the vault folder; look at the path in its address bar. Then:

- **A1. It's a normal folder on your PC** (like `C:\Users\you\Documents\Obsidian\Notes`): great, use it as it is.
- **A2. It's inside Google Drive for Desktop** (a path like `G:\My Drive\...` or `...\Google Drive\...`): that would be two sync systems on one vault. Do this instead:
  1. Close Obsidian.
  2. Copy the whole vault folder from `G:\My Drive\...` to `C:\Users\<you>\Documents\Obsidian\` (copy, don't move).
  3. Open Obsidian → bottom-left vault name → **Manage vaults** → **Open folder as vault** → choose the **copy** in `Documents\Obsidian\`.
  4. In **Manage vaults**, remove the old `G:\` vault from the list (hover → ✕ / *Remove from list*). This only removes it from the list; no files are deleted.
  5. From now on only edit notes in the `Documents` copy. Don't edit the notes through `G:\` or in the Drive website.
- **A3. You don't have the vault on this PC at all:**
  1. Unzip a *second* copy of the Drive zip from Part 1 (not your backup) into `C:\Users\<you>\Documents\Obsidian\` (right-click → **Extract All**).
  2. Obsidian → **Open folder as vault** → choose that folder.

> Either way, the PC vault and the Drive folder will be compared file by file in the first sync. Identical files are simply marked "in sync": nothing is copied twice.

#### Path B: starting fresh

1. 💻 Obsidian → bottom-left vault name → **Manage vaults** → **Create new vault**. Name it (e.g. `Notes`) and save it in `C:\Users\<you>\Documents\Obsidian\`. Or use an existing local vault you want to start syncing.
2. 🌐 In <https://drive.google.com>: **+ New → New folder**, name it (e.g. `Obsidian Vault`). Leave it empty.
   - *(Optional "privacy mode": skip this folder and let the plugin create one in Part 6. See the [Full Drive vs privacy mode](SETUP.md#full-drive-access-vs-privacy-mode) table.)*

---

### Part 5: Install the plugin on the PC (💻, ~5 minutes)

1. Obsidian → **Settings** (⚙ gear, bottom-left) → **Community plugins**.
2. If you see **Turn on community plugins** (or "Restricted mode is on"), click it to allow plugins.
3. Click **Browse**, search **BRAT**, click **BRAT** (by TfTHacker) → **Install** → **Enable**.
4. Close settings. Press **Ctrl + P** (command palette), type `BRAT add`, choose **BRAT: Add a beta plugin for testing** (the wording can vary slightly by BRAT version).
5. Paste `https://github.com/heeralaljrahul/obsidian-remote-sync`, choose the **latest version** (`0.1.0`), tick **Enable after installing** if it's offered, and click **Add plugin**.
6. Go to **Settings → Community plugins** and check that **Google Drive Vault Sync** is in the list with its switch **on**.
7. A new **circular-arrows icon** ("Sync with Google Drive") appears in the left ribbon.

---

### Part 6: Connect the plugin on the PC (💻, ~5 minutes)

Open **Settings** → scroll the left list down to **Google Drive Vault Sync**.

1. **OAuth client ID:** paste the Client ID from Part 2.5.
2. **OAuth client secret:** paste the Client secret.
3. **Redirect URI:** leave it as it is (`https://heeralaljrahul.github.io/obsidian-remote-sync/callback/`).
4. **Permission scope:**
   - Path A: **Full Drive (works with your existing folder)**. *(Needed because the folder already exists.)*
   - Path B: Full Drive is simplest. (Privacy mode works too, but only with a folder the plugin creates.)
5. Click **Sign in with Google**. Your web browser opens:
   1. Choose your Google account.
   2. You'll see **"Google hasn't verified this app"**. That's expected, because it's your own app. Click **Advanced** → **Go to Obsidian Drive Sync (unsafe)**.
   3. On the permissions page **tick the Google Drive checkbox** ("See, edit, create and delete all of your Google Drive files"). If you don't tick it, the plugin will tell you and you'll have to try again.
   4. Click **Continue**.
   5. A page "Returning to Obsidian…" opens and the browser asks **Open Obsidian?** → click **Open**.
   6. Obsidian shows **Signed in to Google Drive as you@gmail.com**.
   - *Didn't jump back?* The page shows a code. Copy it, then in the plugin settings paste it into **Paste authorization code** → **Use code** (within a few minutes).
6. The settings now say **Signed in as …** and **"No expiry"**. If instead you see "expires in N days", go back to Part 2.4 and publish the app, then **Sign out** and sign in again.
7. **Drive vault folder:**
   - 🌐 Open <https://drive.google.com>, double-click your notes folder (Path A) or the new empty folder (Path B), and copy the whole address from the browser's address bar (it looks like `https://drive.google.com/drive/folders/1AbC…`).
   - 💻 Paste it into **Folder ID or link** → click **Use ID**. You'll see *Vault folder set to "…"*, and **Current folder** shows its name.
   - *Or:* type the folder's name → **Find by name** → pick the right one (it shows dates in case several have the same name).
   - *Path B privacy mode:* choose **Privacy mode** as the scope, sign in, then use **Create a new vault folder** instead.
8. **When to sync** (good defaults):
   - Sync when Obsidian opens: **on**
   - Sync when returning to Obsidian: **on**
   - Sync when leaving Obsidian: **on**
   - Sync after you stop editing (seconds): **60** (recommended)
   - Sync every N minutes: `0` (off) or `10`
9. **What to sync:** leave **Sync the .obsidian folder** **off** for now. That folder holds settings, themes and plugins, which are best set up on each device separately at first.
10. **Safety:** leave **Ask before trashing more than** at `20`.

---

### Part 7: First sync on the PC (💻, the important one)

1. Click the **circular-arrows icon** in the left ribbon (or **Ctrl + P** → **Google Drive Vault Sync: Sync now**).
2. A window **"Review your first sync"** opens. **Nothing has been changed yet**: this is a dry run. Read the numbers:
   - **Already in sync:** files identical on both sides. Just recorded, nothing copied. *(Path A: this should be most of your notes.)*
   - **Uploads to Drive:** files only on the PC.
   - **Downloads from Drive:** files only in Drive.
   - **Conflicts:** the same file exists on both sides with different content. Both are left alone; you choose after the sync.
   - **Skipped:** e.g. Google Docs, files over the size limit, names Obsidian doesn't allow. Nothing happens to them.
   - **Deletions:** always **0** on a first sync.
3. **Does it look right?**
   - Path A: lots of "Already in sync", a few uploads/downloads/conflicts → ✅ fine.
   - Path B: everything is an **upload** → ✅ fine.
   - Surprises (e.g. Path A shows *thousands* of uploads and downloads) usually mean the **wrong folder** was picked. Click **Cancel**, check Part 6 step 7, and try again. Nothing was changed.
4. Click **Run first sync**. Wait for **"Sync finished: N change(s)"**. Big vaults can take a few minutes; the status bar shows progress.
5. If there were conflicts, the **Sync conflicts** window opens by itself. For each file, click **Review**:
   - **Red lines (−)** = the Google Drive version. **Green lines (+)** = this device's version.
   - **Keep this device:** this device's version wins (Drive keeps the old one in its version history).
   - **Keep the Drive version:** Drive wins (this device's version goes to the vault's `.trash`).
   - **Keep both:** safest if unsure. Drive's version keeps the name, and yours is saved as `Name (conflict 2026-11-18 1430).md`. Merge them by hand later.
   - **Decide later:** nothing happens; you'll be asked again next time.
6. 🌐 Check <https://drive.google.com>: your folder now holds everything. Path B: all your notes are there.

**From now on, don't edit notes directly in the Google Drive website or through Google Drive for Desktop.** Edit in Obsidian; the plugin takes care of Drive.

---

### Part 8: iPhone (📱, ~10 minutes + download time)

1. **Install Obsidian** from the App Store and open it.
2. **Create a vault that is NOT in iCloud:**
   - Tap **Create new vault**. Name: anything (e.g. `Notes`).
   - Make sure **Store in iCloud** is **off**. Tap **Create**.
   - *Already have a vault in iCloud?* Make this new local one anyway, and use only this one with the plugin.
3. **Open Settings:** swipe right from the left edge (or tap the sidebar icon at the top left) → tap the **⚙ gear**.
4. **Community plugins** → tap **Turn on community plugins** → **Browse** → search **BRAT** → **Install** → **Enable**.
5. Close settings. **Open the command palette:** pull down from the middle of the screen (Obsidian's default pull-down action), or open the left sidebar and tap the command palette button. Type `BRAT add` → **BRAT: Add a beta plugin for testing**.
6. Paste `https://github.com/heeralaljrahul/obsidian-remote-sync` (tip: open this README on the phone and copy it) → latest version → **Add plugin**.
7. **Settings → Community plugins** → make sure **Google Drive Vault Sync** is **on**.
8. **Settings → Google Drive Vault Sync:**
   1. **OAuth client ID** and **OAuth client secret:** the same ones as on the PC. Easiest is to copy them from your password manager. *(If you sent them to yourself by email or chat to copy them, delete that message afterwards.)*
   2. **Permission scope:** same as the PC (Full Drive for Path A).
   3. **Sign in with Google:** Safari opens → choose account → **Advanced → Go to Obsidian Drive Sync (unsafe)** → tick the **Google Drive** box → **Continue** → Safari asks **Open in "Obsidian"?** → **Open**. You see *Signed in as …*.
      - *If that doesn't work:* on the PC, in the plugin settings press **Copy refresh token**. Put it in your password manager (never email/chat: it's the key to your Drive), copy it on the phone into **Paste refresh token** → **Save**.
   4. **Drive vault folder:** type the folder's name → **Find by name** → pick it. Or paste the folder link → **Use ID**. It **must be the same folder as on the PC**.
   5. **When to sync:** keep **opens / returning / leaving** on, and set **Sync after you stop editing** to `60`.
   6. Leave **Sync the .obsidian folder** off.
   7. Read the grey box at the top: *iOS doesn't allow background sync*. That's normal.
9. **First sync on the iPhone:**
   1. Optional, for big vaults: in the iPhone **Settings → Display & Brightness → Auto-Lock → Never** while it downloads (switch it back afterwards).
   2. Open the left sidebar and tap the **circular-arrows icon**, or command palette → **Sync now**.
   3. **Review your first sync** should show almost only **Downloads from Drive** (plus "Already in sync" if anything was there). Tap **Run first sync**.
   4. **Keep Obsidian open** until **Sync finished**. If the phone locks or you switch apps, nothing breaks: open Obsidian again and it continues where it stopped.
10. Open a few notes to check they're all there.

### Part 9: iPad (📲)

Do **exactly the same as Part 8** on the iPad: new vault **not in iCloud**, BRAT, the plugin, the same client ID/secret, sign in, **the same Drive folder**, first sync (downloads), and keep Obsidian open until it finishes.

---

### Part 10: Test that everything works (~15 minutes)

Do these once, in order. Each one takes a minute. ✅ = what you should see.

| # | Do this | ✅ Expected |
|---|---|---|
| 1 | 💻 Create a note `Sync test.md` with "hello from PC". Click the sync icon. | "Sync finished: 1 change". It appears in drive.google.com. |
| 2 | 📱 Open Obsidian on the iPhone (or switch back to it). | `Sync test.md` appears within seconds (sync on open/return). |
| 3 | 📱 Edit it: add "hello from iPhone". Switch to another app (home screen). Wait 10 s. | The edit is pushed when you leave the app. |
| 4 | 💻 Click the sync icon. | The note shows the iPhone's line. |
| 5 | 📲 Open Obsidian on the iPad. | The note has both lines. |
| 6 | 💻 Rename the note to `Sync test renamed.md`, sync. Then open the iPhone. | Renamed on the iPhone too (moved, not duplicated). |
| 7 | 📱 Delete the note, then switch away from Obsidian. 💻 Sync. | It disappears on the PC and goes to the vault's `.trash` folder; in Drive it's in **Trash**. Restore either if you like. |
| 8 | **Conflict test:** 📱 Turn on **Airplane mode** and edit a test note on the iPhone. 💻 Edit the same note differently and sync. 📱 Turn Airplane mode off and tap sync. | The **Sync conflicts** window opens; the diff shows both versions. Choose **Keep both** → you get `… (conflict …).md`. |
| 9 | 📱 Add a photo to a note (attachment). Leave the app. 💻 Sync. | The image shows on the PC. |
| 10 | 💻 Put a video or PDF over 5 MB in the vault, sync. 📱 Open Obsidian. | It arrives intact (uses resumable upload). *Please do this once: it's the one thing that can only be checked on a real iPhone.* |
| 11 | 📱 Airplane mode on → tap sync. | "You're offline…" and nothing changes. Airplane mode off → sync works again. |
| 12 | Any device: command palette → **Google Drive Vault Sync: Dry run**. | Shows what would happen; changes nothing. Close it. |
| 13 | Any device: command palette → **Show sync log**. | A list of what happened, with a **Copy** button (useful if you ever need help). |
| 14 | 📱 Force-quit Obsidian (swipe it away) and open it again. | It syncs on open and finds nothing to do. |

When all ✅: you're done. Delete the test notes (they'll be removed everywhere on the next sync).

---

### Everyday use

- Just use Obsidian. It syncs when you open it, return to it, leave it, after you stop typing (if you set 60 s), and when you tap the sync icon.
- **Before switching devices**, give the first device a moment (or tap sync) so its last edits are pushed.
- **Conflicts** (same note edited on two devices before they synced) open the conflict window. Nothing is lost whichever you pick.
- **Deleted something by mistake?** Look in the vault's `.trash` folder or Google Drive's **Trash** (kept 30 days), or in drive.google.com **right-click the file → File information → Manage versions** for older versions of it.
- **More than 20 files about to be deleted?** The plugin stops and asks first.
- **Settings/plugins/themes:** set them up on each device. (Advanced: turn on **Sync the .obsidian folder** on all devices; the plugin will ask you to restart Obsidian when settings arrive from another device.)

### Updating the plugin later

- 🌐 When there's a new version, create a release for it exactly like Part 3, but with the new number (e.g. `0.1.1`, which must match `manifest.json`).
- 💻📱📲 BRAT checks for updates automatically when Obsidian starts. Or use the command palette → **BRAT: Check for updates to all beta plugins**.

### If something goes wrong

| Problem | What to do |
|---|---|
| Google says `redirect_uri_mismatch` | The redirect URI in Part 2.5 must be exactly `https://heeralaljrahul.github.io/obsidian-remote-sync/callback/` (with the last `/`). |
| "Google hasn't verified this app" | Normal for your own app: **Advanced → Go to … (unsafe)**. |
| "Google Drive access was not granted" | Sign in again and **tick the Drive checkbox**. |
| Asked to sign in again after about a week | The app is still in **Testing**: Part 2.4 → **Publish app**, then sign out and in once on each device. |
| "Folder not found" | You chose privacy mode with an existing folder, or a different Google account. Use **Full Drive** and the right account. |
| "The local vault looks empty but was synced before" | Safety stop: you probably opened a different/empty vault. Open the right vault. If you really started over on this device: **Settings → Reset sync state**, then sync (it will do a safe first sync again). |
| A file is "skipped" | See **Show sync log**: e.g. two files with the same name in one Drive folder (rename one in Drive), Google Docs (not synced), or a name with `: * ? " < > |` (rename it). |
| Anything else | Command palette → **Show sync log** → **Copy**, and look at the warnings/errors. |

More detail: [SETUP.md](SETUP.md) (Google Cloud, scopes, expiry) and [INSTALL-IOS.md](INSTALL-IOS.md).

## Development and quality checks

```bash
npm ci
```

```bash
npm test
```

```bash
npm run build
```

- `npm run lint` runs ESLint (type-aware rules: no floating promises, no unsafe `any`, no Node imports in the plugin) and checks Prettier formatting.
- `npm test` type-checks and runs the whole suite (≈190 tests):
  - **unit / integration**: planner, executor, Drive client, OAuth, diff, ignore rules, against an in-memory fake of the Drive v3 REST API
  - **security**: path traversal from Drive names, token/secret handling, OAuth state & PKCE, query injection, callback-page XSS + CSP, bundle must not contain `eval`/`innerHTML`/Node APIs
  - **network**: 401 refresh, 429/403/5xx backoff, offline, dropped connections mid-sync, garbled/corrupted/truncated replies, expired cursors and upload sessions, plus probes against Google's real endpoints
  - **stress**: 5,000-file vaults, 60-level folders, 40 MB files, 1,000 deletions/renames, 300 conflicts
  - **system / fuzz**: random multi-device scenarios with interruptions and network failures, checking *no data loss* and *convergence*
  - **end-to-end**: the built `main.js` in Chromium inside a fake Obsidian (real IndexedDB + Web Crypto): sign-in, first-sync review, conflict view, iPhone mode, sync on leave, offline
- `npm run test:fuzz` runs the deep fuzz (3,000 scenarios ≈ 100,000 syncs); CI runs it weekly.
- `npm run test:e2e` runs only the browser tests (needs Playwright's Chromium: `npx playwright install chromium`).
- `npm run build` type-checks, bundles `main.js` and verifies it has no Node/Electron imports.

To try a build on desktop, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/gdrive-vault-sync/`.

### Releasing (for BRAT)

```bash
npm version 0.1.1
```

```bash
git push --follow-tags
```

`npm version` updates `manifest.json` and `versions.json` and creates the tag `0.1.1` (no `v` prefix, as Obsidian and BRAT expect). Pushing the tag runs `.github/workflows/release.yml`, which checks that the tag matches `manifest.json`, runs all tests, builds the plugin and attaches `main.js`, `manifest.json` and `styles.css` to the release. You can also create the release on github.com (Part 3 of the guide); the workflow then attaches the files to it. Tags with a suffix (e.g. `0.2.0-beta.1`) become pre-releases.

## Project documents

- [SETUP.md](SETUP.md): Google Cloud details, full Drive vs privacy mode, sign-in expiry.
- [INSTALL-IOS.md](INSTALL-IOS.md): extra background for iPhone/iPad.
- [SECURITY.md](SECURITY.md): how secrets and data are protected; how to report a problem.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.
- [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): license notices.

## Credits and attribution

**Author:** [heeralaljrahul](https://github.com/heeralaljrahul): idea, requirements, testing, maintenance. Developed with the help of **Claude Code** by [Anthropic](https://www.anthropic.com) (AI pair-programming; commits are marked "Co-Authored-By: Claude").

**Code this project is based on (Apache-2.0):**
- [**remotely-sync**](https://github.com/sboesen/remotely-sync) by **sboesen** and contributors. This repository started as a fork of remotely-sync v0.4.49 (commit `21a9e01`).
- [**remotely-save**](https://github.com/remotely-save/remotely-save) by **fyears** and contributors, the project remotely-sync was forked from.
- The Google Drive provider, OAuth flow, three-way sync engine, conflict view and tests were written for this project from Google's public Drive v3 documentation. No code from remotely-save's paid `pro/` folder or any other differently-licensed code is included.

**Ideas (no code copied):**
- [**GitHub Gitless Sync**](https://github.com/silvanocerza/github-gitless-sync) by **Silvano Cerza** (AGPL-3.0): the conflict-resolution experience (diff view with a choice per file).
- [**Obsidian Google Drive Sync**](https://github.com/richardx366/Obsidian-Google-Drive) by **Richard Xiong**: sync after editing, sync when leaving the app, skipping automatic syncs while offline, the restart notice for synced settings.
- **Eugene W. Myers**, *"An O(ND) Difference Algorithm and Its Variations"* (1986): the line-diff algorithm used in the conflict view.

**Bundled libraries** (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)):
- [localForage](https://github.com/localForage/localForage) by **Mozilla** (Apache-2.0), with [lie](https://github.com/calvinmetcalf/lie) and [immediate](https://github.com/calvinmetcalf/immediate) by **Calvin Metcalf** (MIT).
- [spark-md5](https://github.com/satazor/js-spark-md5) by **André Cruz** (MIT/WTFPL).

**Platforms and tools:**
- [Obsidian](https://obsidian.md) and its plugin API.
- [BRAT](https://github.com/TfTHacker/obsidian42-brat) by **TfTHacker**, used to install this plugin.
- [Google Drive API](https://developers.google.com/drive/api) and Google OAuth 2.0.
- [GitHub](https://github.com) Actions and Pages.
- Development tools: TypeScript and Playwright (Microsoft), esbuild (Evan Wallace), Mocha, Chai, tsx, ESLint, typescript-eslint, Prettier.

## License

Licensed under the [Apache License 2.0](LICENSE). See also [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Not affiliated with Google, Obsidian, or Anthropic. Google Drive is a trademark of Google LLC; Obsidian is a trademark of Dynalist Inc.
