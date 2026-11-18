# Setup: your own Google Cloud project (free)

> **Start with the step-by-step guide in the [README](README.md#complete-setup-guide-step-by-step).** This page explains the Google side in more depth.

This plugin talks to Google Drive with **your own** Google Cloud project and OAuth client, so there is no third-party server and nothing to pay. You do this once; it takes about 15 minutes.

You will end up with three values to type into the plugin settings:

| Value | Where it comes from |
|---|---|
| **Client ID** | Google Cloud → Clients (looks like `1234-abc.apps.googleusercontent.com`) |
| **Client secret** | Same place, shown when you create the client |
| **Redirect URI** | Your GitHub Pages callback page (step 0) |

> These are typed into the plugin's settings on each device and stored only in that device's plugin data (`.obsidian/plugins/gdrive-vault-sync/data.json`). They are never committed to this repository, and the plugin never syncs its own folder. Don't paste them into notes, issues or chats.

Google's console changes its menus from time to time. If a name below doesn't match exactly, look for the closest equivalent: the steps themselves don't change.

---

## Step 0: Host the callback page (GitHub Pages)

Google will not send a sign-in result straight back to an `obsidian://` link for a "Web" OAuth client. So Google sends you to a tiny static page, `callback/index.html` in this repo, which immediately forwards the code to Obsidian (`obsidian://gdrive-sync-auth?...`). The page does nothing else: it stores nothing and sends nothing anywhere.

**GitHub Pages only works for public repositories on a free GitHub account.** Pick one:

### Option A (simplest): make this repository public
Nothing secret is in the repo (your client ID and secret live only in plugin settings).
1. GitHub → this repo → **Settings → General → Danger Zone → Change visibility → Public**. *(Done.)*
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**. Only you can do this; it's a repository setting.
3. *(Done: the page is live.)* If you ever need to redeploy: **Actions** tab (top of the repo) → **Deploy OAuth callback page** → **Run workflow** on `main`. It also redeploys automatically whenever `callback/` changes on `main`.
4. When it finishes, open `https://heeralaljrahul.github.io/obsidian-remote-sync/callback/`. You should see "Nothing to do here". That URL (**with the trailing `/`**) is your **redirect URI**, and it's already the plugin's default.

### Option B: keep this repository private
1. Create a new **public** repository, e.g. `gdrive-callback`.
2. Copy `callback/index.html` into it as `callback/index.html` (or `index.html` at the root).
3. In that repo: **Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save**.
4. Your redirect URI is then `https://heeralaljrahul.github.io/gdrive-callback/callback/` (or `…/gdrive-callback/` if you put it at the root). Type that into the plugin's **Redirect URI** setting.
5. BRAT then also needs a token to read the private plugin repo (see INSTALL-IOS.md).

(A paid GitHub plan also allows Pages on a private repo; the page itself is always public, which is fine.)

---

## Step 1: Create a Google Cloud project

1. Go to <https://console.cloud.google.com/> and sign in with the Google account that owns your Drive.
2. Accept the terms if asked. No billing account or credit card is needed for the Drive API.
3. Top bar → project picker → **New project**. Name it e.g. `Obsidian Drive Sync` → **Create**. Make sure it's selected in the project picker afterwards.

## Step 2: Enable the Google Drive API

1. Menu (☰) → **APIs & Services → Library**.
2. Search **Google Drive API** → open it → **Enable**.

## Step 3: Configure the consent screen ("Google Auth Platform")

1. Menu (☰) → **APIs & Services → OAuth consent screen**. (Newer consoles call this **Google Auth Platform**; click **Get started** if it asks.)
2. **App information**: App name `Obsidian Drive Sync`, User support email = your address → Next.
3. **Audience**: choose **External** → Next. ("Internal" is only possible with a Google Workspace organisation.)
4. **Contact information**: your email → Next → agree to the policy → **Create**.
5. Optional but tidy: **Data access → Add or remove scopes** → add `https://www.googleapis.com/auth/drive` (or `.../auth/drive.file` if you'll use privacy mode) → Update → Save. The plugin requests the scope itself, so this is not strictly required.

### Publish the app to "In production" (important)

1. Go to **Audience** (older consoles: the OAuth consent screen overview).
2. Under **Publishing status: Testing**, click **Publish app** → **Confirm**. The status becomes **In production**.

Why: while an External app is in **Testing**, Google expires its sign-ins (refresh tokens) **7 days** after you approve, so you'd have to sign in again every week on every device. **In production** tokens keep working as long as they're used at least once every 6 months and you don't revoke them.

You do **not** need to submit the app for verification. The Drive scope is a "restricted" scope, so an unverified production app shows a warning screen and is capped at 100 users, which is fine for one person.

> If you published *after* already signing in, sign in again once (or paste a fresh refresh token) so you get a token without the 7-day limit.

### Make sure your sign-in never expires

You don't want to sign in again every week. Here is everything that can end a Google sign-in, and how this setup avoids each:

| What ends a sign-in | Avoided by |
|---|---|
| App left in **Testing**: Google ends it after **7 days** | **Publish app → In production** (above). The status must say *In production*. Then sign in again once, because sign-ins made while in Testing keep their 7-day limit. |
| Not used for **6 months** | Every sync uses it. Just open Obsidian on each device at least once every 6 months. |
| You remove access at myaccount.google.com/permissions, or press **Sign out** in the plugin | Don't 🙂 |
| You delete or reset the OAuth client's **secret**, or delete the client/project | Keep the client; if you add a new secret, enter it on every device. |
| Too many sign-ins: Google keeps at most about 100 per app per account and silently drops the oldest | Sign in once per device (or once on the PC and paste the refresh token on the others). |

How to check: **Settings → Google account** shows *"No expiry"* when Google didn't attach an expiry date to your sign-in. If Google ever announces one, the plugin shows a warning there and at the next sync, with the expiry date. There is no hidden trick that makes a "Testing" app's sign-in last longer than 7 days; publishing to production is the supported way, it's free, and it doesn't require Google's verification for personal use.

## Step 4: Create the OAuth client

1. **Clients** (or **APIs & Services → Credentials → Create credentials → OAuth client ID**).
2. **Application type: Web application**. Name: `Obsidian`.
3. **Authorized redirect URIs → Add URI** → paste your redirect URI from step 0 **exactly**, including `https://` and the trailing `/`:
   `https://heeralaljrahul.github.io/obsidian-remote-sync/callback/`
4. Leave "Authorized JavaScript origins" empty → **Create**.
5. Copy the **Client ID** and **Client secret** into a password manager right away. Google may show the secret only once; if you lose it, open the client and **Add secret** to make a new one.

Why "Web application"? Google's "iOS" and "Desktop" client types can't redirect to `obsidian://`, and the Web type is the one that works with the callback page on both Windows and iPhone/iPad. (It needs the client secret, which is why you type it into the plugin.)

## Step 5: Enter the values in the plugin and sign in

In Obsidian: **Settings → Google Drive Vault Sync**.

1. **OAuth client ID** and **OAuth client secret**: paste them.
2. **Redirect URI**: leave the default, or paste yours if you used Option B.
3. **Permission scope**: see the next section. Default is full Drive.
4. **Sign in with Google**. Your browser opens Google:
   - Pick your account.
   - You'll see **"Google hasn't verified this app"**. This is expected: it's *your* app, used only by you. Click **Advanced → Go to Obsidian Drive Sync (unsafe)**.
   - On the permissions screen, **tick the Google Drive checkbox** ("See, edit, create and delete all of your Google Drive files"). If you leave it unticked the plugin will tell you and ask you to sign in again.
   - **Continue**. The callback page opens and asks to open Obsidian → **Open**.
5. The settings now say **Signed in as you@gmail.com**.

If the browser doesn't jump back to Obsidian, the callback page shows the code: copy it into **Paste authorization code** (same device, within a few minutes).

**Phone shortcut:** sign in on your PC, press **Copy refresh token**, send it to your phone in a private way (e.g. a password manager's secure note; not email or chat), and paste it into **Paste refresh token** on the phone. Use the same client ID and secret on every device.

## Step 6: Pick the Drive folder

**Settings → Drive vault folder**:
- Paste the folder's link (`https://drive.google.com/drive/folders/<ID>`) or ID → **Use ID**, or
- type its name → **Find by name** → pick the right one (it shows the ID and dates in case you have several with the same name).

Use the **same folder on every device**.

---

## Full Drive access vs privacy mode

| | **Full Drive** (`drive`, default) | **Privacy mode** (`drive.file`) |
|---|---|---|
| Works with the vault folder you already uploaded to Drive | ✅ Yes | ❌ No: the plugin can't see files it didn't create |
| What the plugin could technically access | Your whole Drive (it only ever reads/writes inside the chosen folder) | Only files and folders it created itself |
| Setup | Pick your existing folder | **Create a new vault folder** in settings, then do the first sync **from your PC** so it uploads the whole vault; then pick that same folder on your phone and iPad |
| Google's consent screen | "See, edit, create and delete all of your Google Drive files" | "See, edit, create and delete only the specific Google Drive files you use with this app" |

Because your vault folder already exists in Drive (uploaded outside this plugin), **use Full Drive**. Privacy mode is for starting fresh with a folder the plugin owns. Changing the scope requires signing in again.

What the plugin actually does with full access: it lists and changes files **only inside the folder you selected**, plus a name search when you use **Find by name**. For fast incremental syncs it reads Drive's change feed, which reports changes from your whole Drive; the plugin keeps only the entries inside your vault folder and discards the rest. Deletions go to Drive's **trash**, never permanently. The code is in `src/gdrive/` if you want to check.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `redirect_uri_mismatch` on Google's page | The redirect URI in the plugin and in the OAuth client must match character for character, including the trailing `/`. |
| Callback page shows 404 | GitHub Pages isn't deployed yet (step 0), or the repo is private on a free plan. |
| "Google rejected the saved sign-in (expired or revoked)" every week | The app is still in **Testing**. Publish it (step 3) and sign in again once. |
| "Your sign-in expires in N days" | Same: publish the app to **In production**, then **Sign out** and **Sign in with Google** again. |
| "Google Drive access was not granted" | Tick the Drive checkbox on Google's permission screen. |
| "Folder not found with the current permission scope" | In privacy mode the plugin can't see folders it didn't create. Use Full Drive, or create the folder from the plugin. |
| `access_denied` / "app is blocked" | Check you're signing in with the same Google account that owns the project, and that the app is published. |
| Want to revoke access | <https://myaccount.google.com/permissions> → Obsidian Drive Sync → Remove access. Or **Sign out** in the plugin. |
