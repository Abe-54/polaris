# Android composer image paste

The `PolarisPaste` Expo module has the same API on Android and iOS:
`watch(fieldId)`, `unwatch(fieldId)` (reference counted), and `onPaste` events
whose `json` contains `{fieldId, images: [{uri, name, mimeType, size}]}`.
There are no width/height fields in the iOS report.

Android observes the current Activity's layout while fields are watched, locates
`ReactEditText` by React Native `nativeID`, and replaces listeners when inputs
remount. Backgrounding, unwatching and module destruction remove listeners;
foregrounding restores them. Missing Activities are retried until available.

`ReactEditText` extends `AppCompatEditText`: its receive-content integration
handles both Paste / Paste as plain text and IME image insertion, including on
API 24-30 through AndroidX. The focused input's keyboard connection is restarted
when accepted MIME types change, so a keyboard already open learns `image/*`.
Image URI streams are opened before returning from the content listener, while
temporary clipboard / IME permissions are valid, and copied on a worker thread.
PNG/JPEG bytes are retained; other decodable images become PNG if transparent,
otherwise JPEG (quality 90), matching iOS. Text and unhandled items go back to
the default handler, including text accompanying an image in the same clip item.

The installed Android SDK 30, 32 and 36 `TextView.canPaste()` implementations
check `hasPrimaryClip()`, not whether the clip contains text. Therefore an
editable, focused input with a valid selection should offer Paste for an
image-only clipboard. No reflection or custom menu override is installed.
An OEM that suppresses its insertion menu still needs device investigation.

## Build verification

From `apps/mobile/android`:

```sh
./gradlew.bat projects --console=plain
./gradlew.bat :polaris-paste:compileReleaseKotlin --console=plain
```

From `apps/mobile`:

```sh
bun test src/composer/paste.test.ts
bun run typecheck
```

No app.json plugin, app manifest change, storage permission or FileProvider is
required. Rebuild the native app to include the autolinked module; refreshing
Metro alone cannot add it. Gradle discovers `:polaris-paste` directly.

## Orchestrator device checks

Device interaction is reserved for the orchestrator. Example preparation:

```sh
adb push paste-test.png /sdcard/Download/paste-test.png
adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/paste-test.png
```

1. With Chrome installed, open an image URL (or the copied local image in an app
   that offers **Copy image**). Long-press the image and choose **Copy image**.
   Copying a file in Files normally copies a file reference, not an image clip.
2. Open a Polaris session with attachments enabled. Tap the empty composer,
   long-press, choose **Paste**. Expect one image attachment, with no content URI
   inserted into the text. Repeat with existing composer text and a selection.
3. Copy ordinary text and paste it. Expect unchanged default text insertion.
4. Enable Gboard; focus the composer before copying an image or screenshot.
   Use Gboard's clipboard image tile or sticker picker. Expect one attachment.
   This also checks MIME negotiation when the keyboard was already open.
5. Paste PNG, JPEG, and an available WebP/GIF sticker. Check the attachment can
   be sent and displayed, and unsupported/unreadable items do not crash.
6. Navigate away/back, background/foreground, rotate, and repeat in two distinct
   composers. Each paste should attach once, only to the destination composer.
   Disable attachments: ordinary text paste must still work.
7. Check API 24-30 and API 31+ separately if both emulator images are available;
   clipboard menu and temporary URI grants require real device verification.

For a debuggable install, inspect staged files after pasting:

```sh
adb shell run-as dev.lux.polaris.mobile ls -l cache/polaris-paste
```
