# Install on iPhone, iPad (and Windows) with BRAT, and do the first sync safely

This plugin isn't in Obsidian's community plugin list. You install it with **BRAT** (Beta Reviewers Auto-update Tester), which downloads it from this repository's GitHub releases and keeps it updated. The same steps work on Windows.

Do **SETUP.md** first (Google Cloud project, client ID and secret, callback page).

---

## Before anything else

### 1. Don't keep the vault in iCloud
**Do not let iCloud (or OneDrive, Dropbox, Obsidian Sync…) sync this same vault while this plugin syncs it.** Two sync systems working on the same files will fight each other: one overwrites or re-creates what the other just deleted, and you can lose data.

On iPhone/iPad, create the vault **On My iPhone** / **On My iPad**, not in iCloud Drive. Obsidian asks when you create a vault ("Store in iCloud" must be **off**). If your current phone vault is in iCloud, make a new local vault for this plugin instead of reusing it.

### 2. Back up
- **PC:** copy your whole vault folder somewhere safe (e.g. right-click → Send to → Compressed (zipped) folder).
- **Google Drive:** in drive.google.com, right-click the vault folder → **Download** (Drive zips it).

Keep both until you've done a few syncs on every device.

### 3. Sync only runs while Obsidian is open
iOS doesn't let plugins run in the background. On iPhone/iPad the plugin syncs when you open Obsidian, when you switch back to it, on the optional interval, and when you tap the sync icon. Leave Obsidian open until you see **Sync finished**. If iOS interrupts a sync, the plugin saves its progress after every file and simply continues next time.

---

## Install BRAT and the plugin (each device)

1. **Settings → Community plugins** → turn off **Restricted mode** if it's on.
2. **Browse** → search **BRAT** → **Install** → **Enable**.
3. Open the command palette (iPhone: swipe down in a note or tap the **⋮ / command** button; PC: `Ctrl+P`) → run **BRAT: Add a beta plugin for testing**.
4. Repository: `https://github.com/heeralaljrahul/obsidian-remote-sync` → choose the latest version → **Add plugin**.
5. If the repository is **private**, BRAT needs a GitHub token:
   - On github.com: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
     - Repository access: **Only select repositories** → `obsidian-remote-sync`
     - Permissions → Repository permissions → **Contents: Read-only**
   - Paste the token where BRAT asks for it (in the add-plugin dialog or BRAT's settings, depending on BRAT's version).
   - Treat it like a password.
6. **Settings → Community plugins** → make sure **Google Drive Vault Sync** is **enabled**.

Updates: BRAT checks for new releases automatically; you can also run **BRAT: Check for updates to all beta plugins**.

---

## First sync: do it on your PC first

The safest order is **PC → iPhone → iPad**: the PC has the most complete copy of your vault, and later devices then only need to download.

### On the PC (Windows)
1. Plugin settings: enter client ID and secret, **Sign in with Google**, pick the vault folder (SETUP.md steps 5–6).
2. Leave **Sync the .obsidian folder** off for now.
3. Click the **sync icon** in the left ribbon (🔄) or run **Google Drive Vault Sync: Sync now**.
4. Because it's the first sync, you get a **dry run** first: nothing has been changed yet. Read it:
   - **Uploads**: files only on your PC.
   - **Downloads**: files only in Drive.
   - **Conflicts**: files that exist on both sides with different content. They are **left alone** on both sides (a conflict screen comes in a later version; until then you can fix them by hand: make both copies identical, or delete one copy, and the next sync settles it).
   - **Already in sync**: identical files. They're just recorded, not transferred again.
   - **Deletions**: always empty on a first sync.
5. If it looks right, tap **Run first sync**. Otherwise **Cancel**: nothing happens.

### On the iPhone, then the iPad
1. Create an **empty** vault **On My iPhone** (not iCloud), with any name.
2. Install BRAT and the plugin as above, then enable it.
3. Settings:
   - client ID, secret and redirect URI: same as on the PC.
   - Sign in: **Sign in with Google**. Safari opens; approve (**Advanced → Go to … (unsafe)**, tick the Drive checkbox); the page asks **Open in "Obsidian"?** → **Open**.
     - If that doesn't work: on the PC press **Copy refresh token** and paste it into **Paste refresh token** on the phone (send it via a password manager, not chat or email).
   - Pick the **same Drive folder**.
4. Tap the sync icon → the dry run should show almost only **Downloads** → **Run first sync**.
5. Keep Obsidian in the foreground until **Sync finished**. Large vaults may take a few minutes. If it gets interrupted, just open Obsidian again: it continues where it stopped.

Then repeat on the iPad.

---

## Everyday use

- **Automatic:** when Obsidian opens, when you return to it (at most once a minute), and every N minutes if you set an interval.
- **Manual:** the sync icon (🔄) or the **Sync now** command.
- **Dry run:** command **Dry run**, or the button in settings. It shows what would happen without changing anything.
- **Deletions** go to the vault's **`.trash`** folder (restore it with Obsidian's file explorer or a file manager) and to **Google Drive's trash** (restorable for 30 days).
- **Big deletions:** if a sync would trash more than 20 items (adjustable), it asks first; automatic syncs pause and tell you to tap the sync icon.
- **Sync log:** command **Show sync log**, or **Settings → View log**. It's the first place to look if something seems off; **Copy** puts the whole log on the clipboard.
- **Editing the same note on two devices before syncing** makes it a conflict: both versions are kept untouched and listed in the sync result.

## If something goes wrong

1. Open the **sync log** (filter: warnings and errors).
2. Sign-in problems: see the troubleshooting table in SETUP.md.
3. "The local vault looks empty but was synced before": the plugin refuses to sync because it would otherwise trash everything in Drive. Check you opened the right vault. If you really started over on this device, use **Settings → Reset sync state**: the next sync is then treated as a first sync (dry run first, no deletions).
4. Files with the same name twice in one Drive folder (Drive allows that) are skipped and listed in the log. Rename or delete the extra copy in Drive.
5. Files are restorable from `.trash` (local) and Drive's trash, and you have the backup from the start.
