import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { logout, wyreMutation, wyreQuery } from "../../lib/api";
import {
  AlertCircle,
  AtSign,
  Camera,
  Check,
  Clock3,
  Edit3,
  ExternalLink,
  Loader2,
  LogOut,
  Phone,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { Avatar, Field, PrimaryButton, UserBadge, WarningIndicator } from "./Glass";
import { popVariants } from "../utils/motion";
import { uploadSignedFile } from "../utils/upload";
import type { WyreProfile } from "../session";

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" });
}

function formatPhone(value: string | null) {
  if (!value) return "Не привязан";
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11) {
    return `+${digits[0]} ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`;
  }
  return `+${digits}`;
}

export function AccountScreen({
  profile,
  onProfileChange,
  isAdmin,
  onOpenAdminPanel,
}: {
  profile: WyreProfile;
  onProfileChange: () => void;
  isAdmin: boolean;
  onOpenAdminPanel: () => void;
}) {
  const [editingUsername, setEditingUsername] = useState(false);
  const [username, setUsername] = useState(profile.username);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [bio, setBio] = useState(profile.bio);
  const [editingPhone, setEditingPhone] = useState(false);
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { data: accountAuth, refetch: refetchAccountAuth } = useQuery(wyreQuery<{
    email: string;
    loginPasswordEnabled: boolean;
    additionalPasswordEnabled: boolean;
    yandexLinked: boolean;
    canUnlinkYandex: boolean;
  }>("wyre.accountAuthStatus", {}));
  const { mutateAsync: unlinkYandex, isPending: unlinkingYandex } = useMutation(wyreMutation("wyre.unlinkYandex"));
  const { mutateAsync: requestAvatarUpload } = useMutation(wyreMutation("wyre.requestAvatarUpload"));
  const { mutateAsync: setAvatar } = useMutation(wyreMutation("wyre.setAvatar"));
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setUsername(profile.username);
    setBio(profile.bio);
    setPhone(profile.phone ?? "");
  }, [profile.username, profile.bio, profile.phone]);

  const { mutateAsync: updateProfile, isPending: isSaving } = useMutation(wyreMutation("wyre.updateProfile"));
  const { mutateAsync: setPhoneRemote, isPending: isSavingPhone } = useMutation(wyreMutation("wyre.setPhone"));

  const dirty = bio.trim() !== profile.bio || username.trim().replace(/^@/, "") !== profile.username;

  async function save(next?: { username?: string; bio?: string }) {
    setError(null);
    try {
      await updateProfile({
        name: profile.name,
        username: (next?.username ?? username).trim().replace(/^@/, ""),
        bio: next?.bio ?? bio,
      });
      setEditingUsername(false);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
      onProfileChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить профиль");
      setUsername(profile.username);
    }
  }

  async function savePhone() {
    setError(null);
    try {
      await setPhoneRemote({ phone: phone.trim() });
      setEditingPhone(false);
      onProfileChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить номер");
    }
  }

  async function uploadAvatar(file: File) {
    setError(null);
    setAvatarBusy(true);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("Аватар должен быть меньше 10 МБ");
      const contentType = file.type || "image/jpeg";
      const { url, fields, filePath } = (await requestAvatarUpload({ fileName: file.name, fileSize: file.size, contentType })) as {
        url: string;
        fields: Record<string, string>;
        filePath: string;
      };
      await uploadSignedFile({ url, fields, file, fileName: file.name });
      await setAvatar({ filePath, mimeType: contentType });
      onProfileChange();
    } catch (avatarError) {
      setError(avatarError instanceof Error ? avatarError.message : "Не удалось загрузить аватар");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function removeAvatar() {
    setError(null);
    setAvatarBusy(true);
    try {
      await setAvatar({ filePath: null });
      onProfileChange();
    } catch (avatarError) {
      setError(avatarError instanceof Error ? avatarError.message : "Не удалось удалить аватар");
    } finally {
      setAvatarBusy(false);
    }
  }

  return (
    <section className="section-screen overflow-y-auto pb-24 md:pb-8">
      <div className="section-header">
        <div>
          <p className="eyebrow">Профиль</p>
          <h1>Аккаунт</h1>
        </div>
        <button
          onClick={async () => {
            await logout();
            window.location.reload();
          }}
          className="glass-button !w-auto gap-2 !px-3 text-xs"
        >
          <LogOut size={15} /> Выйти
        </button>
      </div>
      <div className="mx-auto w-full max-w-xl px-5 py-8">
        <div className="flex flex-col items-center text-center">
          <div className="relative">
            <Avatar initials={profile.initials} colors={profile.colors} size="xl" presence="online" avatarUrl={profile.avatarUrl} />
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void uploadAvatar(file);
              }}
            />
            <button
              onClick={() => avatarInputRef.current?.click()}
              disabled={avatarBusy}
              title="Загрузить аватар"
              className="absolute bottom-0 right-0 grid h-9 w-9 place-items-center rounded-full border-4 border-[var(--bg)] bg-[var(--accent1)] text-white disabled:opacity-60"
            >
              {avatarBusy ? <Loader2 size={15} className="animate-spin" /> : <Camera size={15} />}
            </button>
          </div>
          {profile.avatarUrl && (
            <button onClick={() => void removeAvatar()} disabled={avatarBusy} className="mt-3 text-[11px] text-[var(--muted)] transition hover:text-red-400">
              Удалить аватар
            </button>
          )}
          <div className="mt-5 flex items-center gap-2">
            <h2 className="text-xl font-semibold">{profile.name}</h2>
            <UserBadge kind={profile.badge ?? undefined} />
            <WarningIndicator warnings={profile.warnings.map((warning) => ({ reason: warning.reason, date: new Date(warning.issuedAt).toLocaleDateString("ru-RU") }))} />
          </div>
          <p className="mt-1 text-sm text-[var(--muted)]">@{profile.username}</p>
          <p className="mt-1 text-xs text-[var(--muted)]">{profile.email}</p>
        </div>

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="mt-6 flex items-start gap-2 rounded-2xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-300"
            >
              <AlertCircle size={15} className="mt-px shrink-0" />
              <span>{error}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {profile.warnings.length > 0 && (
          <div className="mt-6 space-y-2">
            {profile.warnings.map((warning, index) => (
              <div
                key={index}
                className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200"
              >
                <TriangleAlert size={15} className="mt-px shrink-0" />
                <span>
                  Предупреждение {index + 1} из 2 · {warning.reason}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="mt-8 space-y-4">
          <div className="relative">
            {editingUsername ? (
              <div className="flex items-end gap-2">
                <Field label="Username" value={username} onChange={setUsername} autoFocus />
                <button onClick={() => save()} disabled={isSaving} className="glass-button !w-12">
                  {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                </button>
              </div>
            ) : (
              <button className="settings-row w-full" onClick={() => setEditingUsername(true)}>
                <AtSign size={18} />
                <div className="flex-1 text-left">
                  <p className="text-sm font-medium">Username</p>
                  <p className="text-xs text-[var(--muted)]">@{profile.username}</p>
                </div>
                <Edit3 size={16} />
              </button>
            )}
            <button
              onClick={() => setHistoryOpen((value) => !value)}
              className="mt-1 flex items-center gap-1.5 pl-1 text-[11px] text-[var(--muted)] transition hover:text-[var(--text)]"
            >
              <Clock3 size={12} /> История изменений username
            </button>
            <AnimatePresence>
              {historyOpen && (
                <motion.div {...popVariants} className="glass-menu absolute left-0 top-full z-30 mt-1 w-64 p-2">
                  {profile.usernameHistory.length === 0 ? (
                    <div className="rounded-lg px-2 py-1.5 text-xs text-[var(--muted)]">Username ещё не менялся</div>
                  ) : (
                    profile.usernameHistory
                      .slice()
                      .reverse()
                      .map((entry, index) => (
                        <div key={index} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-xs text-[var(--muted)] hover:bg-white/5">
                          <span>@{entry.username}</span>
                          <span className="text-[10px] opacity-70">{formatDate(entry.changedAt)}</span>
                        </div>
                      ))
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <label className="block space-y-2">
            <span className="ml-1 text-xs font-medium text-[var(--muted)]">Описание</span>
            <textarea
              value={bio}
              maxLength={200}
              onChange={(event) => setBio(event.target.value)}
              className="glass-input min-h-20 resize-none"
              placeholder="Коротко о себе: чем занимаетесь, чем поделиться"
            />
          </label>

          {editingPhone ? (
            <div className="flex items-end gap-2">
              <Field label="Телефон" value={phone} onChange={setPhone} placeholder="+7 999 000-12-34" autoFocus />
              <button onClick={savePhone} disabled={isSavingPhone} className="glass-button !w-12">
                {isSavingPhone ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              </button>
            </div>
          ) : (
            <button className="settings-row w-full" onClick={() => setEditingPhone(true)}>
              <Phone size={18} />
              <div className="flex-1 text-left">
                <p className="text-sm font-medium">Телефон</p>
                <p className="text-xs text-[var(--muted)]">
                  {formatPhone(profile.phone)}
                  {profile.phone ? " · используется как второй фактор" : ""}
                </p>
              </div>
              <Edit3 size={16} />
            </button>
          )}

          <div className="settings-row">
            <ExternalLink size={18} />
            <div className="flex-1 text-left">
              <p className="text-sm font-medium">Yandex ID</p>
              <p className="text-xs text-[var(--muted)]">{accountAuth?.yandexLinked ? "Привязан к этому аккаунту" : "Вход через Яндекс ID не привязан"}</p>
            </div>
            {accountAuth?.yandexLinked ? (
              <button
                onClick={() => void unlinkYandex({}).then(() => refetchAccountAuth())}
                disabled={!accountAuth.canUnlinkYandex || unlinkingYandex}
                className="text-xs font-semibold text-red-400 disabled:opacity-40"
              >
                Отвязать
              </button>
            ) : (
              <button onClick={() => { window.location.href = "/auth/yandex/link"; }} className="text-xs font-semibold text-[var(--accent1)]">
                Привязать
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <PrimaryButton onClick={() => save()} disabled={!dirty || isSaving} className="flex-1">
              {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              Сохранить изменения
            </PrimaryButton>
            <AnimatePresence>
              {saved && (
                <motion.span
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  className="text-xs text-emerald-400"
                >
                  Сохранено
                </motion.span>
              )}
            </AnimatePresence>
          </div>

          {isAdmin && (
            <div className="mt-6 rounded-2xl border border-dashed border-[var(--line)] p-4">
              <div className="settings-row !border-b-0">
                <ShieldCheck size={18} />
                <span className="flex-1 text-left text-sm font-medium">
                  Роль: {profile.role === "admin" ? "администратор" : "модератор"}
                </span>
              </div>
              <PrimaryButton onClick={onOpenAdminPanel} className="mt-2 w-full">
                <ShieldCheck size={16} /> Открыть админ-панель
              </PrimaryButton>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
