# Pocket Modular

A modular synth for your phone that teaches you to build it. Start with an empty rack and work through guided lessons, from your first oscillator to sequencing.

## Get it

- **Android app (APK):** [download the latest build](../../releases/latest/download/PocketModular.apk). Open it on your phone to install, or to update an earlier install.
- **Web app:** published to GitHub Pages from the `web/` folder. Open it in Chrome on Android and choose *Install app*.

Every push to `main` rebuilds both automatically (see `.github/workflows/build.yml`).

## Layout

| Path | What it is |
| --- | --- |
| `web/index.html` | The app: UI, lessons and patching |
| `web/engine.js` | Audio engine, runs on the audio thread as an AudioWorklet |
| `web/sw.js`, `web/manifest.webmanifest` | Offline support and install settings for the web version |
| `android-res/` | Launcher icons copied into the Android build |
| `capacitor.config.json` | Wraps `web/` as an Android app with Capacitor |

## Signing

`signing/keystore.enc` is the app's signing key, encrypted. The build decrypts it with the `KEYSTORE_PASSWORD` repository secret, so every APK is signed with the same key and installs over the previous one without losing patches.
