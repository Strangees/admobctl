# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/Strangees/admobctl/security/advisories/new)
(**Security → Report a vulnerability**). Please do not open a public issue.

Include the admobctl version (`admobctl --version`), what an attacker could do, and the steps to reproduce. Leave out
your real publisher ID, app IDs, earnings and tokens: placeholders such as `pub-0000000000000001` are enough.

Fixes ship in a new release, and the advisory is published once that release is out.

## Supported versions

Only the latest release gets security fixes.

## Scope

admobctl runs on your machine with your Google credentials, so these are in scope:

- **Credentials:** the OAuth login (loopback and PKCE), refresh tokens in the macOS Keychain or in a `0600` file in
  `~/.admobctl/`, and access tokens obtained from gcloud. Any way for a token to leak into logs, output, files or
  process arguments.
- **Commands that change things:** anything that changes an AdMob account (write commands) or a Google Cloud project
  (`setup`) without `--yes`, or does something other than what the dry run printed.
- **The MCP server:** any way for an MCP client to change the account (the server is read-only), or to read local
  files.
- **Files admobctl writes** (config, audit log, `--out` exports) ending up readable by other users.

Google's APIs and the access control of AdMob accounts themselves are out of scope.
