# Wyre project instructions

## Product and UI contract

Wyre is a private Russian-language messenger for family and close friends.
The supplied React/Tailwind prototype is approved. Preserve its visual design
and markup: do not redesign or rewrite visual code; add or replace only real
logic, data, auth and event handlers. Read `DESIGN.md` before any UI work and
keep that file synchronized with any genuine design decision.

The active application is the root project under `src/`. The `mobile/` and
`my-app/` directories are inactive legacy scaffolds and are not part of the
root build or TypeScript project.

## Current independent architecture (2026-08-05)

The active Wyre app has no Modelence runtime or package dependency.

```text
src/client/
├── index.tsx                 React entry + QueryClient + Socket.IO connection
├── lib/api.ts                Wyre HTTP/RPC/query/realtime client
├── pages/                    WyrePage and MagicLinkPage
└── wyre/                     approved prototype and real UI wiring

src/server/
├── app.ts                    Express, Socket.IO, RPC, auth routes, Vite/static
├── core/
│   ├── auth.ts               OTP, SMTP, sessions, email uniqueness
│   ├── authDb.ts             users/sessions/OTP Mongo collections
│   ├── database.ts           official MongoDB driver + Store adapter/events
│   ├── env.ts                the only runtime configuration source (`.env`)
│   ├── errors.ts             safe API errors
│   ├── liveData.ts           existing query contract adapter
│   ├── storage.ts            signed private local uploads/downloads
│   └── types.ts
└── wyre/
    ├── index.ts              profile/session queries and mutations
    ├── profile.ts            auth/profile guards shared by chats/calls
    ├── chats.ts              chats, messages, receipts, typing, attachments
    ├── calls.ts              WebRTC call state and signaling
    ├── service.ts            official Wyre/Wyre AI accounts, support, actions messages
    ├── assistant.ts          Wyre AI reply engine (LLM)
    ├── db.ts                 typed Wyre collections and indexes
    ├── emails.ts             branded OTP email
    └── yandexAuth.ts         standalone Yandex OAuth routes

desktop/                       Electron shell for Windows (separate package.json,
                               NSIS installer, tray, autostart, OS remote control)
mobile-android/                Android WebView shell (plain-framework Activity,
                               server URL + SSL trust + biometric-lock settings,
                               FCM background push via native WyreNative bridge,
                               release APK in mobile-android/dist, signed by
                               mobile-android/wyre.keystore)
```

All secrets and runtime settings belong in `.env`; `.env.example` and
`CONFIG_REFERENCE.md` are the source of truth. When adding a setting, update
both. Never add a dashboard-only configuration dependency.

## Authentication rules

- Email login/signup uses Wyre's own 6-digit OTP and magic-link, sent by SMTP.
- OTP is one-use, expires, has a resend cooldown and five-attempt limit; only
  salted hashes are stored in `wyreOtps`.
- Temporary email domains are rejected.
- `wyreUsers.email` and `wyreProfiles.email` are unique. User creation uses an
  atomic MongoDB upsert, so repeated or concurrent registration on one email
  always enters the existing account and never creates a duplicate.
- Sessions are random opaque tokens in `HttpOnly`, `SameSite=Lax` cookies
  (`Secure` in production); only token hashes are stored in `wyreSessions`.
- Existing accounts must pass the server-side username challenge and the phone
  challenge when a phone is bound. Five failures revoke all sessions.
- New profiles remain gated by `phoneOnboardingPending` until the existing
  phone screen either binds a number or explicitly skips; this survives reload.
- Every private data method must call `requireVerifiedProfile(user)`.
- Yandex OAuth uses a 10-minute state cookie, official Yandex endpoints and
  resolves accounts by verified email. Its keys come from `.env`.

## Database and realtime rules

- Use the official MongoDB driver through `src/server/core/database.ts`.
- In development an empty `MONGODB_URI` starts a persistent embedded MongoDB in
  `MONGODB_DATA_DIR`; production must always provide an external `MONGODB_URI`.
- Shared profile helpers stay in `profile.ts` to avoid circular imports.
- Direct chat uniqueness is guaranteed by sparse unique `pairKey`, with
  duplicate-key race recovery in `openDirectChat`.
- Realtime is Socket.IO push, never polling. Store mutations emit
  `wyre:changed`; the client invalidates active TanStack queries and every
  refetch still passes auth/membership guards. Presence-only read touches use
  `updateOneSilent` to avoid an invalidation loop.
- `wyreCallSignals.createdAt` and auth expiry collections use Mongo TTL indexes.

## Existing functional scope

Implemented and must remain real:

- session-driven registration/login/resume/logout;
- Yandex login/signup;
- profile, username history, phone, roles/warnings serialization;
- people search and contacts;
- unique direct chats and group creation;
- live chat list/messages/presence/typing/unread;
- send/edit/delete/reply/react/pin messages and delivery/read receipts;
- pin/mute chats, including real per-chat notification settings;
- persistent user-ID blocks enforced bidirectionally for discovery, direct chats/messages,
  direct calls, stories and channel comments without deleting historical group/content data;
- private photos/files/voice/video-circle attachments up to 50 GB (streamed to disk);
- WebRTC audio/video calls up to four participants, SDP/ICE signaling, adaptive
  bitrate, quality stats, ICE restart, screen sharing and call minimize
  (floating video window / hidden audio while the messenger stays usable);
- official service chats with every user: «Wyre» (support + notifications,
  staff replies and broadcast from the admin panel) and «Wyre AI» (personal
  assistant with inline consent buttons and LLM replies, `AI_ASSISTANT_ENABLED`);
- moderation with timed warnings/bans (days/hours/minutes, auto-expiry via the
  scheduler), warning removal and unban.

The Windows desktop app in `desktop/` (Electron) is a real shell over the web
app: NSIS installer with install-directory choice, tray, close-to-tray,
autostart, Windows toast notifications through the live Socket.IO connection,
offline "last known state" via service worker + persisted query cache, file
logging, and OS-level remote control in calls through optional nut-js (browser
remote control stays available without it; UAC secure desktop blocks injection).

The Android app in `mobile-android/` is a plain-framework WebView shell (no
third-party dependencies except Firebase Messaging): first-run server URL +
self-signed certificate trust screen, camera/mic permissions for calls, system
file picker and download manager, calm offline screen with reconnect, and an
optional biometric/device-credential app lock (settings toggle, idle re-lock).
Background push works through Firebase Cloud Messaging, wired via a native
`WyreNative` bridge that hands the FCM token to the web app and renders
message/call notifications with action buttons (reply / mark read / accept /
decline) — but only when `mobile-android/app/google-services.json` is present;
without it the APK still builds and runs, and push simply stays inactive.
Release APK is signed with the family keystore in the same directory.

Still intentionally unimplemented: advanced account security beyond TOTP and
session controls. Do not claim placeholders work.

## Encryption scope decision (2026-08-17)

End-to-end encrypted "secret chats" are cancelled by product decision and must
not be implemented or advertised. Transport stays TLS/HTTPS, chat history stays
server-side so that search, AI features, sync, export and moderation remain
real, and calls keep WebRTC DTLS-SRTP. Do not describe Wyre as end-to-end
encrypted anywhere in UI or docs.

## Files and deployment

Private attachments are stored below `UPLOAD_DIR` (default `./uploads`), which
must be persistent and backed up in production. Upload/download URLs are signed
and short-lived. Keep paths scoped to `private/wyre-chats/<chatId>/`.

Commands:

```text
npm run dev        standalone Express + Vite dev server
npm run typecheck  TypeScript verification
npm run build      Vite client + bundled Node server
npm start          production server from dist/server/app.mjs
npm test           typecheck + build + HTTPS integration suite
npm run desktop:dev    run the Windows shell from desktop/ sources
npm run desktop:dist   build desktop/dist-app/Wyre-Setup-<version>.exe
npm run android:dist   build mobile-android/dist/Wyre-<version>.apk
```

Do not edit or depend on `.modelence/`; it is obsolete generated output.
