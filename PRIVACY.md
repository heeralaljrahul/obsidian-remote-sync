# Privacy policy

*Google Drive Vault Sync, an Obsidian plugin by [heeralaljrahul](https://github.com/heeralaljrahul). Last updated: 19 November 2026.*

This is a personal, open-source Obsidian plugin. Its only purpose is to sync your Obsidian vault with a folder in **your own** Google Drive. This page explains exactly what it does with your data.

## Who runs it

There is no company and no server behind this plugin. Each person who uses it creates their **own** Google Cloud project and OAuth client, and the plugin runs entirely inside the Obsidian app on their own devices. The plugin's author does not receive, see, store or process any of your data.

## What data the plugin accesses

- **Your Google Drive files**, only to sync the one folder you choose in the plugin settings: listing that folder, reading, creating, updating, renaming and moving files to the trash inside it. To detect changes quickly it reads Google Drive's change feed and ignores everything outside your chosen folder. If you use **Find by name** it searches your Drive for folders with that name.
- **Your Google account email address**, shown in the plugin settings so you can see which account is signed in.
- **Your Obsidian vault files**, which are read and written on your own device so they match the Drive folder.

## Where data goes

- Your files and your Google sign-in tokens travel **only between your device and Google's servers** (`www.googleapis.com`, `oauth2.googleapis.com`). They are never sent to the plugin's author or to any other server.
- The sign-in page at `https://heeralaljrahul.github.io/obsidian-remote-sync/callback/` is a static web page. It hands the one-time sign-in code from Google back to the Obsidian app on the same device. It does not store, log or send the code anywhere else.

## What is stored, and where

- **On your device only:** your OAuth client ID and secret, your sign-in tokens, the address of your Drive folder, a record of what each file looked like at the last sync, and a sync log for troubleshooting. These live in Obsidian's plugin data and in the app's local storage, and are never uploaded.
- **In your Google Drive:** your vault files, exactly as you sync them.

## What the plugin does not do

- No analytics, tracking, advertising or telemetry.
- No selling or sharing of data with anyone.
- No access to any Google data other than Google Drive and your basic account email.
- No use of your data to train AI or machine-learning models.

## Google API Services User Data Policy

The plugin's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Your control

- **Sign out** in the plugin settings, or remove the app's access at <https://myaccount.google.com/permissions>.
- Uninstall the plugin in Obsidian to delete its local data from that device.
- Your files stay in your own Google Drive and your own vault; nothing else needs to be deleted.

## Contact

Questions about this policy: open an issue at <https://github.com/heeralaljrahul/obsidian-remote-sync/issues>, or see [SECURITY.md](SECURITY.md) for private reports.
