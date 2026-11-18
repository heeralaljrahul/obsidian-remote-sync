# Google Drive Vault Sync (personal Obsidian plugin)

Two-way sync between an Obsidian vault and a folder in **your own** Google Drive, using **your own** Google Cloud OAuth client. Works on Windows/macOS/Linux and on Obsidian Mobile for iOS (iPhone, iPad). Not published to the community plugin list; install it with BRAT.

> ⚠️ **Back up your vault before the first sync.**
>
> ⚠️ **Do not also keep this vault in iCloud Drive (or any other sync service).** Two sync systems working on the same files will fight each other and can lose data. On iOS, store the vault "On My iPhone/iPad", not in iCloud.

Sync only runs while Obsidian is open. iOS does not allow plugins to sync in the background.

Setup and install guides: `SETUP.md` and `INSTALL-IOS.md` (coming in a later phase).

## How it works (short version)

- A three-way planner compares each file in the vault and in Drive with what both looked like at the last sync (MD5, size, modified time), so it knows *which* side changed instead of guessing from timestamps.
- Files edited on both sides are reported as conflicts and left untouched (a conflict view is planned).
- Deletions go to Obsidian's `.trash` folder locally and Drive's trash remotely: never permanent. The first sync never deletes anything.
- Progress is saved after every file, so a sync interrupted by iOS continues safely next time.
- Incremental updates use the Drive Changes API; large files (> 5 MB) use resumable uploads.
- All network calls use Obsidian's `requestUrl`; there are no Node/Electron APIs, so it runs on iOS.

## Credits and license

This project is a fork of [**remotely-sync**](https://github.com/sboesen/remotely-sync) by sboesen, itself a fork of [remotely-save](https://github.com/remotely-save/remotely-save) by fyears, both licensed under the Apache License 2.0. The fork started from remotely-sync v0.4.49 (commit `21a9e01`). The Google Drive provider and the three-way sync planner in this repository were written from scratch against the public Google Drive v3 REST API; no code from remotely-save's `pro/` folder or any other differently-licensed code is included. Conflict-handling ideas are inspired by the GitHub Gitless Sync plugin (ideas only, no code).

Licensed under the Apache License 2.0; see [LICENSE](LICENSE).
