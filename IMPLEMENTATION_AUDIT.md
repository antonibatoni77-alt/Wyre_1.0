# Wyre implementation audit and execution roadmap

Audit date: 2026-08-05  
Scope: active root app (`src/`) and `scripts/integration-test.ts`; inactive `mobile/` and `my-app/` excluded.  
Method: repository inspection plus `npm test` (typecheck, production builds, integration suite).

## Verification baseline

`npm test` passes. The integration suite exercises auth/account uniqueness, username/phone challenges, TOTP login gating, chats/realtime, drafts/scheduling, mentions, retention, attachments, stories, moderation, groups, channels, settings, sessions, export, QR login and basic calls (`scripts/integration-test.ts:130-517`). This is useful evidence, but several UI-only claims and advanced features are outside the suite.

Project narrative is stale. `AGENTS.md:104-108` and `ARCHITECTURE.md:70-72` still call channels, group administration, stories, settings persistence, scheduling, forwarding/search and admin logic unimplemented, while current code and tests implement those blocks. Update those docs after the next code checkpoint.

## Status by capability

### Done and materially real

- Email OTP/magic-link, Yandex auth, unique account/profile, persistent sessions, username/phone login challenges and phone onboarding: `src/server/core/auth.ts`, `src/server/wyre/index.ts`, `src/server/wyre/profile.ts`.
- TOTP secret encryption and login enforcement: `src/server/wyre/settings.ts:48-91`, `src/server/wyre/profile.ts:109-121`, `src/client/wyre/components/Onboarding.tsx:119-290`; covered by integration tests at `scripts/integration-test.ts:426-461`.
- Direct/group chats, membership roles, messages, drafts, scheduling, search, forwarding, multi-select, mentions, retention, bookmarks and private attachments: `src/server/wyre/chats.ts:467-1246`, `src/client/wyre/components/ChatWindow.tsx:871-1523`.
- Stories: `src/server/wyre/stories.ts`, `src/client/wyre/components/Stories.tsx`; tested at `scripts/integration-test.ts:352-378`.
- Channels with subscription, publishing, views, reactions and comments: `src/server/wyre/channels.ts`, `src/client/wyre/components/ChannelWindow.tsx`; tested at `scripts/integration-test.ts:405-418`.
- Moderation roles, warnings, two fixed badges, bans and audit log: `src/server/wyre/moderation.ts`, `src/client/wyre/components/AdminPanel.tsx`.
- Basic WebRTC calls (maximum four chat members), SDP/ICE, TURN config, screen share, quality/ICE recovery: `src/server/wyre/calls.ts`, `src/client/wyre/calls/useWebRtcCall.ts`, `src/client/wyre/components/CallScreen.tsx`.
- Account-level theme/font and basic setting storage, real session listing/revocation, QR login, TXT/JSON/PDF export endpoints: `src/server/wyre/settings.ts`, `src/server/app.ts:115-124`, `src/client/wyre/components/SettingsScreen.tsx`.

### Partial or misleading and should be finished first

1. **TOTP settings UI is wired incorrectly.** The security-row toggle directly flips `twoFactor`; when changed from false to true, `TotpBlock` receives `enabled=true` and renders the already-enabled/disable branch instead of calling `beginTotp`. Server enforcement itself is complete. Evidence: `SettingsScreen.tsx:181-188, 202-210, 422-438` and `TotpBlock` at `SettingsScreen.tsx:148-163`.
2. **Settings are stored but many have no product effect.** `dnd`, `dndFrom`, `dndTo`, `previews`, `mutedChats`, `blacklist`, `safeMode`, `familyProtection`, and `contentFilter` are merely accepted/stored (`src/server/wyre/db.ts:166-184`, `settings.ts:18-22, 96-106`). No notification delivery, message/privacy guard or content-filter path reads them.
3. **Blacklist UI is demo data, not blocking.** It starts with `"Спам-бот 3021"`, adds generated labels, and stores strings (`SettingsScreen.tsx:174, 350-373`). It is never enforced in people search, direct-chat creation, messages or calls.
4. **Notification per-chat rows are hardcoded names.** `SettingsScreen.tsx:180, 402-410` uses `Wyre News`, `Лера Воронова`, and `Дизайн-команда`; this is disconnected from real chat mute state already stored in `ChatMemberState.muted` and changed by `toggleMuteChat`.
5. **Folders are visual-only.** Every serialized chat is assigned only `['all']` (`src/server/wyre/chats.ts:126,156`), while Work/Family tabs are rendered at `ChatList.tsx:352-363`; no folder collection, assignment or persistence exists.
6. **New-device banner is fabricated.** `ChatList.tsx:221,310-330` always initializes a dismissible `MacBook Pro · Москва · только что` banner and its “Сессии” button merely hides it. It is not derived from `wyreSessions` and does not navigate to devices.
7. **PIN, biometrics and decoy are local/no-op UI.** `pinEnabled`, `pin`, and `decoy` are component state only (`SettingsScreen.tsx:182-185`); biometric keypad returns without action (`:457`), no hashes/credentials or lock gate exist, and decoy promises a demo profile (`:470-477`) without behavior.
8. **Light/dark shortcut is local only.** `Messenger.light` toggles a CSS class and is not account-persisted (`App.tsx:88,139-154`). It overlaps with persisted theme settings and can diverge across reload/devices.
9. **Appearance persistence is mixed.** Theme is correctly stored server-side, but also retained in `localStorage` (`App.tsx:25,265-274`). `autoTheme` persists but no scheduler applies it (`SettingsScreen.tsx:168,200,215,267-272`).
10. **Contacts are actually the global user directory.** `ContactsScreen.tsx:9-65` calls `wyre.searchPeople`; `searchPeople` returns all profiles except self (`chats.ts:609-639`). There is no contact relation/import/sync. The header add-contact button has no click handler (`ContactsScreen.tsx:19-21`), and onboarding’s “close people can find you automatically” phone claim (`Onboarding.tsx:420-424`) has no phone discovery implementation.
11. **Attachment picker exposes disabled promised types.** Folder, location and contact are marked `ready:false`, titled “Скоро”, and show a coming-soon message (`ChatWindow.tsx:454-527`). Photo/video/file are real.
12. **Chat deletion is disabled.** The swipe delete action is `disabled` with title `Скоро` (`ChatList.tsx:142-144`); server has message deletion but no chat deletion/archive method.
13. **Group photo is disabled.** `Modals.tsx:101-104` explicitly says upload will appear later; chat/group schemas contain no avatar path.
14. **GIF/sticker content is prototype emoji data.** `data.ts:185-192` and `ChatWindow.tsx:546-590` send emoji strings as sticker messages; there is no asset/catalog/provider model.
15. **Storage usage and device cleanup are fake/no-op.** The `2.1 GB / 5 GB` meter is static and “Удалить все данные с этого устройства” has no handler (`SettingsScreen.tsx:524-546`).
16. **Export is a limited export, not a complete backup.** `buildExport` limits chats to 500 and messages/owned channel posts to 100,000; exports only a profile subset, chat headers, reduced messages and posts (`settings.ts:123-151`). It omits attachments/media, settings, contacts, stories, channel metadata/comments/reactions/subscriptions, receipts, bookmarks, drafts, scheduled items, calls and restoration. The UI labels JSON as “backup” despite no import/restore (`SettingsScreen.tsx:533-542`).
17. **Admin bans are account-only.** Bans revoke sessions and gate the profile (`moderation.ts:115-143`, `profile.ts:111-121`) but no device fingerprint is collected or banned; a banned person can create another account.
18. **Custom badges are absent.** Only `dev | official` is present across DB, client types and admin controls (`db.ts:14`, `data.ts:3`, `moderation.ts:102-110`, `AdminPanel.tsx:153-159`).
19. **Call extensions are absent.** Call schema/signaling supports only invited chat members, audio/video and SDP/ICE (`db.ts:53-80`, `calls.ts`). Remote control is visibly disabled (`CallScreen.tsx:207-213`). There are no invite links, explicit remote-control consent/control channel, watch party, or whiteboard.
20. **Socket transport contradicts “never polling” docs.** `src/client/lib/api.ts:17` permits Socket.IO polling fallback. This is not application-level periodic data polling, but docs should say websocket-first with transport fallback rather than “polling absent.”

### Not started in active code

Searches found no active models, RPC methods or UI workflows for:

- polls, quizzes, topics/threads, or albums;
- contact cards, static location or live location;
- device approval policies or device fingerprint bans;
- E2E secret chats/key management/key verification/key backup (WebRTC media has browser DTLS-SRTP, but ordinary messages are plaintext in MongoDB via `MessageDocument.text`);
- AI assistant (`GROQ_API_KEY` is parsed only in `src/server/core/env.ts:41` and documented as unused in `CONFIG_REFERENCE.md:190-191`);
- quiet-care workflows or memory albums;
- call invite links, watch party, whiteboard, remote consent/control;
- backup import/restore.

No meaningful `TODO`/`FIXME` markers were found in active code; remaining work is represented primarily by disabled UI, local state, hardcoded data and missing domain models.

## Dependency-aware implementation backlog

### P0 — finish and harden the currently added security/settings slice

1. **Repair TOTP settings flow.** Separate persisted status from “setup panel open”; false→setup must call `beginTotp`, true must show disable. Add UI integration coverage plus five-failure TOTP lock/revocation coverage.
2. **Normalize account settings ownership.** Remove duplicate/local-only theme and light-mode behavior or explicitly define device override versus account preference. Implement `autoTheme`, or remove its working claim until implemented.
3. **Replace demo notification/blacklist data with real IDs.** Use real chat IDs for notification overrides; model blocked user IDs with add/remove RPCs. Enforce blocks in `searchPeople`, `openDirectChat`, `sendMessage`, `startCall`, story visibility and channel comments as specified.
4. **Make session/device UX truthful.** Drive new-device notices from session creation/read state, navigate to the device card, and add approval state only after the policy below exists. Replace fake storage meter with server-computed usage or remove it. Wire or remove device-local cleanup.
5. **Strengthen test coverage around current work.** Add tests for `revokeOtherSessions`, TOTP failure lock, QR login interaction with TOTP, setting update authorization/effect, blacklist enforcement and export authorization/content boundaries.

### P1 — complete core messenger promises before new verticals

6. **Contacts domain.** Add contact relation/import consent and phone-hash discovery; distinguish contacts from global search. Then reuse contact membership in presence privacy, stories and “contacts only” policies.
7. **Folders.** Add account folder definitions and per-chat membership, CRUD/reorder/assignment RPCs, serialization and cross-device persistence. Replace hardcoded `all/work/family` behavior.
8. **Chat lifecycle.** Add direct/group archive/delete/leave semantics, ownership transfer rules, attachment cleanup policy and swipe action wiring. Add group/channel avatar upload using signed storage.
9. **Notifications.** Define server-side event eligibility using DND, previews and per-chat mute. Browser push/background delivery requires its own permission/subscription model; until then label controls as in-app only.
10. **Export/backup v2.** Define canonical versioned JSON, pagination/streaming, media manifest/archive, all owned account data and integrity metadata. Implement authenticated restore with conflict/idempotency rules before calling it backup.

### P2 — structured messaging/media features

11. **Polls and quizzes foundation.** Add typed message payloads, options, immutable voter identity rules, close time/state, quiz answers/explanations, live serialization and tests. Do not overload plaintext `MessageDocument.text`.
12. **Topics/threads.** Decide whether topics belong to groups only; add topic records and message `topicId`, unread/mention counters per topic, permissions and migration for existing messages.
13. **Albums.** Add ordered multi-attachment message payloads, atomic upload finalization, caption/edit/delete rules and grouped rendering.
14. **Contact/location/live location.** Add contact-card snapshot payloads; static coordinates with explicit permission; live-location sessions with expiry, throttling, stop/revoke and audience checks. Never store background location without visible consent.
15. **Real GIF/sticker catalog.** Add persisted sticker packs/assets and a bounded GIF provider/proxy policy, or remove the prototype emoji branding.

### P3 — advanced account security and privacy

16. **App PIN.** Threat-model browser/web limitations first. Store only a slow KDF verifier, implement lock timeout, retry limits and a real client lock gate; do not present it as protecting server data after session theft.
17. **Biometrics/passkeys.** Implement WebAuthn credentials and server challenges; avoid a cosmetic fingerprint button. Decide whether this is login, local unlock, or both.
18. **Device approval.** Add stable session/device records, pending approval, trusted-device management, notification/approval challenge and recovery. QR login must enter the same approval/TOTP policy.
19. **Decoy mode.** Specify safety semantics before code: separate encrypted decoy vault/account, coercion resistance, audit leakage and notification behavior. A “blank demo profile” is not sufficient.
20. **Device fingerprint bans.** Treat fingerprints as a risk signal, not sole identity. Add privacy disclosure, rotation/tamper handling, admin evidence/audit and appeal path; combine with account/IP/rate signals.
21. **Custom badges.** Replace badge enum with badge definitions, assignment records, icon/color validation, ordering and permission/audit rules.

### P4 — extended calls

22. **Invite links.** Add expiring/revocable call-room tokens, capacity/admission controls, preview and abuse limits; decouple room membership from chat membership carefully.
23. **Remote-control consent channel.** Add explicit request/accept/revoke states and prominent indicators. Browser code cannot provide general OS control; this requires a trusted desktop/native helper and platform-specific permission design.
24. **Watch party.** Add shared media source validation, host/participant clock, drift correction, pause/seek authority and rights/privacy constraints.
25. **Whiteboard.** Add call-scoped operation log/snapshots, participant authorization, reconnect replay and export/cleanup.

### P5 — secret chats and encryption

26. **Cryptographic design first.** Define identity keys, prekeys/session setup, forward secrecy, multi-device fan-out, verification, lost-device recovery and metadata boundaries. Obtain specialist review before implementation.
27. **Secret-chat storage/transport.** Store ciphertext envelopes only, move search/link previews/AI/moderation expectations to explicit client-side or unavailable behavior, encrypt attachments and define key deletion/self-destruct semantics.
28. **Migration/UI.** Secret chats should be separate conversations with clear verification and backup limitations; do not imply existing plaintext chats become E2E by toggling a flag.

### P6 — AI and family-care features

29. **AI assistant platform.** Add explicit opt-in, provider boundary, redaction/retention controls, quotas, safety, cancellation and audit. Never send private/E2E content without per-use disclosure and consent.
30. **Quiet care.** Define consented check-ins, trusted-circle escalation, quiet hours, false-positive controls and emergency disclaimers; build on contacts/privacy/location rather than bypassing them.
31. **Memory albums.** Build on albums, contacts and export: ownership, contributors, chronology, captions, private sharing, retention and complete backup.

## Recommended next implementation unit

Start with **P0 items 1, 3 and 5** as one coherent “security/settings truthfulness” increment: fix TOTP setup UI, replace the fake blacklist with enforced user-ID blocks, remove hardcoded notification rows, and add integration tests. It finishes partially added work, closes misleading security UI, and creates primitives required by contacts, stories, calls, device approval and quiet-care privacy.
