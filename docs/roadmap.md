# Roadmap

Android import, private original storage, overlay viewing, continuous browsing, backup/restore, integrity repair and
storage cleanup are implemented. Remaining work focuses on broader validation and distribution, not a sequence of
internal development sections.

## Android compatibility and quality

- Expand physical-device and storage-provider coverage.
- Exercise the latest viewer and timeline with TalkBack, large text, orientation changes and mixed video libraries.
- Measure large-library media decoding, memory use and real-hardware frame timing.
- Directly verify the in-place archive path and large ZIP64 cases on Android.
- Continue testing interruption, permission loss and filesystem-specific durability behaviour.

## Distribution and maintenance

- Assess dependency advisories and complete transitive license review.
- Establish authenticated release signing, provenance and a documented binary distribution process.
- Evaluate reproducible builds and maintain a supported-device/provider matrix.
- Consider automated build/update delivery as a separate feature with a defined trust model.

## Privacy

App lock, additional storage/backup encryption and screen-capture protection are not implemented. Each needs its own
requirements and verification; device authentication alone would not encrypt the library.

## iOS

[iOS support](issues/ios-support.md) is deferred and tracked in
[issue #1](https://github.com/alkval/snarchive/issues/1). Native ZIP/folder preservation, backup/restore and platform
verification are required before advertising iOS support. Android improvements can proceed independently.
