# Changelog

All notable changes to this project. Versions follow [semantic versioning](https://semver.org); the release tag always equals `manifest.json`'s `version` (no `v` prefix).

## 0.1.0 (first release)

- Google Drive provider written from scratch against the Drive v3 REST API: paginated listing, Changes API for incremental syncs, resumable uploads (> 5 MB) that continue after the app is suspended, backoff on 403/429/5xx, Google Docs skipped, duplicate and case-only name clashes handled safely.
- OAuth 2.0 with PKCE and refresh tokens, using your own Google Cloud client; GitHub Pages callback page (with a strict Content-Security-Policy); paste-code and paste-refresh-token fallbacks; sign-in expiry warnings.
- Three-way sync engine (local vs Drive vs last synced state, by MD5/size/modified time), rename detection, resumable and idempotent execution with per-file progress, deletions only to `.trash` / Drive trash, never on a first sync.
- Dry-run review (automatic before the first sync), large-deletion guard, sync log viewer.
- Conflict view: unified diff (side-by-side on desktop) with keep this device / keep Drive / keep both.
- Sync on open, on return, on leave, after editing, on an interval; offline-aware.
- Security hardening: unsafe Drive file names (path traversal) blocked, tokens never logged or sent to other hosts, settings sanitised.
- 190+ automated tests: unit, integration, security, network (including live Google endpoint probes), stress, randomized multi-device fuzzing, end-to-end tests of the built plugin in Chromium.
- Privacy policy page (`PRIVACY.md`, published on the website) for Google's consent-screen Branding requirements.
- Removed upstream's S3, Dropbox, OneDrive and WebDAV providers and Node polyfills (iOS-safe bundle).
