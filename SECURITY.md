# Security policy

## Reporting a vulnerability

Please report it privately through GitHub: the repository's **Security** tab, then **Report a vulnerability**. Do not open a public issue for it.

Include what you found, how to reproduce it, and which version (`package.json`, or Settings in the panel). Expect a first reply within a week.

## Supported versions

Only the latest release. The in-app updater moves an install to the newest `vX.Y.Z` tag, so fixes reach users when they are released.

## Scope

The helper listens only on `127.0.0.1` and checks the extension's origin and a token on every connection; see [the security model](docs/architecture.md#security-model) and [what leaves the machine](docs/privacy.md). Reports about those boundaries, about shell or path injection through anything the panel sends, and about the token's handling are the most useful. Anything that needs an attacker who can already run code as your user is out of scope: that account can read the token and run `claude` directly.
