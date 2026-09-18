# Design Style Guide — Wyre

This file is the app's durable design brief. `src/client/index.css` is where
these decisions live as code. Read this file before any UI work and keep it in
sync with `src/client/index.css` whenever a design decision changes.

> **Source of truth:** the design was supplied by the user as an approved React +
> Tailwind prototype and ported verbatim into `src/client/index.css` and
> `src/client/wyre/`. Do **not** redesign, restyle, or "improve" these screens.
> New UI must be assembled from the existing classes and components below.

## Aesthetic Direction

**Liquid glass, dark-first, calm.** Wyre is a private messenger for a close
circle (family, close friends), so the interface has to feel intimate and quiet
rather than corporate. Translucent frosted panels float over a deep, nearly
black background with two large drifting colour orbs; a single violet→blue
gradient carries all accent meaning. Chrome is minimal, typography is tight
(`tracking-[-0.04em]` on headings), and motion is soft and spring-based.

## Color Palette

Colours are CSS variables, not Tailwind theme colours, because themes are
swapped at runtime by writing four variables on `.app-root`.

| Token             | Where             | Meaning                                       |
| ----------------- | ----------------- | --------------------------------------------- |
| `--bg`            | set per theme     | Page background (deep, desaturated)           |
| `--surface-solid` | set per theme     | Opaque surface behind glass                   |
| `--accent1`       | set per theme     | Primary accent (violet by default `#8b5cf6`)  |
| `--accent2`       | set per theme     | Secondary accent (blue by default `#2563eb`)  |
| `--text`          | `.app-root`       | `#f7f8fc` — primary text                      |
| `--muted`         | `.app-root`       | `#8f96a8` — secondary text, hints, timestamps |
| `--line`          | `.app-root`       | `rgba(255,255,255,.09)` — hairline dividers   |
| `--glass`         | `.app-root`       | `rgba(18,21,34,.6)` — standard glass fill     |
| `--glass-heavy`   | `.app-root`       | `rgba(15,17,28,.86)` — modals, menus          |

The 20 themes (10 free + 10 premium with animated gradients) live in
`src/client/wyre/data.ts` as `themes`, each supplying
`{ bg, surface, accent1, accent2 }`. `App.tsx` applies the account's persisted
appearance settings to `.app-root`; there is no separate browser theme owner.
When account auto-theme is enabled, local time selects Midnight (theme 0) from
20:00 through 06:59 and Arctic (theme 6) during the day without rewriting the
account's manually selected theme.

Semantic colours outside the palette: red-400/500 for destructive, amber for
warnings, emerald for success. Both account badges stay circular and use a
small glass highlight: Dev is a violet→indigo disc with a custom `</>` glyph;
Official is a sky→indigo disc with a shield and star. Public warning counts use
the existing amber warning chip and reveal their reasons on click.

## Typography

Chat bubbles wrap unbroken strings inside their existing width and preserve line
breaks. Call security copy describes the protected DTLS-SRTP media channel,
without presenting Wyre as an end-to-end encrypted messenger.

Inter (system fallback stack), `font-synthesis: none`, `optimizeLegibility`.
Headings are semibold with negative tracking (`-0.04em`/`-0.045em`); body copy
is 13–15px with generous line-height (`leading-6`/`leading-7`); metadata is
10–12px in `var(--muted)`. No second display face — the design gets its
character from the glass and gradients, not the font.

## Spacing & Radius

Radii are tokenised and used everywhere instead of ad-hoc Tailwind values:
`--r-xs: 8px`, `--r-sm: 12px`, `--r-md: 16px`, `--r-lg: 22px`, `--r-xl: 28px`,
`--r-pill: 999px`. Elevation: `--shadow-sm/md/lg`. Glass tuning:
`--glass-blur: 26px`, `--glass-sat: 170%`, `--glass-border`, `--glass-specular`.
Screen padding is 20px (`px-5`) on mobile, 32px (`p-8`) on desktop; content
columns cap at `max-w-xl`.

## Motion & Animation

Durations `--dur-fast: 140ms` / `--dur-normal: 240ms` / `--dur-slow: 420ms`,
easing `--ease-standard: cubic-bezier(.16,1,.3,1)` and
`--ease-spring: cubic-bezier(.2,.9,.25,1.2)`.

React animation uses **`motion/react`** with shared helpers in
`src/client/wyre/utils/motion.ts`: `springs`, `easing`, `durations`,
`modalVariants`, `popVariants`, `slideVariants(direction)`, `pageVariants`,
`collapseVariants`, and `layoutIds` (shared-layout ids, e.g. the sliding nav
indicator). Keyframes in CSS: `pulse-dot` (presence), `drift` (background
orbs), `typing-bounce`, `premium-shine` (premium themes).

Rules: page/section changes use `pageVariants` inside
`<AnimatePresence mode="wait">`; menus and popovers use `popVariants`; modals
use `modalVariants`; the active nav pill is a `layoutId` shared element.

Chat drag-and-drop uses the existing heavy-glass surface with a dashed accent
border. Link previews open in a full inset heavy-glass mini-browser; its remote
content stays inside a scriptless sandbox and the chrome always shows the URL,
external-open action and close action.

The approved chat-row swipe rail also carries a blue folder action. It cycles a
chat through Work, both folders, Family and no custom folder while preserving
the existing compact row and the three folder tabs.

## Component Classes

Reuse these instead of inventing new styles: `.glass-surface`
(+`-heavy`, `-pill`), `.glass-panel`, `.glass-input`, `.glass-select`,
`.glass-button`, `.glass-menu`, `.primary-button`, `.settings-row`,
`.section-screen` / `.section-header` / `.eyebrow`, `.messenger`, `.app-nav` /
`.nav-item` / `.nav-active` / `.nav-tooltip`, `.empty-chat`, `.brand-mark`,
`.auth-page` / `.auth-orb` / `.auth-shell` / `.auth-form-side` / `.auth-qr` /
`.auth-divider`, `.yandex-auth-button`, `.toggle`, `.segmented`.

React primitives live in `src/client/wyre/components/Glass.tsx`
(`Avatar`, `Field`, `PrimaryButton`, `Toggle`, `SegmentedControl`, `UserBadge`,
`GlassPanel`). Icons: **lucide-react** only.

## Responsiveness

One codebase, two shells, switched at the `md` breakpoint: desktop gets the
vertical left nav rail plus a two-column chat layout (list + window); mobile
gets the bottom nav bar and a single full-width column where opening a chat
replaces the list.

## Stories Interaction

Stories are data-driven and never ship with example people. The story row is
hidden by default and exists only while the account has unseen stories; a
downward pull at the top of the chat list reveals it, and an upward swipe hides
it. Viewing advances automatically and closes after the final story; an upward
swipe closes the viewer immediately. Story creation stays available from the
existing glass menu even when there are no unseen stories.

Scheduled messages use the existing composer glass capsule: the clock action is
enabled only for non-empty drafts, and pending messages appear as compact rows
above the composer with editable time and cancellation. The server scheduler,
not the browser tab, performs delivery.

Message retention reuses the existing controls instead of adding a new visual
surface. A compact timer selector in the composer applies a read-triggered
self-destruct timer to the next message; the chat overflow action opens the
standard glass modal for shared auto-delete settings. Timed messages show a
small timer icon beside their timestamp.

Typing `@` in the composer opens a compact existing-glass suggestion surface
containing only current chat members. Mentions are marked with the accent colour
inside the conversation, and the normal unread badge gains an `@` prefix while
unread mentions remain; no separate navigation destination is introduced.

HTML attachments keep the message bubble and render in a fixed-height
`sandbox=""` iframe. Scripts, forms and same-origin access stay disabled by
the browser sandbox; the original file remains available through the existing
signed download link below the preview.

Messages containing an `http`/`https` URL use the existing link-preview card.
The server stores a bounded title/description/domain snapshot (Open Graph when
available, deterministic domain fallback otherwise), while the card keeps the
same liquid-glass gradient and opens the original URL in a new tab.
The first open also runs the server-side AI phishing check. Low-risk links open
in the existing sandboxed mini-browser; medium/high risk requires a second
explicit confirmation that includes the bounded reason.

The chat header search action expands the existing compact glass context row;
results are counted and the message list narrows live without changing the
two-column/mobile shell.

The AI assistant glass panel has no header button any more (removed
2026-08-25): it opens only through the message context menu's reminder action.
The memory album lives in the group-management modal; the direct-chat header
keeps only search, calls and the overflow action.

Context reminders and the shared chat note extend the same AI glass panel.
The reminder action starts from the existing message context menu and requires
the user to confirm the proposed text and time. Due reminders and the shared
versioned note stay in the panel instead of creating a separate page.

Background notifications reuse the existing notification settings card: one
`settings-row` with a toggle asks for browser permission explicitly and reports
whether push is configured at all. Account passwords and backup restore reuse
the security and data cards with existing glass inputs, so no new surface is
introduced.

Device moderation extends the existing admin row with one lucide action that
expands an inline glass panel. Device bans and account/device cascade require an
explicit reason, and the panel states plainly that a device record can be shared
by a family and is reset by clearing browser data.

Punishment durations reuse the shared reason modal: a segmented "На срок" /
permanent pair plus three compact number fields (days / hours / minutes).
Active warnings render as amber rows under the user with their remaining time
and a small emerald "снять" action; a timed ban shows its remaining time
inside the existing banned chip.

The admin panel's "Поддержка" tab is the inbox of the official Wyre account:
support threads as ordinary admin rows on the left, the selected conversation
as a light chat column on the right (support replies accent-tinted, the user's
messages on plain glass), with one composer and an "Отправить всем" broadcast
action behind the standard modal.

Avatars replace the initials tile everywhere the existing `Avatar` component is
used: profile, chat list, chat header, contacts, people search and the profile
card. Uploading happens through the existing camera button; group photos use the
same control inside the create-group modal. Photos and videos open in one
full-screen viewer with zoom and download, and long attachments stream with HTTP
Range instead of downloading first. Chat search keeps its compact glass row and
now lists real server results underneath it.

The memory album lives inside the group-management modal only (the chat-header
album action was removed on 2026-08-25): the same panel style lists every photo
and video of that conversation grouped by month, reusing the stored
attachments and their signed URLs. Quiet care lives inside the existing family
card: one toggle plus a threshold select, and pending "not seen for a while"
cards use the same muted row styling. The call control capsule carries
always-on noise suppression with no toggle.

For group chats, the header overflow action opens the standard glass modal for
title/description, member roles, adding/removing people, retention and leaving
the group. Owner/admin affordances are shown inline with compact selects and
icon actions; the server remains the authority for every operation.

Group topics use a compact horizontal row of existing glass pills below the
chat header. The all-messages feed remains the default, unread counts stay on
their topic pill, and closed topics remain readable while the composer is
visually disabled. Topic creation, renaming and closing live in the existing
group-management modal and do not add a separate settings surface.

Requested folder delivery stays inside the normal file flow: the sender uses a
small checkbox in the attachment picker, while the recipient explicitly
accepts or declines from the message bubble before the browser directory picker
opens. Status text reuses message metadata styling.

The call control capsule holds microphone, camera, screen share, remote
control, the group invite link, minimize and hang-up. Watch Party and the
shared whiteboard were removed from the product on 2026-08-25; the call screen
keeps the same layout without their panel.

A joined call no longer replaces the messenger. The control capsule gains one
"Свернуть" action: a video call shrinks into a single draggable floating
window (`.call-mini`, heavy glass, small stage with the primary peer, mic /
expand / hang-up actions in its grab-handle header) while an audio call hides
completely — sound keeps playing either way because the WebRTC engine stays
mounted. While minimized, the chat window shows one emerald `.call-active-bar`
row directly above the pinned-messages bar, and an audio call additionally
keeps a compact `.call-return-pill` in the bottom-left corner of the app. Both
reuse pinned-bar styling and simply return to the full call screen.

Server-authored "actions" messages (the Wyre AI consent) keep the normal
bubble and text, and append a wrapped row of pill buttons under the text. Once
one button is used it stays highlighted with a check while the others dim and
disable — no new surface, no separate dialog.

Remote control uses the same call-control capsule and never starts silently.
Each participant sees an eight-digit per-call code; entering another joined
participant's code creates a blocking consent card on that participant's call
screen. An amber session indicator and red stop action remain visible for both
sides throughout the session, and protected call controls cannot be activated
by the remote pointer.

Channels share the messenger two-column shell: subscribed/discovered channels
appear as ordinary glass rows in the left list, while the right pane renders
owner publishing, post metrics/reactions and a standard modal comment thread.
Channel creation reuses the approved creation modal instead of a placeholder.

Appearance and notification controls hydrate from the account settings record,
so theme/font changes follow the account across devices. The devices card uses
real auth sessions and the existing session-row treatment; remote termination
remains an inline red action and never exposes the opaque session token.

## 2026-08-24 Additions

These follow-up decisions reuse the existing glass language; nothing was
redesigned:

- **Message context menu** gains two conditional rows in the standard
  `.glass-menu`: «Расшифровать» (voice messages without a transcription) and
  «Перевести на русский» (text/link messages without a translation). Inline
  micro-links inside bubbles are gone; the transcription/translation result
  still renders as the existing inset block under the bubble content.
- **Self-destruct timer** in the composer is a custom glass popover
  (`.glass-menu` with checkmark on the active option) opened from a small pill
  that shows `Timer` + `timerLabel()`; the native `<select>` is gone. When a
  timer is armed the pill tints with the accent.
- **Chat header buttons** (2026-08-25 revision): the desktop header keeps only
  search, audio call, video call and the overflow action — the AI assistant and
  memory-album buttons were removed. On phones the header shows back, avatar,
  both call buttons and the overflow action, whose glass menu lists «Поиск в
  чате» plus the group/auto-delete settings entry.
- **People discovery** moved out of the chat list: results render in a
  `.glass-menu` dropdown anchored under the search box (labelled «Люди в
  Wyre»); the list itself shows only chats and channels. The Contacts screen
  lists the peers of existing direct chats — people you have actually written
  to — rather than a global directory.
- **Emoji picker** is grouped into nine category tabs (icon row above the
  grid, `max-h-56` scrollable 8-column grid); sticker packs grew to six and the
  GIF tab keeps animated-emoji loops. Reaction quick-bar still uses the first
  six emojis.
- **Profile access**: in a direct chat the header avatar and name are buttons
  that open the existing `ProfileModal` with a subtle hover accent.
