import { type CSSProperties, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { PhoneCall } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { callMethod, wyreMutation, wyreLiveQuery, wyreQuery } from "../lib/api";
import { cn } from "./utils/cn";
import { pageVariants } from "./utils/motion";
import { getWyreNative } from "./utils/native";
import type { Chat, ModalKind, Section } from "./data";
import { themes } from "./data";
import { Navigation } from "./components/Navigation";
import { Onboarding } from "./components/Onboarding";
import { ChatList } from "./components/ChatList";
import { ChatWindow } from "./components/ChatWindow";
import { ChannelWindow } from "./components/ChannelWindow";
import { ContactsScreen } from "./components/ContactsScreen";
import { SettingsScreen } from "./components/SettingsScreen";
import { AccountScreen } from "./components/AccountScreen";
import { CallScreen } from "./components/CallScreen";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { IncomingCall } from "./components/IncomingCall";
import type { CallState } from "./calls/types";
import { CreationModal } from "./components/Modals";
import { ProfileModal } from "./components/ProfileModal";
import { AdminPanel } from "./components/AdminPanel";
import { useWyreSession, type WyreProfile } from "./session";
import { discardPreparedCallMedia, prepareCallMedia } from "./utils/mediaPermissions";

const AUTO_THEME_DAY_ID = 6;
const AUTO_THEME_NIGHT_ID = 0;

function automaticThemeId(now = new Date()) {
  const hour = now.getHours();
  return hour >= 20 || hour < 7 ? AUTO_THEME_NIGHT_ID : AUTO_THEME_DAY_ID;
}

function EmptyChat() {
  return (
    <section className="empty-chat hidden md:grid">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="text-center">
        <div className="brand-mark mx-auto grid h-16 w-16 place-items-center rounded-[22px]">
          <svg viewBox="0 0 36 36" aria-hidden="true" className="h-8 w-8 p-0.5">
            <path d="M6 10l5 17 7-11 7 11 5-17" fill="none" stroke="white" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.2" />
          </svg>
        </div>
        <h2 className="mt-5 text-lg font-semibold">Ваши сообщения рядом</h2>
        <p className="mt-2 text-sm text-[var(--muted)]">Выберите чат, чтобы начать разговор</p>
      </motion.div>
    </section>
  );
}

function Splash() {
  return (
    <div className="grid h-full w-full place-items-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="text-center"
      >
        <div className="brand-mark mx-auto grid h-16 w-16 place-items-center rounded-[22px]">
          <svg viewBox="0 0 36 36" aria-hidden="true" className="h-8 w-8 p-0.5">
            <path d="M6 10l5 17 7-11 7 11 5-17" fill="none" stroke="white" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.2" />
          </svg>
        </div>
        <p className="mt-5 text-sm text-[var(--muted)]">Загружаем Wyre…</p>
      </motion.div>
    </div>
  );
}

function Messenger({
  themeId,
  onTheme,
  profile,
  onProfileChange,
}: {
  themeId: number;
  onTheme: (id: number) => void;
  profile: WyreProfile;
  onProfileChange: () => void;
}) {
  const [section, setSection] = useState<Section>("chats");
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const [profileUserId, setProfileUserId] = useState<string | null>(null);

  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const queryClient = useQueryClient();

  // Notification clicks (web push and the desktop shell) arrive as /?chat=<id>.
  useEffect(() => {
    const url = new URL(window.location.href);
    const chatParam = url.searchParams.get("chat");
    if (!chatParam) return;
    url.searchParams.delete("chat");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    let done = false;
    const tryOpen = () => {
      if (done) return;
      const chats = queryClient.getQueryCache().find({ queryKey: ["wyre", "wyre.listChats", {}] })?.state.data as Chat[] | undefined;
      const target = chats?.find((chat) => chat.id === chatParam);
      if (target) {
        done = true;
        setSection("chats");
        setSelectedChannel(null);
        setSelectedChat(target);
        stopWatching();
      }
    };
    const unsubscribe = queryClient.getQueryCache().subscribe(tryOpen);
    const timeout = window.setTimeout(stopWatching, 30_000);
    function stopWatching() {
      done = true;
      window.clearTimeout(timeout);
      unsubscribe();
    }
    tryOpen();
    return stopWatching;
  }, [queryClient]);

  const isAdmin = profile.role !== "user";
  const { mutateAsync: openDirectChat } = useMutation(wyreMutation("wyre.openDirectChat"));

  // Android shell: hand over the push-action token (notification buttons) and
  // register the shell's FCM token so background push reaches this account.
  useEffect(() => {
    const native = getWyreNative();
    if (!native) return;
    let cancelled = false;
    void (async () => {
      try {
        const { token } = await callMethod("wyre.createPushActionToken", {}) as { token: string };
        if (!cancelled) native.setPushActionToken(token);
      } catch {
        // Notification actions stay unavailable — never blocks the app.
      }
    })();
    const host = window as unknown as { __wyreFcmToken?: (token: string) => void };
    host.__wyreFcmToken = (token: string) => {
      void callMethod("wyre.registerFcmToken", { token, platform: "android" }).catch(() => undefined);
    };
    native.requestFcmToken();
    return () => {
      cancelled = true;
      delete host.__wyreFcmToken;
    };
  }, []);

  // Result of the Yandex ID linking redirect: refresh the auth-status card and
  // tell the user what happened instead of silently keeping the old button.
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const linked = url.searchParams.get("yandexLinked");
    const authError = url.searchParams.get("authError");
    if (!linked && !authError) return;
    url.searchParams.delete("yandexLinked");
    url.searchParams.delete("authError");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    void queryClient.invalidateQueries({ queryKey: ["wyre", "wyre.accountAuthStatus"] });
    setLinkNotice(linked ? "Yandex ID привязан к вашему аккаунту" : `Не удалось привязать Yandex ID: ${authError}`);
    const timer = window.setTimeout(() => setLinkNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [queryClient]);

  // Live view of the single call this user is currently part of (ringing or active).
  const { data: call } = useQuery(wyreLiveQuery<CallState | null>("wyre.callState", {}));
  const [callMinimized, setCallMinimized] = useState(false);
  const { mutateAsync: startCall } = useMutation(wyreMutation("wyre.startCall"));
  const { mutateAsync: acceptCall } = useMutation(wyreMutation("wyre.acceptCall"));
  const { mutateAsync: declineCall } = useMutation(wyreMutation("wyre.declineCall"));
  const { mutateAsync: joinCallInvite } = useMutation(wyreMutation("wyre.joinCallInvite"));
  const [callError, setCallError] = useState<string | null>(null);
  const callInviteHandled = useRef(false);

  useEffect(() => {
    if (callInviteHandled.current) return;
    const url = new URL(window.location.href);
    const token = url.searchParams.get("callInvite");
    if (!token) return;
    callInviteHandled.current = true;
    void joinCallInvite({ token })
      .catch((error) => {
        setCallError(error instanceof Error ? error.message : "Не удалось присоединиться к звонку");
      })
      .finally(() => {
        url.searchParams.delete("callInvite");
        window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      });
  }, [joinCallInvite]);

  async function onCall(kind: "audio" | "video") {
    if (!selectedChat) return;
    try {
      setCallError(null);
      await prepareCallMedia(kind);
      await startCall({ chatId: selectedChat.id, kind });
    } catch (error) {
      discardPreparedCallMedia();
      setCallError(error instanceof Error ? error.message : "Не удалось начать звонок");
      window.setTimeout(() => setCallError(null), 4000);
    }
  }

  /**
   * Starting a conversation from search / contacts: create (or reuse) the
   * direct chat server-side, then open it with a placeholder header that the
   * live `chatPeer` query immediately replaces with real data.
   */
  async function startChat(peerId: string) {
    const result = (await openDirectChat({ peerId })) as { chatId: string };
    setSection("chats");
    setSelectedChannel(null);
    setSelectedChat({
      id: result.chatId,
      peerId,
      name: "…",
      initials: "··",
      status: "",
      last: "",
      time: "",
      unread: 0,
      colors: ["#8b5cf6", "#2563eb"],
      folders: ["all"],
      presence: "offline",
      warnings: [],
    });
  }

  /**
   * A joined call no longer replaces the messenger: it renders on top, either
   * full-screen or minimized (floating video window / hidden audio). Keeping
   * CallScreen mounted preserves the WebRTC engine and its ping loop.
   * `joinedByThisDevice === false` means another device of this account
   * accepted the call — this device must not open its own call screen.
   */
  const activeCall = call && call.myState === "joined" && call.status !== "ended" && call.joinedByThisDevice !== false ? call : null;
  const minimizedCall = activeCall && callMinimized ? { title: activeCall.title, kind: activeCall.kind } : null;

  const incoming = call && call.status === "ringing" && call.myState === "invited" ? call : null;

  return (
    <div className="messenger">
      {/* On phones the bottom nav hides while a chat or channel is open — the
          back arrow in the chat header is the way out, and the nav returns. */}
      <div className={cn(selectedChat || selectedChannel ? "hidden md:contents" : "contents")}>
        <Navigation
          active={section}
          initials={profile.initials}
          colors={profile.colors}
          onChange={(next) => {
            setSection(next);
            if (next !== "chats") { setSelectedChat(null); setSelectedChannel(null); }
          }}
        />
      </div>
      <main className="app-content">
        <AnimatePresence mode="wait">
          {section === "chats" && (
            <motion.div key="chats" {...pageVariants} className="flex h-full min-w-0 flex-1">
              <div className={cn("h-full w-full shrink-0 md:w-[360px] lg:w-[390px]", (selectedChat || selectedChannel) && "hidden md:block")}>
                <ChatList
                  onOpenChat={(next) => { setSelectedChannel(null); setSelectedChat(next); }}
                  onOpenChannel={(channelId) => { setSelectedChat(null); setSelectedChannel(channelId); }}
                  onStartChat={startChat}
                  onOpenProfile={setProfileUserId}
                  onModal={setModal}
                  onChatDeleted={(chatId) => setSelectedChat((current) => current?.id === chatId ? null : current)}
                />
              </div>
              {selectedChannel ? (
                <ErrorBoundary label="канал">
                  <ChannelWindow key={selectedChannel} channelId={selectedChannel} onBack={() => setSelectedChannel(null)} />
                </ErrorBoundary>
              ) : selectedChat ? (
                <ErrorBoundary label="чат">
                  <ChatWindow
                    key={selectedChat.id}
                    chat={selectedChat}
                    onBack={() => setSelectedChat(null)}
                    onCall={onCall}
                    minimizedCall={minimizedCall}
                    onReturnToCall={() => setCallMinimized(false)}
                    onOpenProfile={setProfileUserId}
                  />
                </ErrorBoundary>
              ) : (
                <EmptyChat />
              )}
            </motion.div>
          )}
          {section === "contacts" && (
            <motion.div key="contacts" {...pageVariants} className="h-full w-full">
              <ContactsScreen onMessage={startChat} onOpenProfile={setProfileUserId} />
            </motion.div>
          )}
          {section === "settings" && (
            <motion.div key="settings" {...pageVariants} className="h-full w-full">
              <SettingsScreen current={themeId} onTheme={onTheme} profile={profile} />
            </motion.div>
          )}
          {section === "account" && (
            <motion.div key="account" {...pageVariants} className="h-full w-full">
              <AccountScreen
                profile={profile}
                onProfileChange={onProfileChange}
                isAdmin={isAdmin}
                onOpenAdminPanel={() => setAdminPanelOpen(true)}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      <AnimatePresence>{profileUserId && <ProfileModal userId={profileUserId} onClose={() => setProfileUserId(null)} onMessage={startChat} />}</AnimatePresence>
      <AnimatePresence>
        {modal && (
          <CreationModal
            kind={modal}
            onClose={() => setModal(null)}
            onCreated={(chatId) => {
              setSection("chats");
              if (modal === "channel") {
                setSelectedChat(null);
                setSelectedChannel(chatId);
                return;
              }
              setSelectedChannel(null);
              setSelectedChat({
                id: chatId,
                name: "…",
                initials: "··",
                status: "",
                last: "",
                time: "",
                unread: 0,
                colors: ["#8b5cf6", "#2563eb"],
                folders: ["all"],
                presence: "offline",
                warnings: [],
                group: true,
              });
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>{adminPanelOpen && <AdminPanel onClose={() => setAdminPanelOpen(false)} />}</AnimatePresence>
      {activeCall && (
        <ErrorBoundary label="экран звонка">
          <CallScreen
            key={activeCall.callId}
            call={activeCall}
            myUserId={profile.id}
            minimized={callMinimized}
            onMinimize={() => setCallMinimized(true)}
            onExpand={() => setCallMinimized(false)}
          />
        </ErrorBoundary>
      )}
      <AnimatePresence>
        {minimizedCall && minimizedCall.kind === "audio" && (
          <motion.button
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            onClick={() => setCallMinimized(false)}
            className="call-return-pill"
          >
            <PhoneCall size={15} />
            <span className="min-w-0 truncate">Звонок · {minimizedCall.title}</span>
            <span className="shrink-0 font-semibold text-[var(--accent1)]">Вернуться</span>
          </motion.button>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {incoming && (
          <IncomingCall
            key={incoming.callId}
            call={incoming}
            onAccept={async () => {
              try {
                setCallError(null);
                await prepareCallMedia(incoming.kind);
                await acceptCall({ callId: incoming.callId });
              } catch (error) {
                discardPreparedCallMedia();
                setCallError(error instanceof Error ? error.message : "Не удалось ответить на звонок");
                window.setTimeout(() => setCallError(null), 5000);
              }
            }}
            onDecline={() => declineCall({ callId: incoming.callId })}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {callError && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className="call-toast"
          >
            {callError}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {linkNotice && (
          <motion.button
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            onClick={() => setLinkNotice(null)}
            className={cn("call-toast text-left", !linkNotice.includes("не удалось") && !linkNotice.includes("Не удалось") && "text-emerald-300")}
          >
            {linkNotice}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  const { session, isLoading, refresh } = useWyreSession();
  const profile = session?.profile ?? null;
  const [themeId, setThemeId] = useState(0);
  const { data: appSettings } = useQuery({ ...wyreQuery<{ themeId: number; fontSize: number; font: "system" | "rounded" | "mono"; autoTheme: boolean }>("wyre.settings", {}), enabled: Boolean(profile) });


  useEffect(() => {
    if (appSettings && appSettings.themeId >= 0 && appSettings.themeId < themes.length) setThemeId(appSettings.themeId);
  }, [appSettings?.themeId]);

  const appliedThemeId = appSettings?.autoTheme ? automaticThemeId() : themeId;
  const theme = themes[appliedThemeId];
  const style = {
    "--bg": theme.bg,
    "--surface-solid": theme.surface,
    "--accent1": theme.accent1,
    "--accent2": theme.accent2,
    fontSize: appSettings ? `${appSettings.fontSize}px` : undefined,
    fontFamily: appSettings?.font === "mono" ? "ui-monospace, monospace" : appSettings?.font === "rounded" ? "ui-rounded, system-ui" : undefined,
  } as CSSProperties;

  return (
    <div className="app-root" style={style}>
      <AnimatePresence mode="wait">
        {isLoading ? (
          <motion.div key="splash" exit={{ opacity: 0 }} className="h-full">
            <Splash />
          </motion.div>
        ) : profile ? (
          <motion.div key="messenger" initial={{ opacity: 0, scale: 1.01 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="h-full">
            <Messenger themeId={themeId} onTheme={setThemeId} profile={profile} onProfileChange={refresh} />
          </motion.div>
        ) : (
          <motion.div
            key={`onboarding-${session?.needsProfile ? "profile" : session?.needsChallenge ? "challenge" : session?.needsPhoneSetup ? "phone" : session?.needsTotp ? "totp" : session?.needsPin ? "pin" : session?.needsWebAuthn ? "webauthn" : session?.needsDeviceApproval ? "approval" : "guest"}`}
            exit={{ opacity: 0, scale: 0.985 }}
            className="h-full"
          >
            <Onboarding
              onComplete={refresh}
              needsProfile={session?.needsProfile}
              needsPhoneSetup={session?.needsPhoneSetup}
              needsChallenge={session?.needsChallenge}
              needsTotp={session?.needsTotp}
              needsPin={session?.needsPin}
              needsAdditionalPassword={session?.needsAdditionalPassword}
              needsWebAuthn={session?.needsWebAuthn}
              needsDeviceApproval={session?.needsDeviceApproval}
              requiresPhone={session?.requiresPhone}
              pendingEmail={session?.email ?? null}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
