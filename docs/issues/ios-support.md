# iOS support

Status: deferred. Tracking: [alkval/snarchive#1](https://github.com/alkval/snarchive/issues/1).

Snarchive currently targets Android. An iOS folder-scanner implementation and earlier Swift/JavaScript host checks
exist, but complete native import, preservation, backup and restore are not verified or finished.

## Scope

- Audit the existing iOS implementation and identify unsupported flows.
- Complete ZIP/folder access, exact-byte preservation, permissions, cancellation and interrupted-job recovery.
- Complete portable backup saving, inspection, additive restore, integrity checking, repair and storage management.
- Verify native builds and supported flows with synthetic data on iOS targets.
- Document iOS limitations separately from Android evidence.

## Completion criteria

iOS support should be advertised only after the declared flows pass native build and device/simulator verification,
including original-byte preservation, repeat imports, cancellation/restart, backup round-trip and provider permissions.
No delivery date is committed. This work does not block Android development.
