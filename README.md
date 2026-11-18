# Google Drive Vault Sync (personal Obsidian plugin)

Two-way sync between an Obsidian vault and a folder in **your own** Google Drive, using **your own** free Google Cloud OAuth client. Works on Windows/macOS/Linux and on Obsidian Mobile for iOS (iPhone and iPad). It isn't published to the community plugin list; install it with BRAT.

> ⚠️ **Back up your vault (and the Drive folder) before the first sync.**
>
> ⚠️ **Don't keep this vault in iCloud at the same time.** If iCloud (or OneDrive, Dropbox, Obsidian Sync…) also syncs this vault, the two sync systems will fight over the same files and you can lose data. On iPhone/iPad, store the vault **On My iPhone/iPad**, not in iCloud Drive.
>
> ⚠️ **No background sync on iOS.** iOS doesn't let plugins run in the background, so syncing happens only while Obsidian is open: when it opens, when you return to it, on an optional interval, or when you tap the sync icon.

## Guides

1. **[SETUP.md](SETUP.md)**: create the Google Cloud project, consent screen ("In production") and OAuth client; host the callback page; full Drive vs privacy mode.
2. **[INSTALL-IOS.md](INSTALL-IOS.md)**: install with BRAT on iPhone, iPad and Windows, and do the first sync safely (backup, dry run, then sync).

## Features

- **Two-way sync** of your existing Drive folder (pick it by name, link or ID), between any number of devices.
- **Sync now** ribbon icon and command; sync when Obsidian opens, when you return to it, and every N minutes (optional).
- **Knows which side changed**: every file is compared with what both sides looked like at the last sync (MD5, size, modified time), instead of "newest timestamp wins".
- **Conflicts are never overwritten**: a note edited on two devices is left untouched on both sides and reported. (A side-by-side conflict view is planned.)
- **Renames** are detected both ways; a local rename moves the Drive file (keeping its ID and revision history).
- **Safe deletions**: always to Obsidian's `.trash` folder or Google Drive's trash, never permanent. The first sync never deletes anything.
- **Dry run**: see planned uploads, downloads, deletions and conflicts without changing anything. It runs automatically before the first sync, which only starts after you approve.
- **Large-deletion guard**: asks before trashing more than 20 items (adjustable).
- **Resumable**: progress is saved after every file, so a sync interrupted by iOS continues safely next time; big uploads (> 5 MB) resume mid-file.
- **Efficient**: incremental updates via Drive's Changes API; paginated listings; exponential backoff on rate limits (403/429).
- **Drive quirks handled**: duplicate names in one folder (identical copies are deduplicated, different ones are skipped and logged, never touched), names that differ only by upper/lower case, Google Docs/Sheets (skipped).
- **Filters**: `.obsidian` ignored by default (optional sync), editable ignore list, file-size limit. The plugin's own folder (with your OAuth tokens) is never synced.
- **Sync log** viewable on the phone, with copy for troubleshooting.
- **Privacy mode** (`drive.file` scope) as an option; see SETUP.md for the tradeoff.
- **iOS-safe**: no Node or Electron APIs; every request uses Obsidian's `requestUrl`, hashing uses Web Crypto / a JS MD5. The build fails if `main.js` would need anything but `obsidian`.

## How a sync works

1. **Drive side:** bring the cached Drive index up to date (Changes API, or a full paginated scan the first time).
2. **Local side:** list the vault and hash only the files whose size or modified time changed.
3. **Plan:** compare each path three ways: local now, Drive now, and the last-synced state:

   | local | Drive | last sync | result |
   |---|---|---|---|
   | changed | unchanged | ✓ | upload |
   | unchanged | changed | ✓ | download |
   | changed | changed | ✓ | conflict (unless identical) |
   | present | present | – | identical: adopt; different: conflict |
   | deleted | unchanged | ✓ | move Drive copy to trash |
   | unchanged | deleted | ✓ | move local copy to `.trash` |
   | deleted | changed | ✓ | restore from Drive (the edit wins) |

4. **Review** if needed (first sync, dry run, many deletions).
5. **Execute** one action at a time. Each step re-checks that nothing changed since planning, and the last-synced state is saved after every file.

Code map: `src/sync/` holds the planner, executor and engine (no Obsidian imports, unit-tested). `src/gdrive/` holds the Drive v3 client, OAuth/PKCE, index and provider. `src/obsidian/` holds the vault access, IndexedDB store, `requestUrl` transport, settings and modals. `callback/` is the GitHub Pages sign-in page.

## Development

```bash
npm ci
```

```bash
npm test
```

```bash
npm run build
```

- `npm test` type-checks and runs the test suite against an in-memory fake of the Google Drive v3 API.
- `npm run build` type-checks, bundles `main.js` and verifies it has no Node/Electron imports.

To try a build on desktop, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/gdrive-vault-sync/`.

### Releasing (for BRAT)

```bash
npm version 0.1.1
```

```bash
git push --follow-tags
```

`npm version` updates `manifest.json` and `versions.json` and creates the tag `0.1.1` (no `v` prefix, as Obsidian and BRAT expect). Pushing the tag runs `.github/workflows/release.yml`, which tests and builds the plugin, checks that the tag matches `manifest.json`, and publishes a GitHub release with `main.js`, `manifest.json` and `styles.css`. Tags with a suffix (e.g. `0.2.0-beta.1`) become pre-releases.

## Credits and license

This project is a fork of [**remotely-sync**](https://github.com/sboesen/remotely-sync) by sboesen, itself a fork of [remotely-save](https://github.com/remotely-save/remotely-save) by fyears. Both are licensed under the Apache License 2.0; thank you to both projects. The fork started from remotely-sync v0.4.49 (commit `21a9e01`).

The Google Drive provider, OAuth flow and three-way sync planner in this repository were written from scratch against Google's public Drive v3 REST API documentation. No code from remotely-save's `pro/` folder or any other paid or differently-licensed code is included. Conflict-handling ideas are inspired by the [GitHub Gitless Sync](https://community.obsidian.md/plugins/github-gitless-sync) plugin (ideas only, no code).

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).

This is not affiliated with Google or Obsidian. Google Drive is a trademark of Google LLC.
