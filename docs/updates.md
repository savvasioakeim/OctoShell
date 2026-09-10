# Updates

OctoShell checks GitHub for a newer release, offers it in a corner card, and —
if you accept — downloads, verifies, installs and restarts itself.

## Your data survives an update

Everything you have lives outside the install folder, keyed by the app's
`identifier`:

| What | Where |
| --- | --- |
| Projects, groups, settings, chats (localStorage) | `%LOCALAPPDATA%\com.octoshell.app\EBWebView` |
| History database | `%APPDATA%\com.octoshell.app\octoshell.db` |
| Mods, push keys, timezone cache | `%APPDATA%\com.octoshell.app\` |

An installer replaces the program, not these. The one change that *would* lose
them is editing `identifier` in `tauri.conf.json` — the new build would look in a
different folder and come up empty. Don't.

## Why updates are signed

An auto-update is "download an executable and run it without asking", so the
download has to be provably ours. Each release is signed with an ed25519 key; the
matching public key is compiled into the app, which refuses any update whose
signature does not verify. This is separate from Windows code signing — we have
no code-signing certificate, so SmartScreen still warns on first install.

The private key's security is the GitHub account's security: anyone who can read
those secrets can sign a release. Use 2FA.

## One-time setup

The keypair does not exist yet. Until it does, `pubkey` in `tauri.conf.json` is
empty and the in-app check will fail (the prompt stays silent; Settings → System
→ Check now reports the error).

1. Generate the pair. Keep the private key somewhere safe — losing it means every
   installed copy stops accepting updates and has to be reinstalled by hand:

   ```
   npm run tauri signer generate -- -w %USERPROFILE%\.tauri\octoshell.key
   ```

2. Copy the **public** key it prints into `src-tauri/tauri.conf.json`:

   ```json
   "plugins": { "updater": { "pubkey": "<public key here>" } }
   ```

3. Add two repository secrets (Settings → Secrets and variables → Actions):

   - `TAURI_SIGNING_PRIVATE_KEY` — the contents of the private key file
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password you chose

4. Bump `version` in `tauri.conf.json`, tag, and push:

   ```
   git tag v0.2.0 && git push origin v0.2.0
   ```

   `release.yml` builds the installer, signs it, and attaches `latest.json`
   alongside it. The release is created as a **draft** — the updater only sees it
   once you publish it.

## What the app does

- Checks on launch and then once a day, while the setting is on.
- "Later" dismisses the card; the next check offers it again.
- "Don't ask again" turns automatic checking off. Settings → System turns it back
  on and can check on demand, so the choice is never one-way.
- A failed background check is silent. A failed manual one says why.
