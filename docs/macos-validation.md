# macOS artifact test: M4, 2026-10-31

Built main at `8535bca` through a manual
[Release workflow run](https://github.com/wulfalpha/textgate/actions/runs/41259404476).
No tag or GitHub release was created. The Apple Silicon job passed, including
its strict bundle-signature verification. The `darwin-aarch64-dmg` workflow
artifact contains `Textgate_0.1.4_aarch64.dmg`.

Test host: M4 (arm64), macOS 27.0.1, build 26A434.

1. Downloaded the artifact with `gh run download`, mounted the DMG read-only,
   and copied Textgate.app to a dedicated temporary directory.
2. `codesign --verify --deep --strict --verbose=2` passed. Signature details
   report an ad-hoc arm64 bundle with no TeamIdentifier.
3. `spctl --assess --type execute --verbose=4` rejected the app (exit 3), as
   expected for this unnotarized build.
4. Added a test `com.apple.quarantine` attribute because command-line downloads
   do not reproduce browser quarantine automatically. An attempted UI launch
   timed out; no blocking dialog was captured, so its exact UI message is unknown.
5. Removed only that temporary app's quarantine attribute using
   `xattr -dr com.apple.quarantine`. Signature verification still passed.
6. Opened the app through Launch Services: the Textgate window, welcome document,
   Live editor and native menus appeared. Closed the test app afterward.

No re-signing, notarization, global Gatekeeper changes, or replacement of the
installed app was performed. This establishes launch after targeted quarantine
removal for this CI-built app on this M4. It does not establish Gatekeeper
acceptance or a full browser-download/copy-to-Applications test. Fresh M1 package
testing and the native file-opening/save smoke tests remain separate checks.

Developer ID signing and notarization are planned for later, after the project
has several release versions. They are not a prerequisite for the current
early-release plan.
