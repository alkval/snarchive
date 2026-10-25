# Security

Snarchive handles private media and treats selected archives, metadata and backups as untrusted input. The project
is pre-1.0 and has not completed an independent security audit.

## Reporting a vulnerability

Use GitHub's **Security → Report a vulnerability** feature for private reports when it is available. If private
reporting is unavailable, open an issue requesting a private reporting channel without including exploit details
or private data. Do not post personal exports, images, location metadata, credentials, signing keys or signed URLs.

Include the affected version, platform, reproduction steps using synthetic data, expected impact and any proposed
fix. Distinguish source inspection from an actually reproduced failure.

## Current boundaries

- Original files and the database are stored in app-private storage.
- Portable backups are not encrypted or authenticated against deliberate modification.
- No app lock, additional library encryption or screen-capture protection is provided.
- The Android build retains Internet capability. Dependency networking has not been comprehensively audited.
- Shared-template-key APKs are unsuitable for installations containing real data.
- Rooted devices, compromised operating systems and all manufacturer migration behaviour are outside the verified scope.

The application applies archive, byte, manifest and path checks, but these do not guarantee support for every export
or provider. See [privacy](docs/privacy.md), [testing](docs/testing.md) and the [backup format](docs/backup-format.md).

## Dependencies and releases

Dependency advisories still require assessment. Do not treat a successful build or packaging check as a completed
security review. Use the current source tree when investigating reports; no long-term-support release policy has
been established.
