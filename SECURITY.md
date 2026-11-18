# Security

This is a personal plugin, but it handles access to your Google Drive, so security matters.

## How secrets are handled

- Your OAuth **client ID, client secret and tokens** are typed into the plugin settings and stored only in that device's plugin data (`.obsidian/plugins/gdrive-vault-sync/data.json`). They are never committed to this repository, and the plugin **never syncs its own folder**.
- Tokens are sent only to Google (`oauth2.googleapis.com`, `www.googleapis.com`). They never appear in the sync log or in error messages.
- Sign-in uses OAuth 2.0 with **PKCE** and a random **state** that expires after 15 minutes; the redirect URI must be `https`.
- The callback page (`callback/index.html`) runs only its own script (hash-pinned Content-Security-Policy), stores nothing and sends the code only to Obsidian on the same device.
- File names coming from Drive are validated: names that could escape the vault (`..`, `\`, control characters, characters Obsidian forbids) are skipped, and every local write checks the path again.
- Deletions only move files to the vault's `.trash` or Google Drive's trash.
- `main.js` is checked at build time to contain no Node/Electron APIs, `eval`, `new Function` or raw HTML injection; runtime dependencies are audited in CI.

## If you find a problem

Open a private security advisory on GitHub (Security tab → "Report a vulnerability") or contact the repository owner. Please don't post tokens, client secrets or sync logs containing personal file names in public issues.

## Revoking access

<https://myaccount.google.com/permissions> → your app → **Remove access**, or **Sign out** in the plugin settings.
