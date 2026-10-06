# admobctl plugin for Claude and Codex

Ask Claude or Codex about your Google AdMob account: earnings per app or month, eCPM, fill and show rates, weak ad
units, SDK and consent problems, mediation waterfalls and app-ads.txt. The plugin runs the admobctl MCP server on your
computer and adds three skills that pick the right tool, prepare monthly bookkeeping and analyze monetization.

> **Unofficial.** admobctl is not affiliated with, endorsed by, or sponsored by Google. "AdMob" is a trademark of
> Google LLC.

## What you get

- **A read-only MCP server** with 25 tools: accounts, apps and ad units; network, mediation and campaign reports;
  monthly finance (estimates), forecast, journal export and unpaid balance; insights, a daily check, lint, version,
  consent, geo, trend and waterfall analyses; ad sources and mediation groups; the app-ads.txt check; and a setup
  status check. None of them changes your account.
- **Three skills:** `admobctl` (which tool answers what, sign-in help, command reference), `admobctl-finance` (monthly
  close, estimate versus finalized, journal rows) and `admobctl-insights` (how to analyze and present findings).

Try: *"What did my AdMob apps earn last month, per app?"*, *"Which ad units are underperforming, and why?"* or
*"Is my app-ads.txt set up correctly?"*

## Requirements

- Node.js 20 or later. The server is one prebuilt file, so installing the plugin downloads no packages.
- A Google sign-in with access to your AdMob account, set up once with the admobctl command-line tool. See
  [Install](https://github.com/Strangees/admobctl#install) and
  [Authenticate](https://github.com/Strangees/admobctl#authenticate). When something is missing, the
  `admobctl_setup_status` tool names the exact command to run.

## Data and privacy

admobctl runs on your computer. It has no server of its own and no telemetry, and it sends nothing to its author or
any other third party. [PRIVACY.md](https://github.com/Strangees/admobctl/blob/main/PRIVACY.md) is the full
policy.

It connects only to:

- **Google APIs, with your own credentials:** the AdMob API (`admob.googleapis.com`) for account data and reports, and
  for changes only when you run a write command with `--yes`; the AdSense Management API (`adsense.googleapis.com`)
  for `finance balance`; Cloud Resource Manager and Service Usage (`cloudresourcemanager.googleapis.com`,
  `serviceusage.googleapis.com`) for `setup` and `setup status`, which find your projects and check or enable APIs;
  and Google OAuth (`accounts.google.com`, `oauth2.googleapis.com`) to sign in, refresh and check tokens, and revoke
  them on logout.
- **For the app-ads.txt check only:** Apple's iTunes lookup API (`itunes.apple.com`), which receives your apps' App
  Store IDs, and each app's developer website, which receives a request for `/app-ads.txt`.

It runs `gcloud` to get an access token from Application Default Credentials and for `setup login`, `security` on macOS
to keep OAuth tokens in the Keychain, and your system's browser opener for the OAuth sign-in, which then listens on a
`127.0.0.1` port for Google's redirect. It writes only to `~/.admobctl/` (or `ADMOBCTL_HOME`): the config, an audit
log of applied writes and, on systems other than macOS, OAuth credentials, all readable only by you. The one exception
is a file you name with `--out` (`finance export`, `mediation-groups export`).

Through the MCP server, tool results (your AdMob data) go to the AI assistant that called the tool, under that
assistant's own terms.

## License

MIT. Source code, issues and the full documentation:
[github.com/Strangees/admobctl](https://github.com/Strangees/admobctl).
