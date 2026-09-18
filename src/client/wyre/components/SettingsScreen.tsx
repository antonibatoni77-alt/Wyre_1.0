import { type ReactNode, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { startRegistration } from "@simplewebauthn/browser";
import {
  Bell,
  BellOff,
  Check,
  ChevronDown,
  Clock,
  Crown,
  Database,
  Delete,
  Download,
  Fingerprint,
  HeartHandshake,
  Laptop,
  Lock,
  Palette,
  QrCode,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Users,
} from "lucide-react";
import { cn } from "../utils/cn";
import type { Theme } from "../data";
import { themes } from "../data";
import type { WyreProfile } from "../session";
import type { Person } from "../types";
import { wyreMutation, wyreQuery } from "../../lib/api";
import { Avatar, GlassButton, PrimaryButton, SegmentedControl, Toggle } from "./Glass";
import { collapseVariants, layoutIds } from "../utils/motion";
import { pushSupported, subscribeToPush, unsubscribeFromPush } from "../utils/push";
import QRCode from "qrcode";

function SettingsCard({
  id,
  title,
  subtitle,
  icon,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="settings-card glass-panel">
      <button onClick={onToggle} className="settings-card-head w-full" aria-expanded={open} id={id}>
        <span className="settings-card-head-icon">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="block truncate text-xs text-[var(--muted)]">{subtitle}</span>
        </span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} className="text-[var(--muted)]">
          <ChevronDown size={18} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div {...collapseVariants} className="overflow-hidden">
            <div className="settings-card-body pt-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ThemeGrid({ current, onTheme }: { current: number; onTheme: (id: number) => void }) {
  return (
    <div className="theme-grid !p-0">
      {themes.map((theme: Theme) => (
        <motion.button
          key={theme.id}
          whileHover={{ y: -3 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => onTheme(theme.id)}
          className={cn("theme-preview", theme.premium && "theme-premium", current === theme.id && "theme-selected")}
          style={
            {
              "--theme-bg": theme.bg,
              "--theme-surface": theme.surface,
              "--theme-a1": theme.accent1,
              "--theme-a2": theme.accent2,
            } as never
          }
        >
          {theme.premium && (
            <span className="pro-badge">
              <Crown size={10} /> PRO
            </span>
          )}
          <div className="theme-mini-sidebar" />
          <div className="theme-mini-content">
            <span />
            <span />
            <span />
          </div>
          <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
            <span className="text-xs font-semibold text-white">{theme.name}</span>
            {current === theme.id && (
              <span className="grid h-5 w-5 place-items-center rounded-full bg-white text-slate-900">
                <Check size={12} strokeWidth={3} />
              </span>
            )}
          </div>
        </motion.button>
      ))}
    </div>
  );
}

function QrLoginBlock() {
  const [image, setImage] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { mutateAsync: createQr, isPending } = useMutation(wyreMutation("wyre.createQrLogin"));
  async function refresh() {
    setError(null);
    try {
      const result = await createQr({}) as { url: string; expiresAt: string };
      setImage(await QRCode.toDataURL(result.url, { width: 256, margin: 1, errorCorrectionLevel: "M" }));
      setExpiresAt(result.expiresAt);
    } catch (qrError) { setError(qrError instanceof Error ? qrError.message : "Не удалось создать QR-код"); }
  }
  useEffect(() => { void refresh(); }, []);
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-[var(--line)] bg-white/[0.03] p-4">
      <div className="relative h-20 w-20 shrink-0 rounded-2xl bg-white p-2">
        {image ? <img src={image} alt="QR для входа в Wyre" className="h-full w-full" /> : <span className="grid h-full place-items-center text-[9px] text-slate-900">{isPending ? "…" : "QR"}</span>}
      </div>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <QrCode size={14} /> Вход по QR
        </p>
        <p className="mt-1 text-xs text-[var(--muted)]">Отсканируйте камерой нового устройства. Код одноразовый{expiresAt ? ` и действует до ${new Date(expiresAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` : ""}.</p>
        <button disabled={isPending} onClick={() => void refresh()} className="mt-2 text-[10px] font-semibold text-[var(--accent1)]">Обновить QR</button>
        {error && <p className="mt-1 text-[10px] text-red-400">{error}</p>}
      </div>
    </div>
  );
}

function TotpBlock({ enabled, onEnabled }: { enabled: boolean; onEnabled: (value: boolean) => void }) {
  const [uri, setUri] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { mutateAsync: begin, isPending: starting } = useMutation(wyreMutation("wyre.beginTotp"));
  const { mutateAsync: confirm, isPending: confirming } = useMutation(wyreMutation("wyre.confirmTotp"));
  const { mutateAsync: disable, isPending: disabling } = useMutation(wyreMutation("wyre.disableTotp"));
  async function start() { setError(null); try { const result = await begin({}) as { uri: string }; setUri(result.uri); setImage(await QRCode.toDataURL(result.uri, { width: 220, margin: 1 })); } catch (setupError) { setError(setupError instanceof Error ? setupError.message : "Не удалось включить 2FA"); } }
  async function confirmCode() { setError(null); try { await confirm({ code }); onEnabled(true); setUri(null); setImage(null); setCode(""); } catch (confirmError) { setError(confirmError instanceof Error ? confirmError.message : "Неверный код"); } }
  async function disableCode() { setError(null); try { await disable({ code }); onEnabled(false); setCode(""); } catch (disableError) { setError(disableError instanceof Error ? disableError.message : "Неверный код"); } }
  if (enabled) return <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-3"><p className="text-xs font-medium text-emerald-300">2FA через приложение включена</p><div className="mt-3 flex gap-2"><input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} className="glass-input" placeholder="Код из приложения" inputMode="numeric" /><button disabled={disabling || code.length !== 6} onClick={() => void disableCode()} className="text-xs font-semibold text-red-400">Отключить</button></div>{error && <p className="mt-2 text-xs text-red-400">{error}</p>}</div>;
  return <div className="rounded-2xl border border-[var(--line)] bg-white/[0.02] p-3"><p className="text-xs text-[var(--muted)]">Добавьте Wyre в Google Authenticator, Authy или другое TOTP-приложение.</p>{image && <img src={image} alt="QR для настройки 2FA" className="mx-auto mt-3 h-44 w-44 rounded-xl bg-white p-2" />}{!uri ? <button disabled={starting} onClick={() => void start()} className="mt-3 text-xs font-semibold text-[var(--accent1)]">{starting ? "Создаём…" : "Настроить 2FA"}</button> : <div className="mt-3 flex gap-2"><input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} className="glass-input" placeholder="6-значный код" inputMode="numeric" /><button disabled={confirming || code.length !== 6} onClick={() => void confirmCode()} className="text-xs font-semibold text-[var(--accent1)]">Подтвердить</button></div>}{error && <p className="mt-2 text-xs text-red-400">{error}</p>}</div>;
}

export function SettingsScreen({ current, onTheme, profile }: { current: number; onTheme: (id: number) => void; profile: WyreProfile }) {
  const [open, setOpen] = useState<Record<string, boolean>>({ appearance: true });
  const [fontSize, setFontSize] = useState(15);
  const [font, setFont] = useState<"system" | "rounded" | "mono">("system");
  const [autoTheme, setAutoTheme] = useState(false);

  const [visibility, setVisibility] = useState<"all" | "contacts" | "nobody">(profile.presenceVisibility);
  const [always, setAlways] = useState<string[]>(profile.presenceAlways);
  const [never, setNever] = useState<string[]>(profile.presenceNever);
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [findByPhone, setFindByPhone] = useState<"all" | "contacts" | "nobody">("contacts");
  const [callPermission, setCallPermission] = useState<"all" | "contacts" | "nobody">("contacts");
  const [invitePermission, setInvitePermission] = useState<"all" | "contacts" | "nobody">("all");
  const [phoneVisibility, setPhoneVisibility] = useState<"all" | "contacts" | "nobody">("contacts");
  const [contentFilter, setContentFilter] = useState<"all" | "contacts" | "none">("all");
  const [safeMode, setSafeMode] = useState(false);
  const [familyProtection, setFamilyProtection] = useState(false);
  const [privacyAlways, setPrivacyAlways] = useState<Partial<Record<"find" | "call" | "invite" | "phone", string[]>>>({});
  const [privacyNever, setPrivacyNever] = useState<Partial<Record<"find" | "call" | "invite" | "phone", string[]>>>({});
  const [exceptionAction, setExceptionAction] = useState<"find" | "call" | "invite" | "phone">("call");
  const [familyInviteCode, setFamilyInviteCode] = useState<string | null>(null);
  const [familyJoinCode, setFamilyJoinCode] = useState("");
  const [familyError, setFamilyError] = useState<string | null>(null);
  const [totpSetupOpen, setTotpSetupOpen] = useState(false);

  const [dnd, setDnd] = useState(false);
  const [dndFrom, setDndFrom] = useState("23:00");
  const [dndTo, setDndTo] = useState("08:00");
  const [autoDnd, setAutoDnd] = useState(false);
  const [previews, setPreviews] = useState(true);
  const [mutedChats, setMutedChats] = useState<string[]>(["Wyre News"]);
  const { data: chats = [] } = useQuery(wyreQuery<any[]>("wyre.listChats", {}));
  const { data: storageUsage } = useQuery(wyreQuery<{ bytes: number; fileCount: number }>("wyre.storageUsage", {}));
  const { mutate: toggleMuteChat } = useMutation(wyreMutation("wyre.toggleMuteChat"));
  const { mutate: updateChatNotifications } = useMutation(wyreMutation("wyre.updateChatNotifications"));
  const { data: blockedUsers = [] } = useQuery(wyreQuery<{ userId: string; name: string; username: string }[]>("wyre.blockedUsers", {}));
  const { mutate: blockUser } = useMutation(wyreMutation("wyre.blockUser"));
  const { mutate: unblockUser } = useMutation(wyreMutation("wyre.unblockUser"));

  const [twoFactor, setTwoFactor] = useState(false);
  const [pinEnabled, setPinEnabled] = useState(false);
  const [pinPanelOpen, setPinPanelOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [webAuthnError, setWebAuthnError] = useState<string | null>(null);
  const [deviceApprovalEnabled, setDeviceApprovalEnabled] = useState(false);
  const [decoy, setDecoy] = useState("");
  const [decoyEnabled, setDecoyEnabled] = useState(false);
  const [decoyError, setDecoyError] = useState<string | null>(null);

  const { data: accountAuth, refetch: refetchAccountAuth } = useQuery(wyreQuery<{
    email: string;
    loginPasswordEnabled: boolean;
    additionalPasswordEnabled: boolean;
    yandexLinked: boolean;
    canUnlinkYandex: boolean;
  }>("wyre.accountAuthStatus", {}));
  const { mutateAsync: setLoginPassword, isPending: settingLoginPassword } = useMutation(wyreMutation("wyre.setLoginPassword"));
  const { mutateAsync: disableLoginPassword, isPending: disablingLoginPassword } = useMutation(wyreMutation("wyre.disableLoginPassword"));
  const { mutateAsync: setAdditionalPassword, isPending: settingAdditionalPassword } = useMutation(wyreMutation("wyre.setAdditionalPassword"));
  const { mutateAsync: disableAdditionalPassword, isPending: disablingAdditionalPassword } = useMutation(wyreMutation("wyre.disableAdditionalPassword"));
  const { mutateAsync: validateBackup } = useMutation(wyreMutation("wyre.validateBackup"));
  const { mutateAsync: restoreBackup } = useMutation(wyreMutation("wyre.restoreBackup"));
  const [loginPasswordValue, setLoginPasswordValue] = useState("");
  const [additionalPasswordValue, setAdditionalPasswordValue] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [restoreState, setRestoreState] = useState<{ plan?: Record<string, unknown>; applied?: Record<string, unknown>; error?: string; backup?: unknown } | null>(null);
  const { data: pushStatus, refetch: refetchPushStatus } = useQuery(wyreQuery<{
    configured: boolean;
    publicKey: string | null;
    deviceCount: number;
    currentDeviceSubscribed: boolean;
  }>("wyre.pushStatus", {}));
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  const [exportState, setExportState] = useState<"idle" | "working" | "done">("idle");
  const hydratedProfile = useRef<string | null>(null);
  const { data: storedSettings } = useQuery(wyreQuery<{ themeId: number; fontSize: number; font: "system" | "rounded" | "mono"; autoTheme: boolean; dnd: boolean; dndFrom: string; dndTo: string; autoDnd?: boolean; previews: boolean; mutedChats: string[]; blacklist: string[]; totpEnabled?: boolean; pinEnabled?: boolean; newDeviceApprovalEnabled?: boolean; decoyEnabled?: boolean; findByPhone?: "all" | "contacts" | "nobody"; callPermission?: "all" | "contacts" | "nobody"; invitePermission?: "all" | "contacts" | "nobody"; phoneVisibility?: "all" | "contacts" | "nobody"; contentFilter?: "all" | "contacts" | "none"; safeMode?: boolean; familyProtection?: boolean; privacyAlways?: Partial<Record<"find" | "call" | "invite" | "phone", string[]>>; privacyNever?: Partial<Record<"find" | "call" | "invite" | "phone", string[]>> }>("wyre.settings", {}));
  const { data: sessionList = [], refetch: refetchSessions } = useQuery(wyreQuery<{ id: string; device: string; network: string; lastActive: string; current: boolean; approved: boolean }[]>("wyre.activeSessions", {}));
  const { data: people = [] } = useQuery({ ...wyreQuery<Person[]>("wyre.searchPeople", { query: "" }), enabled: !!open.privacy });
  const { mutate: savePresencePrivacy } = useMutation(wyreMutation("wyre.updatePresencePrivacy"));
  const { mutate: persistSettings } = useMutation(wyreMutation("wyre.updateSettings"));
  const { mutate: revokeSession } = useMutation(wyreMutation("wyre.revokeSession"));
  const { mutate: revokeOthers } = useMutation(wyreMutation("wyre.revokeOtherSessions"));
  const { mutateAsync: setNewDeviceApproval, isPending: changingDeviceApproval } = useMutation(wyreMutation("wyre.setNewDeviceApproval"));
  const { mutateAsync: approveDeviceSession } = useMutation(wyreMutation("wyre.approveDeviceSession"));
  const { mutateAsync: denyDeviceSession } = useMutation(wyreMutation("wyre.denyDeviceSession"));
  const { mutateAsync: setAccountPin, isPending: settingPin } = useMutation(wyreMutation("wyre.setPin"));
  const { mutateAsync: disableAccountPin, isPending: disablingPin } = useMutation(wyreMutation("wyre.disablePin"));
  const { data: webAuthnStatus, refetch: refetchWebAuthn } = useQuery(wyreQuery<{
    appEnabled: boolean;
    accountEnabled: boolean;
    appLockMinutes: number;
    credentials: { id: string; name: string; createdAt: string; lastUsedAt: string | null; backedUp: boolean }[];
  }>("wyre.webauthnStatus", {}));
  const { mutateAsync: beginWebAuthnRegistration, isPending: beginningWebAuthn } = useMutation(wyreMutation("wyre.beginWebAuthnRegistration"));
  const { mutateAsync: finishWebAuthnRegistration, isPending: finishingWebAuthn } = useMutation(wyreMutation("wyre.finishWebAuthnRegistration"));
  const { mutateAsync: setWebAuthnScope, isPending: changingWebAuthn } = useMutation(wyreMutation("wyre.setWebAuthnScope"));
  const { mutateAsync: removeWebAuthnCredential, isPending: removingWebAuthn } = useMutation(wyreMutation("wyre.removeWebAuthnCredential"));
  const { mutateAsync: setDecoyCode, isPending: settingDecoy } = useMutation(wyreMutation("wyre.setDecoyCode"));
  const { mutateAsync: disableDecoy, isPending: disablingDecoy } = useMutation(wyreMutation("wyre.disableDecoy"));
  const { data: familyStatus, refetch: refetchFamily } = useQuery(wyreQuery<{
    managed: boolean;
    guardians: { userId: string; name: string; username: string; protectionEnabled: boolean }[];
    children: { userId: string; name: string; username: string; protectionEnabled: boolean }[];
  }>("wyre.familyStatus", {}));
  const { mutateAsync: createFamilyInvite, isPending: creatingFamilyInvite } = useMutation(wyreMutation("wyre.createFamilyInvite"));
  const { mutateAsync: acceptFamilyInvite, isPending: acceptingFamilyInvite } = useMutation(wyreMutation("wyre.acceptFamilyInvite"));
  const { mutateAsync: setChildProtection } = useMutation(wyreMutation("wyre.setChildProtection"));
  const { mutateAsync: removeFamilyLink } = useMutation(wyreMutation("wyre.removeFamilyLink"));
  const { data: quietCare, refetch: refetchQuietCare } = useQuery(wyreQuery<{ enabled: boolean; days: number }>("wyre.quietCareSettings", {}));
  const { data: quietCareAlerts = [], refetch: refetchQuietCareAlerts } = useQuery(wyreQuery<{ id: string; userId: string; name: string; username: string; initials: string; colors: [string, string]; days: number; createdAt: string }[]>("wyre.quietCareAlerts", {}));
  const { mutateAsync: setQuietCare } = useMutation(wyreMutation("wyre.setQuietCare"));
  const { mutateAsync: dismissQuietCare } = useMutation(wyreMutation("wyre.dismissQuietCareAlert"));
  const [quietCareError, setQuietCareError] = useState<string | null>(null);

  useEffect(() => {
    if (!storedSettings || hydratedProfile.current === profile.id) return;
    hydratedProfile.current = profile.id;
    onTheme(storedSettings.themeId);
    setFontSize(storedSettings.fontSize);
    setFont(storedSettings.font);
    setAutoTheme(storedSettings.autoTheme);
    setDnd(storedSettings.dnd);
    setDndFrom(storedSettings.dndFrom);
    setDndTo(storedSettings.dndTo);
    setAutoDnd(Boolean(storedSettings.autoDnd));
    setPreviews(storedSettings.previews);
    setMutedChats(storedSettings.mutedChats);
    setBlacklist(storedSettings.blacklist);
    setTwoFactor(Boolean(storedSettings.totpEnabled));
    setPinEnabled(Boolean(storedSettings.pinEnabled));
    setDeviceApprovalEnabled(Boolean(storedSettings.newDeviceApprovalEnabled));
    setDecoyEnabled(Boolean(storedSettings.decoyEnabled));
    setFindByPhone(storedSettings.findByPhone ?? "contacts");
    setCallPermission(storedSettings.callPermission ?? "contacts");
    setInvitePermission(storedSettings.invitePermission ?? "all");
    setPhoneVisibility(storedSettings.phoneVisibility ?? "contacts");
    setContentFilter(storedSettings.contentFilter ?? "all");
    setSafeMode(Boolean(storedSettings.safeMode));
    setFamilyProtection(Boolean(storedSettings.familyProtection));
    setPrivacyAlways(storedSettings.privacyAlways ?? {});
    setPrivacyNever(storedSettings.privacyNever ?? {});
  }, [storedSettings, profile.id, onTheme]);

  useEffect(() => {
    if (hydratedProfile.current !== profile.id) return;
    const timer = window.setTimeout(() => persistSettings({ themeId: current, fontSize, font, autoTheme, dnd, dndFrom, dndTo, autoDnd, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, previews, mutedChats, blacklist, findByPhone, callPermission, invitePermission, phoneVisibility, contentFilter, safeMode, familyProtection, privacyAlways, privacyNever }), 450);
    return () => window.clearTimeout(timer);
  }, [profile.id, current, fontSize, font, autoTheme, dnd, dndFrom, dndTo, autoDnd, previews, mutedChats, blacklist, findByPhone, callPermission, invitePermission, phoneVisibility, contentFilter, safeMode, familyProtection, privacyAlways, privacyNever, persistSettings]);

  function savePrivacy(next: { visibility?: typeof visibility; always?: string[]; never?: string[] }) {
    const value = {
      visibility: next.visibility ?? visibility,
      always: next.always ?? always,
      never: next.never ?? never,
    };
    setVisibility(value.visibility);
    setAlways(value.always);
    setNever(value.never);
    savePresencePrivacy(value);
  }

  function togglePrivacyException(list: "always" | "never", userId: string) {
    const source = list === "always" ? privacyAlways : privacyNever;
    const currentIds = source[exceptionAction] ?? [];
    const next = { ...source, [exceptionAction]: currentIds.includes(userId) ? currentIds.filter((id) => id !== userId) : [...currentIds, userId] };
    if (list === "always") setPrivacyAlways(next);
    else setPrivacyNever(next);
  }

  function toggle(id: string) {
    setOpen((value) => ({ ...value, [id]: !value[id] }));
  }

  async function submitPin(value: string) {
    setPinError(null);
    try {
      if (pinEnabled) {
        await disableAccountPin({ pin: value });
        setPinEnabled(false);
        setDecoyEnabled(false);
      } else {
        await setAccountPin({ pin: value });
        setPinEnabled(true);
      }
      setPin("");
      setPinPanelOpen(false);
    } catch (pinFailure) {
      setPin("");
      setPinError(pinFailure instanceof Error ? pinFailure.message : "Не удалось сохранить PIN-код");
    }
  }

  function pressPinKey(key: string) {
    if (settingPin || disablingPin) return;
    if (key === "del") {
      setPin((value) => value.slice(0, -1));
      return;
    }
    if (key === "bio") {
      void enableWebAuthnScope("app");
      return;
    }
    if (pin.length >= 4) return;
    const next = pin + key;
    setPin(next);
    if (next.length === 4) void submitPin(next);
  }

  async function enableWebAuthnScope(scope: "app" | "account") {
    setWebAuthnError(null);
    try {
      if (!window.PublicKeyCredential) throw new Error("Этот браузер не поддерживает WebAuthn");
      if (window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
        && !await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()) {
        throw new Error("На устройстве не настроена системная биометрия или Windows Hello");
      }
      if (webAuthnStatus?.credentials.length) {
        await setWebAuthnScope({ scope, enabled: true });
      } else {
        const options = await beginWebAuthnRegistration({ scope }) as Parameters<typeof startRegistration>[0]["optionsJSON"];
        const response = await startRegistration({ optionsJSON: options });
        await finishWebAuthnRegistration({ response });
      }
      await refetchWebAuthn();
    } catch (webAuthnFailure) {
      setWebAuthnError(webAuthnFailure instanceof Error ? webAuthnFailure.message : "Не удалось настроить биометрию");
    }
  }

  async function toggleWebAuthnScope(scope: "app" | "account", enabled: boolean) {
    if (enabled) {
      await enableWebAuthnScope(scope);
      return;
    }
    setWebAuthnError(null);
    try {
      await setWebAuthnScope({ scope, enabled: false });
      await refetchWebAuthn();
    } catch (webAuthnFailure) {
      setWebAuthnError(webAuthnFailure instanceof Error ? webAuthnFailure.message : "Не удалось изменить настройку");
    }
  }

  async function removeCredential(credentialId: string) {
    setWebAuthnError(null);
    try {
      await removeWebAuthnCredential({ credentialId });
      await refetchWebAuthn();
    } catch (webAuthnFailure) {
      setWebAuthnError(webAuthnFailure instanceof Error ? webAuthnFailure.message : "Не удалось удалить ключ устройства");
    }
  }

  async function toggleDeviceApproval() {
    const enabled = !deviceApprovalEnabled;
    await setNewDeviceApproval({ enabled });
    setDeviceApprovalEnabled(enabled);
    await refetchSessions();
  }

  async function resolveDeviceApproval(sessionId: string, approved: boolean) {
    if (approved) await approveDeviceSession({ sessionId });
    else await denyDeviceSession({ sessionId });
    await refetchSessions();
  }

  async function submitDecoyCode(code: string) {
    setDecoyError(null);
    try {
      if (decoyEnabled) {
        await disableDecoy({ code });
        setDecoyEnabled(false);
      } else {
        await setDecoyCode({ code });
        setDecoyEnabled(true);
      }
      setDecoy("");
    } catch (decoyFailure) {
      setDecoy("");
      setDecoyError(decoyFailure instanceof Error ? decoyFailure.message : "Не удалось сохранить decoy-код");
    }
  }

  async function makeFamilyInvite() {
    setFamilyError(null);
    try {
      const result = await createFamilyInvite({}) as { code: string };
      setFamilyInviteCode(result.code);
    } catch (familyFailure) {
      setFamilyError(familyFailure instanceof Error ? familyFailure.message : "Не удалось создать приглашение");
    }
  }

  async function joinFamily() {
    setFamilyError(null);
    try {
      await acceptFamilyInvite({ code: familyJoinCode });
      setFamilyJoinCode("");
      await refetchFamily();
    } catch (familyFailure) {
      setFamilyError(familyFailure instanceof Error ? familyFailure.message : "Не удалось принять приглашение");
    }
  }

  async function updateChildPolicy(childId: string, mode: "off" | "base" | "strict") {
    await setChildProtection(mode === "strict"
      ? { childId, enabled: true, callPermission: "nobody", invitePermission: "nobody", findByPhone: "nobody", phoneVisibility: "nobody", contentFilter: "none" }
      : mode === "base"
        ? { childId, enabled: true, callPermission: "contacts", invitePermission: "contacts", findByPhone: "contacts", phoneVisibility: "contacts", contentFilter: "contacts" }
        : { childId, enabled: false });
    await refetchFamily();
  }

  async function unlinkFamily(userId: string) {
    await removeFamilyLink({ userId });
    await refetchFamily();
  }

  async function saveQuietCare(enabled: boolean, days: number) {
    setQuietCareError(null);
    try {
      await setQuietCare({ enabled, days });
      await refetchQuietCare();
      await refetchQuietCareAlerts();
    } catch (error) {
      setQuietCareError(error instanceof Error ? error.message : "Не удалось сохранить настройку");
    }
  }

  function runExport(format: "txt" | "json" | "pdf") {
    setExportState("working");
    const download = document.createElement('a');
    download.href = `/api/export/${format}`;
    download.download = `wyre-export.${format}`;
    download.click();
    window.setTimeout(() => setExportState("done"), 900);
  }

  async function runAccountSecurity(action: () => Promise<unknown>) {
    setPasswordError(null);
    try {
      await action();
      await refetchAccountAuth();
      setLoginPasswordValue("");
      setAdditionalPasswordValue("");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "Не удалось изменить пароль");
    }
  }

  async function pickBackupFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setRestoreState(null);
      try {
        if (file.size > 900_000) throw new Error("Файл больше 900 КБ — восстановление принимает только JSON-экспорт без вложений");
        const backup = JSON.parse(await file.text()) as unknown;
        const result = await validateBackup({ backup }) as { plan: Record<string, unknown> };
        setRestoreState({ plan: result.plan, backup });
      } catch (error) {
        setRestoreState({ error: error instanceof Error ? error.message : "Не удалось прочитать резервную копию" });
      }
    };
    input.click();
  }

  async function applyBackup() {
    if (!restoreState?.backup) return;
    try {
      const result = await restoreBackup({ backup: restoreState.backup }) as { applied: Record<string, unknown> };
      setRestoreState({ applied: result.applied });
    } catch (error) {
      setRestoreState({ error: error instanceof Error ? error.message : "Не удалось восстановить резервную копию" });
    }
  }

  async function togglePush() {
    setPushError(null);
    setPushBusy(true);
    try {
      if (pushStatus?.currentDeviceSubscribed) await unsubscribeFromPush();
      else if (pushStatus?.publicKey) await subscribeToPush(pushStatus.publicKey);
      else throw new Error("Push-уведомления не настроены администратором");
      await refetchPushStatus();
    } catch (error) {
      setPushError(error instanceof Error ? error.message : "Не удалось изменить подписку на уведомления");
    } finally {
      setPushBusy(false);
    }
  }

  function setChatMute(chat: any, hours: number | null) {
    updateChatNotifications({
      chatId: chat.id,
      mode: chat.notificationMode ?? (chat.muted ? "none" : "all"),
      mutedUntil: hours ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null,
    });
  }

  return (
    <section className="section-screen overflow-y-auto pb-24 md:pb-8">
      <div className="section-header">
        <div>
          <p className="eyebrow">Персонализация</p>
          <h1>Настройки</h1>
          <p className="mt-2 max-w-md text-sm text-[var(--muted)]">Тонко настройте внешний вид, приватность и безопасность Wyre.</p>
        </div>
      </div>

      <div className="settings-cards">
        <SettingsCard
          id="appearance"
          title="Внешний вид"
          subtitle={`Тема «${themes[current].name}» · шрифт ${fontSize}px`}
          icon={<Palette size={18} />}
          open={!!open.appearance}
          onToggle={() => toggle("appearance")}
        >
          <button onClick={() => setAutoTheme((value) => !value)} className="settings-row !border-b-0">
            <Sparkles size={17} />
            <span className="flex-1 text-left text-sm font-medium">Автотема по времени суток</span>
            <Toggle checked={autoTheme} onChange={() => setAutoTheme((value) => !value)} />
          </button>

          <div className="mt-2 rounded-2xl border border-[var(--line)] bg-white/[0.02] p-4">
            <div className="mb-3 flex items-center justify-between text-xs font-medium text-[var(--muted)]">
              <span>Размер шрифта</span>
              <span>{fontSize}px</span>
            </div>
            <input
              type="range"
              min={12}
              max={20}
              value={fontSize}
              onChange={(event) => setFontSize(Number(event.target.value))}
              className="w-full accent-[var(--accent1)]"
            />
            <div className="font-preview mt-4" style={{ fontSize: `${fontSize}px`, fontFamily: font === "mono" ? "ui-monospace, monospace" : font === "rounded" ? "ui-rounded, system-ui" : "inherit" }}>
              Живой предпросмотр: «Привет! Как тебе обновлённый Wyre?»
            </div>
            <div className="mt-4">
              <SegmentedControl
                layoutId={`${layoutIds.segmentIndicator}-font`}
                value={font}
                onChange={setFont}
                options={[
                  { value: "system", label: "System" },
                  { value: "rounded", label: "Rounded" },
                  { value: "mono", label: "Mono" },
                ]}
              />
            </div>
          </div>

          <p className="mb-2 mt-5 text-xs font-medium text-[var(--muted)]">10 обычных + 10 премиум тем · клик применяет мгновенно</p>
          <ThemeGrid current={current} onTheme={onTheme} />
        </SettingsCard>

        <SettingsCard
          id="privacy"
          title="Приватность"
          subtitle={`Статус «в сети»: ${visibility === "all" ? "все" : visibility === "contacts" ? "контакты" : "никто"}`}
          icon={<Lock size={18} />}
          open={!!open.privacy}
          onToggle={() => toggle("privacy")}
        >
          {familyStatus?.managed && <p className="mb-4 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-200">Эти параметры управляются семейной защитой. Чёрный список остаётся доступен.</p>}
          <fieldset disabled={familyStatus?.managed} className={familyStatus?.managed ? "opacity-60" : ""}>
          <p className="mb-2 text-xs font-medium text-[var(--muted)]">Кто видит мой статус «в сети»</p>
          <SegmentedControl
            layoutId={`${layoutIds.segmentIndicator}-visibility`}
            value={visibility}
            onChange={(value) => savePrivacy({ visibility: value })}
            options={[
              { value: "all", label: "Все" },
              { value: "contacts", label: "Контакты" },
              { value: "nobody", label: "Никто" },
            ]}
          />

          <p className="mb-2 mt-5 text-xs font-medium text-[var(--muted)]">Всегда показывать статус</p>
          <div className="flex flex-wrap gap-2">
            {people.map((contact) => {
              const checked = always.includes(contact.userId);
              return (
                <button
                  key={contact.userId}
                  onClick={() => savePrivacy({ always: checked ? always.filter((item) => item !== contact.userId) : [...always, contact.userId] })}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs transition",
                    checked ? "border-transparent bg-[var(--accent1)] text-white" : "border-[var(--line)] text-[var(--muted)]",
                  )}
                >
                  {contact.name}
                </button>
              );
            })}
          </div>

          <p className="mb-2 mt-5 text-xs font-medium text-[var(--muted)]">Никогда не показывать статус</p>
          <div className="flex flex-wrap gap-2">
            {people.map((contact) => {
              const checked = never.includes(contact.userId);
              return (
                <button
                  key={contact.userId}
                  onClick={() => savePrivacy({ never: checked ? never.filter((item) => item !== contact.userId) : [...never, contact.userId] })}
                  className={cn("rounded-full border px-3 py-1.5 text-xs transition", checked ? "border-transparent bg-red-500/80 text-white" : "border-[var(--line)] text-[var(--muted)]")}
                >
                  {contact.name}
                </button>
              );
            })}
          </div>

          {([
            ["Поиск по номеру", findByPhone, setFindByPhone, "find"],
            ["Кто может звонить", callPermission, setCallPermission, "call"],
            ["Кто может приглашать в чаты", invitePermission, setInvitePermission, "invite"],
            ["Кто видит номер", phoneVisibility, setPhoneVisibility, "phone"],
          ] as const).map(([label, value, setter, key]) => (
            <div key={key} className="mt-5">
              <p className="mb-2 text-xs font-medium text-[var(--muted)]">{label}</p>
              <SegmentedControl
                layoutId={`${layoutIds.segmentIndicator}-privacy-${key}`}
                value={value}
                onChange={setter}
                options={[{ value: "all", label: "Все" }, { value: "contacts", label: "Контакты" }, { value: "nobody", label: "Никто" }]}
              />
            </div>
          ))}

          <p className="mb-2 mt-5 text-xs font-medium text-[var(--muted)]">Исключения для правила</p>
          <SegmentedControl
            layoutId={`${layoutIds.segmentIndicator}-privacy-exception`}
            value={exceptionAction}
            onChange={setExceptionAction}
            options={[{ value: "find", label: "Поиск" }, { value: "call", label: "Звонки" }, { value: "invite", label: "Чаты" }, { value: "phone", label: "Номер" }]}
          />
          <p className="mb-2 mt-4 text-xs text-[var(--muted)]">Всегда разрешать</p>
          <div className="flex flex-wrap gap-2">
            {people.map((person) => <button key={person.userId} onClick={() => togglePrivacyException("always", person.userId)} className={cn("rounded-full border px-3 py-1.5 text-xs", (privacyAlways[exceptionAction] ?? []).includes(person.userId) ? "border-transparent bg-emerald-500/80 text-white" : "border-[var(--line)] text-[var(--muted)]")}>{person.name}</button>)}
          </div>
          <p className="mb-2 mt-4 text-xs text-[var(--muted)]">Никогда не разрешать</p>
          <div className="flex flex-wrap gap-2">
            {people.map((person) => <button key={person.userId} onClick={() => togglePrivacyException("never", person.userId)} className={cn("rounded-full border px-3 py-1.5 text-xs", (privacyNever[exceptionAction] ?? []).includes(person.userId) ? "border-transparent bg-red-500/80 text-white" : "border-[var(--line)] text-[var(--muted)]")}>{person.name}</button>)}
          </div>

          <div className="settings-row mt-5">
            <ShieldCheck size={17} />
            <span className="flex-1 text-sm">Безопасный режим</span>
            <Toggle checked={safeMode} onChange={() => setSafeMode((value) => !value)} />
          </div>
          <div className="settings-row">
            <Users size={17} />
            <span className="flex-1 text-sm">Семейная защита</span>
            <Toggle checked={familyProtection} onChange={() => setFamilyProtection((value) => !value)} />
          </div>
          <p className="mb-2 mt-5 text-xs font-medium text-[var(--muted)]">Показывать входящий контент</p>
          <SegmentedControl
            layoutId={`${layoutIds.segmentIndicator}-content-filter`}
            value={contentFilter}
            onChange={setContentFilter}
            options={[{ value: "all", label: "Весь" }, { value: "contacts", label: "Контакты" }, { value: "none", label: "Ничего" }]}
          />
          </fieldset>

          <p className="mb-2 mt-5 text-xs font-medium text-[var(--muted)]">Чёрный список</p>
          <div className="rounded-2xl border border-[var(--line)]">
            {blockedUsers.length === 0 && <p className="p-3 text-xs text-[var(--muted)]">Список пуст</p>}
            {blockedUsers.map((entry) => (
              <div key={entry.userId} className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2.5 text-sm last:border-0">
                <span>{entry.name} <span className="text-xs text-[var(--muted)]">@{entry.username}</span></span>
                <button onClick={() => unblockUser({ userId: entry.userId })} className="text-xs text-red-400">Убрать</button>
              </div>
            ))}
            {people.filter((person) => !blockedUsers.some((blocked) => blocked.userId === person.userId)).map((person) => (
              <button key={person.userId} onClick={() => blockUser({ userId: person.userId })} className="w-full border-t border-[var(--line)] px-3 py-2.5 text-left text-xs font-medium text-[var(--accent1)]">
                + {person.name} · @{person.username}
              </button>
            ))}
          </div>
        </SettingsCard>

        <SettingsCard
          id="family"
          title="Семейная защита"
          subtitle={familyStatus?.managed ? "Настройки защищены взрослым" : `${familyStatus?.children.length ?? 0} детских аккаунтов`}
          icon={<Users size={18} />}
          open={!!open.family}
          onToggle={() => toggle("family")}
        >
          <p className="text-xs leading-5 text-[var(--muted)]">Связь создаётся только после ввода одноразового кода на втором аккаунте. Доступ к переписке, файлам и геолокации не передаётся.</p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <GlassButton disabled={creatingFamilyInvite} onClick={() => void makeFamilyInvite()} className="!h-10 !w-auto min-w-44 flex-1 px-4 text-xs font-semibold">Создать код взрослого</GlassButton>
            {familyInviteCode && <span className="glass-input !min-h-10 grid min-w-32 flex-1 place-items-center font-mono text-sm tracking-widest">{familyInviteCode}</span>}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input value={familyJoinCode} onChange={(event) => setFamilyJoinCode(event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 8))} className="glass-input !min-h-10 min-w-40 flex-1 font-mono uppercase" placeholder="Код взрослого" />
            <GlassButton disabled={acceptingFamilyInvite || familyJoinCode.length !== 8} onClick={() => void joinFamily()} className="!h-10 !w-auto px-4 text-xs font-semibold">Принять</GlassButton>
          </div>
          {familyStatus?.guardians.map((guardian) => (
            <div key={guardian.userId} className="mt-3 flex items-center gap-3 rounded-2xl border border-[var(--line)] p-3">
              <span className="min-w-0 flex-1 truncate text-sm">{guardian.name} <span className="text-xs text-[var(--muted)]">@{guardian.username}</span></span>
              <button onClick={() => void unlinkFamily(guardian.userId)} className="shrink-0 text-xs text-red-400">Отключить</button>
            </div>
          ))}
          {familyStatus?.children.map((child) => (
            <div key={child.userId} className="mt-3 rounded-2xl border border-[var(--line)] p-3">
              <p className="text-sm font-medium">{child.name} <span className="text-xs text-[var(--muted)]">@{child.username}</span></p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button onClick={() => void updateChildPolicy(child.userId, "base")} className="text-xs font-semibold text-[var(--accent1)]">Базовая защита</button>
                <button onClick={() => void updateChildPolicy(child.userId, "strict")} className="text-xs font-semibold text-amber-300">Строгая</button>
                <button onClick={() => void updateChildPolicy(child.userId, "off")} className="text-xs text-[var(--muted)]">Выключить</button>
                <button onClick={() => void unlinkFamily(child.userId)} className="ml-auto text-xs text-red-400">Удалить связь</button>
              </div>
            </div>
          ))}
          {familyError && <p className="mt-3 text-xs text-red-400">{familyError}</p>}

          <div className="mt-5 rounded-2xl border border-[var(--line)] p-3">
            <div className="flex items-center gap-3">
              <HeartHandshake size={17} className="text-[var(--accent1)]" />
              <span className="flex-1 text-sm font-medium">Тихая забота</span>
              <Toggle checked={Boolean(quietCare?.enabled)} onChange={() => void saveQuietCare(!quietCare?.enabled, quietCare?.days ?? 3)} />
            </div>
            <p className="mt-2 text-[11px] leading-5 text-[var(--muted)]">Если вас долго не видно в сети, близкие получат мягкое напоминание. Точное время активности и переписка не раскрываются, а вы включаете это сами.</p>
            {quietCare?.enabled && (
              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs text-[var(--muted)]">Порог отсутствия</span>
                <select
                  value={quietCare.days}
                  onChange={(event) => void saveQuietCare(true, Number(event.target.value))}
                  className="glass-select !min-h-9 !w-32 !px-2 text-xs"
                >
                  <option value={1}>1 день</option>
                  <option value={3}>3 дня</option>
                  <option value={7}>7 дней</option>
                  <option value={14}>14 дней</option>
                  <option value={30}>30 дней</option>
                </select>
              </div>
            )}
            {quietCareAlerts.length > 0 && (
              <div className="mt-3 space-y-1">
                <p className="text-[10px] text-[var(--muted)]">Давно не было видно</p>
                {quietCareAlerts.map((alert) => (
                  <div key={alert.id} className="flex items-center gap-2 rounded-xl bg-amber-400/10 px-2 py-2">
                    <Avatar initials={alert.initials} colors={alert.colors} size="sm" />
                    <span className="min-w-0 flex-1 text-xs">
                      <span className="block truncate font-medium">{alert.name}</span>
                      <span className="block text-[10px] text-[var(--muted)]">не в сети больше {alert.days} дн.</span>
                    </span>
                    <button onClick={() => void dismissQuietCare({ alertId: alert.id }).then(() => refetchQuietCareAlerts())} className="text-[10px] text-[var(--muted)]">Скрыть</button>
                  </div>
                ))}
              </div>
            )}
            {quietCareError && <p className="mt-2 text-xs text-red-400">{quietCareError}</p>}
          </div>
        </SettingsCard>

        <SettingsCard
          id="notifications"
          title="Уведомления"
          subtitle={dnd ? `Не беспокоить: ${dndFrom}–${dndTo}` : "Не беспокоить выключено"}
          icon={<Bell size={18} />}
          open={!!open.notifications}
          onToggle={() => toggle("notifications")}
        >
          <button onClick={() => setDnd((value) => !value)} className="settings-row">
            {dnd ? <BellOff size={17} /> : <Bell size={17} />}
            <span className="flex-1 text-left text-sm font-medium">Не беспокоить по расписанию</span>
            <Toggle checked={dnd} onChange={() => setDnd((value) => !value)} />
          </button>
          {dnd && (
            <div className="my-3 flex items-center gap-3 rounded-2xl border border-[var(--line)] bg-white/[0.02] p-3">
              <Clock size={15} className="text-[var(--muted)]" />
              <input type="time" value={dndFrom} onChange={(event) => setDndFrom(event.target.value)} className="glass-input !min-h-9 flex-1" />
              <span className="text-xs text-[var(--muted)]">до</span>
              <input type="time" value={dndTo} onChange={(event) => setDndTo(event.target.value)} className="glass-input !min-h-9 flex-1" />
            </div>
          )}
          <button onClick={() => void togglePush()} disabled={pushBusy || !pushSupported() || !pushStatus?.configured} className="settings-row disabled:opacity-50">
            <Bell size={17} />
            <span className="flex-1 text-left">
              <span className="block text-sm font-medium">Уведомления в фоне на этом устройстве</span>
              <span className="block text-[10px] text-[var(--muted)]">
                {!pushSupported()
                  ? "Браузер не поддерживает push-уведомления"
                  : !pushStatus?.configured
                    ? "Администратор ещё не настроил ключи push"
                    : `Подключено устройств: ${pushStatus.deviceCount}`}
              </span>
            </span>
            <Toggle checked={Boolean(pushStatus?.currentDeviceSubscribed)} onChange={() => void togglePush()} />
          </button>
          {pushError && <p className="mb-2 text-xs text-red-400">{pushError}</p>}
          <button onClick={() => setPreviews((value) => !value)} className="settings-row">
            <ShieldCheck size={17} />
            <span className="flex-1 text-left text-sm font-medium">Показывать текст в превью</span>
            <Toggle checked={previews} onChange={() => setPreviews((value) => !value)} />
          </button>
          <p className="mb-2 mt-4 text-xs font-medium text-[var(--muted)]">Уведомления по чатам</p>
          {chats.length === 0 && <p className="py-3 text-xs text-[var(--muted)]">Нет чатов</p>}
          {chats.map((chat) => {
            const mode = chat.notificationMode ?? (chat.muted ? "none" : "all");
            return (
              <div key={chat.id} className="border-b border-[var(--line)] py-3 last:border-0">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm">{chat.name}</span>
                  <Toggle checked={mode !== "none"} onChange={() => toggleMuteChat({ chatId: chat.id })} />
                </div>
                <div className="mt-3">
                  <SegmentedControl
                    layoutId={`${layoutIds.segmentIndicator}-notifications-${chat.id}`}
                    value={mode}
                    onChange={(nextMode) => updateChatNotifications({ chatId: chat.id, mode: nextMode, mutedUntil: chat.mutedUntil ?? null })}
                    options={[{ value: "all", label: "Все" }, { value: "mentions", label: "Упоминания" }, { value: "none", label: "Выкл." }]}
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-xs">
                  <button onClick={() => setChatMute(chat, 1)} className="text-[var(--accent1)]">Mute 1ч</button>
                  <button onClick={() => setChatMute(chat, 8)} className="text-[var(--accent1)]">8ч</button>
                  <button onClick={() => setChatMute(chat, 24)} className="text-[var(--accent1)]">1 день</button>
                  <button onClick={() => setChatMute(chat, 24 * 7)} className="text-[var(--accent1)]">7 дней</button>
                  {chat.mutedUntil && <button onClick={() => setChatMute(chat, null)} className="text-red-400">Снять временный mute</button>}
                </div>
              </div>
            );
          })}
        </SettingsCard>

        <SettingsCard
          id="security"
          title="Безопасность"
          subtitle={`2FA: ${twoFactor ? "включена" : "выключена"} · PIN: ${pinEnabled ? "включён" : "выключен"}`}
          icon={<Fingerprint size={18} />}
          open={!!open.security}
          onToggle={() => toggle("security")}
        >
          <button onClick={() => setTotpSetupOpen((value) => !value)} className="settings-row">
            <ShieldCheck size={17} />
            <span className="flex-1 text-left text-sm font-medium">Двухфакторная аутентификация</span>
            <Toggle checked={twoFactor} onChange={() => setTotpSetupOpen((value) => !value)} />
          </button>
          <AnimatePresence>
            {(twoFactor || totpSetupOpen) && (
              <motion.div {...collapseVariants} className="overflow-hidden">
                <div className="my-3">
                  <TotpBlock enabled={twoFactor} onEnabled={(value) => { setTwoFactor(value); setTotpSetupOpen(value); }} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <button onClick={() => { setPinPanelOpen((value) => !value); setPin(""); setPinError(null); }} className="settings-row">
            <Smartphone size={17} />
            <span className="flex-1 text-left text-sm font-medium">PIN-код</span>
            <Toggle checked={pinEnabled} onChange={() => undefined} />
          </button>
          <button onClick={() => setAutoDnd((value) => !value)} className="settings-row">
            <Sparkles size={17} />
            <span className="flex-1 text-left"><span className="block text-sm font-medium">Авто-DND по активности</span><span className="block text-[10px] text-[var(--muted)]">Ежедневно выбирает самые спокойные 8 часов</span></span>
            <Toggle checked={autoDnd} onChange={() => setAutoDnd((value) => !value)} />
          </button>
          <AnimatePresence>
            {pinPanelOpen && (
              <motion.div {...collapseVariants} className="overflow-hidden">
                <div className="my-2 rounded-2xl border border-[var(--line)] bg-white/[0.02] p-4">
                  <p className="text-center text-xs text-[var(--muted)]">{pinEnabled ? "Введите PIN, чтобы отключить защиту" : "Установите 4-значный PIN"}</p>
                  <div className="pin-dots">
                    {Array.from({ length: 4 }, (_, index) => (
                      <span key={index} className={index < pin.length ? "filled" : ""} />
                    ))}
                  </div>
                  <div className="numpad">
                    {["1", "2", "3", "4", "5", "6", "7", "8", "9", "bio", "0", "del"].map((key) => (
                      <button
                        key={key}
                        disabled={settingPin || disablingPin}
                        onClick={() => pressPinKey(key)}
                      >
                        {key === "del" ? <Delete size={16} /> : key === "bio" ? <Fingerprint size={16} /> : key}
                      </button>
                    ))}
                  </div>
                  {pinError && <p className="mt-3 text-center text-xs text-red-400">{pinError}</p>}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div id="account-passwords" className="my-3 rounded-2xl border border-[var(--line)] bg-white/[0.02] p-4">
            <p className="text-sm font-semibold">Пароли аккаунта</p>
            <p className="mt-1 text-xs leading-5 text-[var(--muted)]">Пароль входа заменяет код из письма, дополнительный пароль спрашивается после входа. Минимальная длина — 12 символов.</p>
            <div className="mt-3 flex gap-2">
              <input type="password" value={loginPasswordValue} onChange={(event) => setLoginPasswordValue(event.target.value)} placeholder={accountAuth?.loginPasswordEnabled ? "Текущий или новый пароль входа" : "Новый пароль входа"} className="glass-input !min-h-9 min-w-0 flex-1" />
              <button disabled={settingLoginPassword || loginPasswordValue.length < 12} onClick={() => void runAccountSecurity(() => setLoginPassword({ password: loginPasswordValue }))} className="text-xs font-semibold text-[var(--accent1)] disabled:opacity-40">Сохранить</button>
              {accountAuth?.loginPasswordEnabled && <button disabled={disablingLoginPassword || loginPasswordValue.length < 12} onClick={() => void runAccountSecurity(() => disableLoginPassword({ password: loginPasswordValue }))} className="text-xs text-red-400 disabled:opacity-40">Отключить</button>}
            </div>
            <div className="mt-3 flex gap-2">
              <input type="password" value={additionalPasswordValue} onChange={(event) => setAdditionalPasswordValue(event.target.value)} placeholder={accountAuth?.additionalPasswordEnabled ? "Текущий или новый доп. пароль" : "Новый дополнительный пароль"} className="glass-input !min-h-9 min-w-0 flex-1" />
              <button disabled={settingAdditionalPassword || additionalPasswordValue.length < 12} onClick={() => void runAccountSecurity(() => setAdditionalPassword({ password: additionalPasswordValue }))} className="text-xs font-semibold text-[var(--accent1)] disabled:opacity-40">Сохранить</button>
              {accountAuth?.additionalPasswordEnabled && <button disabled={disablingAdditionalPassword || additionalPasswordValue.length < 12} onClick={() => void runAccountSecurity(() => disableAdditionalPassword({ password: additionalPasswordValue }))} className="text-xs text-red-400 disabled:opacity-40">Отключить</button>}
            </div>
            <p className="mt-2 text-[10px] text-[var(--muted)]">Пароль входа: {accountAuth?.loginPasswordEnabled ? "включён" : "выключен"} · дополнительный пароль: {accountAuth?.additionalPasswordEnabled ? "включён" : "выключен"}</p>
            {passwordError && <p className="mt-2 text-xs text-red-400">{passwordError}</p>}
          </div>

          <div id="webauthn-settings" className="my-3 rounded-2xl border border-[var(--line)] bg-white/[0.02] p-4">
            <p className="flex items-center gap-2 text-sm font-semibold"><Fingerprint size={16} /> Биометрия устройства</p>
            <p className="mt-1 text-xs leading-5 text-[var(--muted)]">Лицо, отпечаток или Windows Hello выбирает система; Wyre хранит только публичный ключ.</p>
            {webAuthnStatus?.credentials.length ? (
              <>
                <div className="settings-row mt-3">
                  <span className="flex-1 text-sm">Блокировать приложение после {webAuthnStatus.appLockMinutes} мин. бездействия</span>
                  <Toggle checked={webAuthnStatus.appEnabled} onChange={() => void toggleWebAuthnScope("app", !webAuthnStatus.appEnabled)} />
                </div>
                <div className="settings-row">
                  <span className="flex-1 text-sm">Подтверждать вход в аккаунт</span>
                  <Toggle checked={webAuthnStatus.accountEnabled} onChange={() => void toggleWebAuthnScope("account", !webAuthnStatus.accountEnabled)} />
                </div>
                {webAuthnStatus.credentials.map((credential) => (
                  <div key={credential.id} className="mt-3 flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
                    <span>{credential.name} · {new Date(credential.createdAt).toLocaleDateString("ru-RU")}</span>
                    <button disabled={removingWebAuthn} onClick={() => void removeCredential(credential.id)} className="font-semibold text-red-400">Удалить</button>
                  </div>
                ))}
              </>
            ) : (
              <GlassButton
                disabled={beginningWebAuthn || finishingWebAuthn || changingWebAuthn}
                onClick={() => void enableWebAuthnScope("app")}
                className="mt-3 w-full text-xs"
              >
                <Fingerprint size={15} /> Добавить биометрию
              </GlassButton>
            )}
            {webAuthnError && <p className="mt-3 text-xs text-red-400">{webAuthnError}</p>}
          </div>

          <p className="mb-2 mt-4 text-xs font-medium text-[var(--muted)]">{decoyEnabled ? "Decoy-режим включён · введите код для отключения" : "Decoy-код открывает отдельный пустой аккаунт"}</p>
          <input
            type="password"
            inputMode="numeric"
            value={decoy}
            disabled={!pinEnabled || settingDecoy || disablingDecoy}
            onChange={(event) => {
              const value = event.target.value.replace(/\D/g, "").slice(0, 4);
              setDecoy(value);
              if (value.length === 4) void submitDecoyCode(value);
            }}
            className="glass-input"
            placeholder="0000"
          />
          {!pinEnabled && <p className="mt-2 text-xs text-[var(--muted)]">Сначала включите основной PIN-код.</p>}
          {decoyError && <p className="mt-2 text-xs text-red-400">{decoyError}</p>}
        </SettingsCard>

        <SettingsCard
          id="devices"
          title="Устройства"
          subtitle={`${sessionList.length} активных сессии`}
          icon={<Laptop size={18} />}
          open={!!open.devices}
          onToggle={() => toggle("devices")}
        >
          <div className="settings-row mb-3">
            <ShieldCheck size={17} />
            <span className="flex-1 text-sm font-medium">Подтверждать вход с нового устройства</span>
            <Toggle checked={deviceApprovalEnabled} onChange={() => void toggleDeviceApproval()} />
          </div>
          {sessionList.map((session) => (
            <div key={session.id} className="session-row">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-white/5">
                <Laptop size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {session.device} {session.current && <span className="text-[var(--accent1)]">· это устройство</span>}
                </p>
                <p className="mt-0.5 text-xs text-[var(--muted)]">
                  {session.network} · {new Date(session.lastActive).toLocaleString("ru-RU")}
                </p>
              </div>
              {!session.current && !session.approved && (
                <div className="flex gap-2">
                  <button
                    onClick={() => void resolveDeviceApproval(session.id, true)}
                    className="text-xs font-semibold text-emerald-400"
                  >
                    Разрешить
                  </button>
                  <button
                    onClick={() => void resolveDeviceApproval(session.id, false)}
                    className="text-xs font-semibold text-red-400"
                  >
                    Отклонить
                  </button>
                </div>
              )}
              {!session.current && session.approved && (
                <button
                  onClick={() => revokeSession({ sessionId: session.id })}
                  className="text-xs font-semibold text-red-400"
                >
                  Завершить
                </button>
              )}
            </div>
          ))}
          {changingDeviceApproval && <p className="mt-2 text-xs text-[var(--muted)]">Сохраняем настройку…</p>}
          {sessionList.some((session) => !session.current) && <button onClick={() => revokeOthers({})} className="mt-3 text-xs font-semibold text-red-400">Завершить все остальные сессии</button>}
          <div className="mt-4">
            <QrLoginBlock />
          </div>
        </SettingsCard>

        <SettingsCard
          id="data"
          title="Данные"
          subtitle="Экспорт и восстановление личных данных"
          icon={<Database size={18} />}
          open={!!open.data}
          onToggle={() => toggle("data")}
        >
          <div className="mb-4 rounded-2xl border border-[var(--line)] bg-white/[0.02] p-4">
            <div className="flex items-center justify-between text-xs text-[var(--muted)]"><span>Загружено на сервер</span><span>{storageUsage ? `${(storageUsage.bytes / 1024 / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ · ${storageUsage.fileCount} файлов` : "Считаем…"}</span></div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <PrimaryButton onClick={() => runExport("txt")} className="flex-1">
              <Download size={16} /> {exportState === "working" ? "Экспортируем…" : exportState === "done" ? "Экспорт готов" : "Скачать TXT"}
            </PrimaryButton>
            <GlassButton onClick={() => runExport("pdf")} className="!h-12 flex-1 !w-auto gap-2 px-4 text-xs font-semibold" title="Скачать PDF">
              <Download size={16} /> PDF
            </GlassButton>
            <GlassButton onClick={() => runExport("json")} className="!h-12 flex-1 !w-auto gap-2 px-4 text-xs font-semibold" title="Скачать полный JSON-экспорт">
              <Users size={16} /> JSON
            </GlassButton>
          </div>
          <div className="mt-4 rounded-2xl border border-[var(--line)] p-4">
            <p className="text-sm font-medium">Восстановление из JSON-экспорта</p>
            <p className="mt-1 text-[11px] text-[var(--muted)]">Восстанавливаются только ваши личные данные: настройки, био, черновики, избранное, напоминания, отложенные сообщения и чёрный список. Переписка других участников, вложения и параметры безопасности не импортируются.</p>
            <button onClick={() => void pickBackupFile()} className="mt-3 text-xs font-semibold text-[var(--accent1)]">Выбрать файл экспорта</button>
            {restoreState?.plan && (
              <div className="mt-3 text-[11px] text-[var(--muted)]">
                <p>Будет восстановлено: черновиков {String(restoreState.plan.drafts)}, избранного {String(restoreState.plan.bookmarks)}, напоминаний {String(restoreState.plan.reminders)}, отложенных {String(restoreState.plan.scheduledMessages)}, блокировок {String(restoreState.plan.userBlocks)}.</p>
                <button onClick={() => void applyBackup()} className="mt-2 text-xs font-semibold text-emerald-400">Восстановить</button>
              </div>
            )}
            {restoreState?.applied && <p className="mt-3 text-[11px] text-emerald-400">Восстановление завершено.</p>}
            {restoreState?.error && <p className="mt-3 text-[11px] text-red-400">{restoreState.error}</p>}
          </div>
        </SettingsCard>
      </div>
    </section>
  );
}
