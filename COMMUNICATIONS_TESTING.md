# Push and post-delivery SMS verification

Updated 6 November 2026 (America/Los_Angeles).

## Live SMS result

One labeled test SMS using the shared **post-delivery congratulations template** was sent to the user-provided test mobile ending **8523**. The MobileMessage account and approved sender list were checked first. The previous deployment default was not approved; the local backend `.env` default was corrected to the approved **HARMONY** sender, without changing credentials.

| Evidence | Result |
| --- | --- |
| Provider submission ID | `4c74fced-8739-495b-907f-6b2a44c33272` |
| Submission | Accepted, 6 November 2026 at 00:28:28 PST |
| Provider message-history lookup | **delivered**, checked at 00:29:26 PST |
| Test request | `byd-post-delivery-live-test-20261106` |
| Additional customer/deal/delivery records | None created for this test |

The private local test journal lives under `.runtime/live-sms-<request-hash>.json`. Reusing the request ID does not send another SMS. The live test proves provider delivery of the actual congratulations template; actual customer handover/approval is covered separately by regression tests and still requires manager acceptance with the intended site's records.

To read this same message's delivery again, without sending:

```sh
node scripts/test-communications.js --receipt --request-id byd-post-delivery-live-test-20261106
```

The script only sends with explicit `--send-sms --to <approved-test-mobile> --request-id <unique-test-id>` arguments. It uses the configured credentials, checks approved senders and rejects simulation. Do not reuse its test recipient for customer messaging.

## In-app SMS setup and verification

1. A manager selects the intended BYD site and opens **Site settings**.
2. Under **Push and post-delivery SMS setup**, load the provider's actual approved senders, select the site's sender and save settings. The deployment default does not replace an explicitly selected site sender.
3. Configure welcome text, real helpful video links and the optional day-21 survey link. No invented video/survey URLs are supplied. Alphanumeric senders such as HARMONY do not support replies; the fallback satisfaction message directs customers to contact their BYD team.
4. Enter a mobile you control, select a journey template and explicitly send one test SMS. The test is labeled and does not create a fake customer or delivery.
5. Use **Check test SMS delivery**. Submission success is not reported as delivered; only a matching live provider-history result verifies delivery.
6. For real deliveries, handover still creates four dated approval items. Staff explicitly approve due items in **BYD journey**. Client/customer opt-out blocks sending. Each submitted item has **Check SMS delivery** and the actual provider message ID.

## Push implementation and current dependency

Push tokens now record their Expo project, platform and account owner. The server keeps a separate durable delivery record for each notification/device. It distinguishes:

- `submitted`: an Expo ticket was returned.
- `provider_accepted`: an Expo receipt confirms APNs/FCM acceptance.
- `received`: the app acknowledged receipt or opening.
- `failed` / `unknown`: explicit rejection or an uncertain interrupted submission; no automatic blind resend.

The worker checks Expo receipts after 15 minutes. **Check push delivery** can check sooner. Invalid registrations are disabled. New device enrollment does not flood the device with old alerts. Token refresh and app foreground/resume refresh registrations for the same signed-in account. Foreground notifications display banners, and notification taps work after cold launch.

Configure the real Expo project UUID as `EXPO_PUBLIC_EAS_PROJECT_ID` for the app and `EXPO_PROJECT_ID` on the API. Optional `EXPO_ACCESS_TOKEN` supports Expo push security. Supply the Android Firebase file through `GOOGLE_SERVICES_JSON` and configure FCM/APNs credentials in the matching Expo project. `app.config.js` and `eas.json` include emulator/internal-build support without inventing a project ID.

**A real Expo project and push credentials were not supplied. Remote push delivery has therefore not been tested live.** In Expo Go, remote registration is explicitly blocked with a useful message. Local notification display and tap handling can be tested independently.

## Emulator preview

The Android API address is set locally to `http://10.0.2.2:4003/api` in the app's ignored `.env.local`. The API runs on port 4003 with `NODE_ENV=test`, which disables background jobs and automatic push activity for this preview. Metro serves the project on port 8081.

The original Pixel 9 Pro emulator had insufficient space for Expo Go. A disposable data/cache image under `/private/tmp/byd-sales-floor-emulator` is used with the existing Pixel hardware profile; the original virtual-device data is preserved.

Observed in the emulator: Expo Go 58.0.5 installed; the app and development test route loaded; Android notification permission was granted; a scheduled local notification reached the app's receive listener and appeared in Android's notification tray. Screenshots are retained privately under `.runtime/emulator-local-notification.png` and `.runtime/emulator-notification-tray.png`.

The installed emulator 35.6.11 later suffered a QEMU graphics/thread hang and crash during tap testing. Local receipt/display is verified; a stable native notification-tap/cold-launch acceptance test remains outstanding. Recovery attempts with software graphics and reduced resources also stalled; those test processes were stopped to release the AVD lock. The original AVD and the disposable test data are preserved. Metro and the local API remain available, but the emulator is not currently running. Expo Go detection uses the SDK's `isRunningInExpoGo()` API; its local test uses the host's default channel, while native app builds use the dedicated Sales Floor channel.

The existing Expo login was checked for the matching personal `sales-floor-app` project; no match was found. No cloud project or build was created. A matching Expo project and Android Firebase configuration are still required for live remote push, including on an emulator.

In development, `/notification-test` provides a local-only test without staff login. It is unavailable in release builds. **Show test notification** schedules a notification after two seconds and reports when it is received. Its tap/initial-response handling is implemented, but the hardware-emulator failure above prevented completing stable tap acceptance. This is explicitly a local test, not remote delivery evidence. The same local test is also available under **Alerts** after sign-in.

For a native emulator build once the real Expo project is configured:

```sh
npx eas-cli@latest build --profile emulator --platform android
```

Then install the resulting APK and use **Alerts → Enable device push → Send remote push to this device → Check push delivery**. An Android emulator with Google Play services can receive remote notifications with the correct native build and project credentials. Expo Go is used only for the current local preview.

## Primary API references

- [Expo SDK 58 notifications](https://docs.expo.dev/versions/v58.0.0/sdk/notifications/)
- [Expo push tickets and receipts](https://docs.expo.dev/push-notifications/sending-notifications/)
- [MobileMessage API: approved senders and message history](https://mobilemessage.com.au/api-documentation)
