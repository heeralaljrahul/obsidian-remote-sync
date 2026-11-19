# Project rules for Claude

## The website is the user's guide: keep it in sync with every change

The owner follows the guide on **https://heeralaljrahul.github.io/obsidian-remote-sync/**, not the README files on GitHub. Every change must keep that website correct.

- The site is built from `README.md` (home page), `SETUP.md`, `INSTALL-IOS.md`, `PRIVACY.md`, `SECURITY.md`, `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md` and `callback/index.html` by `.github/workflows/pages.yml` on every push to `main`. Its `verify` job fails if the live site differs from the repository.
- When code changes anything a user sees or does (setting names, buttons, commands, notices, behaviour, versions, steps), **update the guide in the same commit** so the website stays accurate.
- **After pushing, confirm the website updated:** wait for the "Deploy docs site and OAuth callback page" run (including `verify`) to succeed, and check the live page yourself. Tell the owner the website is updated; never only say "README updated".
- Never change `callback/index.html` without updating its CSP `sha256` hash (tests/callback.test.ts checks it).

## Workflow

- Work on `main` (the owner's default branch).
- Before pushing: `npm run lint`, `npm test`, `npm run build` must pass.
- Plugin code must stay iOS-safe: no Node/Electron APIs (enforced by `scripts/check-bundle.mjs` and ESLint).
