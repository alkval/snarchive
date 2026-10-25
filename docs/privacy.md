# Privacy and permissions

## Stored data

Snarchive keeps preserved originals and its SQLite library in app-private storage. Thumbnails are rebuildable cache
files. Selected exports are read, not edited. Appearance is a device preference outside portable library backups.

A portable backup includes original media and source evidence such as recorded paths, dates, locations and
favourites. It is not encrypted or authenticated against deliberate modification. Protect it as private media.
Choosing a cloud provider in the system save picker gives that provider the resulting document under its own rules.
Uninstalling the app or losing the device can remove the private library.

The application has no account system, analytics service, automatic Snapchat downloads or application backend.
Local import and browsing do not require a server. Dependency networking and all device traffic have not been
comprehensively audited.

## Android permissions

The standalone packaging allowlist contains:

| Permission | Current role |
| --- | --- |
| `INTERNET` | Expo/React Native networking capability; Metro also uses networking in development |
| `ACCESS_NETWORK_STATE` | Dependency network-state support |
| `WAKE_LOCK` | Dependency media playback support |
| `com.alkval.snarchive.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | AndroidX signature-level receiver protection |

This inventory is not proof that each dependency needs every permission in all flows. Internet capability remains.
Broad storage/media, camera, microphone, media-location, vibration and draw-over-other-apps permissions are blocked
in the main configuration. Showing an overlay inside the viewer does not require drawing over other applications.
File and folder access uses Android's system picker and may depend on the selected storage provider.

Standalone builds explicitly disable Android backup, cleartext traffic and Expo updates. The collector checks the
compiled APK rather than relying only on source configuration. Debug builds can permit local Metro traffic and are
outside that standalone policy.

Android's `allowBackup=false` does not establish that manufacturer device-to-device migration is impossible.
Cleartext restrictions are not a general firewall. See the Android documentation for
[Auto Backup](https://developer.android.com/identity/data/autobackup) and
[application manifest settings](https://developer.android.com/guide/topics/manifest/application-element.html).

## Signing and protection limits

Expo's shared template signing key is public. An APK signed with that key and the same package ID can update a
matching installation and inherit its private data. Use template-key APKs only with disposable synthetic data.
See [Android signing](android-builds.md#persistent-signing) for persistent-key builds.

Snarchive currently provides no app lock, additional encryption for the library or backups, or screen-capture/recents
protection. Device security, rooted devices, compromised operating systems, storage-provider behaviour and
manufacturer transfer features are separate concerns. A successful hash check detects byte mismatches; it does not
establish the trustworthiness of a deliberately modified backup.

Use [SECURITY.md](../SECURITY.md) for vulnerability reports. Do not attach personal exports or credentials to public
issues. iOS privacy behaviour remains unverified and [iOS implementation is deferred](issues/ios-support.md).
