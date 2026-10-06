# Privacy policy

Effective 2026-10-06. This policy covers admobctl: the command-line tool, its MCP server, and the Claude Code and Codex
plugin.

admobctl is open-source software that runs entirely on your computer. Its author runs no servers for it and does not
collect, receive, store or sell any data about you or your AdMob account. admobctl has no telemetry, analytics or crash
reporting.

## What admobctl accesses

- **Your Google credentials.** admobctl signs in with gcloud Application Default Credentials or with your own OAuth
  client. OAuth tokens are kept in the macOS Keychain, or on other systems in `~/.admobctl/credentials-<profile>.json`,
  readable only by you. They are sent only to Google.
- **Your AdMob, AdSense and Google Cloud data**, read through Google's APIs with those credentials. Write commands
  change your AdMob account or Google Cloud project only when you run them with `--yes`.

## Where data goes

admobctl sends requests only to:

- **Google:** the AdMob API, the AdSense Management API, the Cloud Resource Manager and Service Usage APIs, and Google's
  OAuth endpoints. [Google's privacy policy](https://policies.google.com/privacy) applies to those requests.
- **Apple and your apps' websites**, only when you run the app-ads.txt check: Apple's iTunes lookup API receives your
  apps' App Store IDs, and each app's developer website receives a request for `/app-ads.txt`.

When you use the MCP server or the plugin, the tool results, which contain your AdMob data, go to the AI assistant that
called the tool. That assistant's provider handles them under its own terms.

## What admobctl stores on your computer

In `~/.admobctl/` (or the folder in `ADMOBCTL_HOME`), readable only by you: `config.json` (settings, no secrets),
`audit.log` (one line for each change a write command applied) and, on systems other than macOS, your OAuth
credentials. `admobctl auth logout` removes the stored OAuth credentials and revokes them at Google. Deleting the folder
removes everything else.

## Changes and questions

Changes to this policy are made in this file, so its history is in the repository. Ask questions in
[GitHub Issues](https://github.com/Strangees/admobctl/issues), and report security problems as described in
[SECURITY.md](SECURITY.md).
