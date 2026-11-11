# iPad access

Use LearnHarness from an iPad (or any of your own devices) in Safari, while the desktop app on your Mac does the work. Sessions, the knowledge graph and settings are shared, because there is only one server: the one on the Mac. Model calls, including the [Claude Code](claude-code.md) provider and its subscription login, run on the Mac too.

```
iPad Safari ──HTTPS──▶ tailscale serve (Mac) ──HTTP──▶ 127.0.0.1:<port> LearnHarness server
Mac window  ─────────── localhost, per-launch secret ──▶ same server
```

The server still listens on the Mac's loopback address only. [Tailscale](https://tailscale.com) provides the HTTPS address and a real certificate, and only devices signed in to your tailnet can reach it. Safari needs HTTPS for the microphone (dictation) and for Home Screen web apps to behave normally.

## Requirements

- The desktop app built from this branch (see [Build the app](#build-the-app)). iPad access does not exist in `npm run dev` or in the dev Electron shell.
- Tailscale on the Mac and on the iPad, signed in to the same account.
- The Mac awake with LearnHarness open while you use the iPad.

## Set up

1. On the Mac, open **Settings → General → iPad access** and turn on **Allow iPad access**. Keep the default port unless something else uses it.
2. Quit and reopen LearnHarness. The section then says **Serving on 127.0.0.1:&lt;port&gt;**.
3. In Terminal on the Mac, run the command the section shows, once:

   ```
   tailscale serve --bg 47321
   ```

   It prints an address such as `https://my-mac.tail1234.ts.net`. `--bg` keeps it running across restarts. `tailscale serve status` shows it, and `tailscale serve --https=443 off` removes it. Tailscale may ask you to enable HTTPS certificates for your tailnet the first time.
4. On the Mac, choose **Pair a device**. A 6-digit code appears for 10 minutes.
5. On the iPad, open the `ts.net` address in Safari. It shows **Pair this device**. Choose **Share → Add to Home Screen** now, then open LearnHarness from the Home Screen. A Home Screen web app keeps its own sign-in, separate from Safari, so pair inside it.
6. Enter the code and a name for the device.

The iPad stays paired until you choose **Revoke** next to it on the Mac, or turn iPad access off. Turning it back on restores devices that were not revoked. Each page load renews the device's sign-in for another 400 days.

## Security model

- A paired device has the same access as the Mac window: sessions, graph, settings, provider keys and file tools. Pair only your own devices.
- Pairing codes are single use, expire after 10 minutes, and stop working after 5 wrong guesses.
- The device keeps a random token in a `__Host-` cookie (`HttpOnly`, `Secure`, host-only). The Mac stores only its SHA-256 hash, in `<data>/remote-access.json` (mode 0600).
- Every page from a non-local address is checked before it renders, and goes to the pairing page without a valid cookie. Pages refuse to be framed by other sites.
- Cookie-authenticated API calls must be marked same-origin by the browser (`Sec-Fetch-Site`, Safari 16.4 or later). Other hosts in your tailnet count as the same site, so this check, not SameSite, is what stops them.
- Pairing works only on a `*.ts.net` address (or a name in `LH_ALLOWED_HOSTS`), never through Tailscale Funnel. Do not expose the port with `tailscale funnel`.
- Only the Mac window can turn access on or off, create codes, or revoke devices. A paired device cannot pair other devices.
- **Keep Mac awake** prevents system sleep while access is on. The display can still turn off.

## Limits today

- File attachments from the iPad (photos, PDFs) are not supported yet; the paperclip still inserts Mac file paths only.
- ChatGPT and Copilot sign-in happen in the Mac window. Once signed in, those models also work from the iPad.
- The layout is still the desktop layout. Touch and Pencil improvements are planned.
- Revoking a device or turning access off stops new requests at once, but a live update stream already open on that device continues until it reconnects.

## Build the app

The signed release from upstream does not include iPad access, and it would update itself back to upstream. Build a local copy from this branch on an Apple Silicon Mac:

```
npm ci
npm run plugins:setup
npm run desktop:dist:local
```

This builds an ad-hoc signed app at `dist/mac-arm64/LearnHarness.app` with automatic updates turned off. Move it to Applications, replacing any existing LearnHarness. It uses the same data folder as the release app, so existing sessions and settings carry over. The first launch may need **right-click → Open**, because the app is not notarized.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Settings says to quit and reopen | The port is pinned at launch. Reopen LearnHarness. If it persists, another program uses the port: choose another one, reopen, and run `tailscale serve --bg <new port>`. |
| Safari can't open the `ts.net` address | Tailscale is connected on both devices; `tailscale serve status` on the Mac lists the port; LearnHarness is open. |
| Pairing says no code is active | The code expired, was used, or had 5 wrong guesses. Create a new one. |
| The app shows **Pair this device** again | The device was revoked, iPad access was turned off, or Safari's website data was cleared. Pair again. |
