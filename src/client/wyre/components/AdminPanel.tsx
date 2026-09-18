import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Ban, History, Laptop, Megaphone, PhoneCall, Search, Send, ShieldCheck, Trash2, TriangleAlert, User, X } from "lucide-react";

import { wyreLiveQuery, wyreMutation } from "../../lib/api";
import type { AdminLog, AdminUser, BadgeKind, SupportMessage, SupportThread } from "../data";
import { cn } from "../utils/cn";
import { modalVariants, pageVariants } from "../utils/motion";
import { Avatar, GlassButton, PrimaryButton, SegmentedControl, UserBadge } from "./Glass";

function formatRemaining(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "истекает";
  const totalMinutes = Math.ceil(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `осталось ${days} д ${hours} ч`;
  if (hours) return `осталось ${hours} ч ${minutes} мин`;
  return `осталось ${minutes} мин`;
}

function DurationFields({
  days, hours, minutes, onDays, onHours, onMinutes,
}: {
  days: string; hours: string; minutes: string;
  onDays: (value: string) => void; onHours: (value: string) => void; onMinutes: (value: string) => void;
}) {
  const field = "glass-input !min-h-9 w-full px-2 text-center text-sm" as const;
  const sanitize = (value: string) => value.replace(/[^\d]/g, "").slice(0, 4);
  return (
    <div className="mt-3 flex items-center gap-2">
      <input inputMode="numeric" value={days} onChange={(event) => onDays(sanitize(event.target.value))} className={field} placeholder="0" aria-label="Дни" />
      <span className="text-xs text-[var(--muted)]">д</span>
      <input inputMode="numeric" value={hours} onChange={(event) => onHours(sanitize(event.target.value))} className={field} placeholder="0" aria-label="Часы" />
      <span className="text-xs text-[var(--muted)]">ч</span>
      <input inputMode="numeric" value={minutes} onChange={(event) => onMinutes(sanitize(event.target.value))} className={field} placeholder="0" aria-label="Минуты" />
      <span className="text-xs text-[var(--muted)]">мин</span>
    </div>
  );
}

function ReasonModal({
  title,
  actionLabel,
  user,
  allowDuration = false,
  foreverLabel = "Навсегда",
  cascadeLabel,
  onClose,
  onSubmit,
}: {
  title: string;
  actionLabel: string;
  user: AdminUser;
  allowDuration?: boolean;
  foreverLabel?: string;
  cascadeLabel?: string;
  onClose: () => void;
  onSubmit: (reason: string, durationMinutes: number | null, cascadeDevices: boolean) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [timed, setTimed] = useState(true);
  const [days, setDays] = useState("1");
  const [hours, setHours] = useState("0");
  const [minutes, setMinutes] = useState("0");
  const [cascadeDevices, setCascadeDevices] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const durationMinutes = Number(days || 0) * 1440 + Number(hours || 0) * 60 + Number(minutes || 0);

  async function submit() {
    if (reason.trim().length < 3) return setError("Укажите причину минимум из 3 символов");
    if (allowDuration && timed && durationMinutes <= 0) return setError("Укажите срок больше нуля");
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim(), allowDuration && timed ? durationMinutes : null, cascadeDevices);
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось выполнить действие");
    } finally {
      setBusy(false);
    }
  }

  const invalid = reason.trim().length < 3 || (allowDuration && timed && durationMinutes <= 0);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <motion.div {...modalVariants} onClick={(event) => event.stopPropagation()} className="modal-shell !max-w-md">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title} {user.name}</h2>
          <GlassButton onClick={onClose}><X size={16} /></GlassButton>
        </div>
        {allowDuration && (
          <>
            <div className="mt-5">
              <SegmentedControl
                layoutId="punishment-mode"
                value={timed ? "timed" : "forever"}
                onChange={(value) => setTimed(value === "timed")}
                options={[{ value: "timed", label: "На срок" }, { value: "forever", label: foreverLabel }]}
              />
            </div>
            {timed && <DurationFields days={days} hours={hours} minutes={minutes} onDays={setDays} onHours={setHours} onMinutes={setMinutes} />}
          </>
        )}
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="glass-input mt-5 min-h-24 resize-none"
          placeholder="Обязательная причина"
          maxLength={500}
          autoFocus
        />
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        {cascadeLabel && (
          <label className="mt-4 flex items-start gap-2 text-xs text-[var(--muted)]">
            <input type="checkbox" checked={cascadeDevices} onChange={(event) => setCascadeDevices(event.target.checked)} className="mt-0.5" />
            <span>{cascadeLabel}</span>
          </label>
        )}
        <PrimaryButton tone="accent" disabled={busy || invalid} onClick={() => void submit()} className="mt-5 w-full">
          <TriangleAlert size={16} /> {busy ? "Сохраняем…" : actionLabel}
        </PrimaryButton>
      </motion.div>
    </div>
  );
}

function DevicePanel({ user }: { user: AdminUser }) {
  const { data: devices = [] } = useQuery(wyreLiveQuery<{
    deviceId: string;
    platform: string;
    browser: string;
    firstSeenAt: string;
    lastSeenAt: string;
    activeSessions: number;
    accountCount: number;
    shared: boolean;
    banned: boolean;
    banReason: string | null;
  }[]>("wyre.adminUserDevices", { targetId: user.id }));
  const { mutateAsync: banDevice } = useMutation(wyreMutation("wyre.banDevice"));
  const { mutateAsync: unbanDevice } = useMutation(wyreMutation("wyre.unbanDevice"));
  const [banDeviceTarget, setBanDeviceTarget] = useState<{ deviceId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try { await action(); }
    catch (deviceError) { setError(deviceError instanceof Error ? deviceError.message : "Не удалось изменить устройство"); }
  }

  return (
    <div className="mt-2 w-full rounded-2xl border border-[var(--line)] p-3">
      <p className="text-[11px] font-semibold text-[var(--muted)]">Устройства аккаунта</p>
      <p className="mt-1 text-[10px] text-[var(--muted)]">Wyre распознаёт браузерный профиль. Очистка данных браузера, приватный режим или переустановка создают новую запись.</p>
      {devices.map((device) => (
        <div key={device.deviceId} className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-white/[0.03] px-2 py-2">
          <span className="min-w-0 flex-1 text-[11px]">
            <span className="block font-medium">{device.platform} · {device.browser}</span>
            <span className="block text-[10px] text-[var(--muted)]">
              активных сессий: {device.activeSessions} · аккаунтов: {device.accountCount}
              {device.shared ? " · возможно общее устройство" : ""}
              {device.banned ? ` · заблокировано${device.banReason ? `: ${device.banReason}` : ""}` : ""}
            </span>
          </span>
          {device.banned ? (
            <button onClick={() => void run(() => unbanDevice({ deviceId: device.deviceId, targetId: user.id }))} className="text-[10px] font-semibold text-emerald-400">Разблокировать</button>
          ) : (
            <button onClick={() => setBanDeviceTarget({ deviceId: device.deviceId })} className="text-[10px] font-semibold text-red-400">
              Заблокировать
            </button>
          )}
        </div>
      ))}
      {!devices.length && <p className="mt-2 text-[10px] text-[var(--muted)]">Устройства не зафиксированы</p>}
      {error && <p className="mt-2 text-[10px] text-red-400">{error}</p>}
      <AnimatePresence>
        {banDeviceTarget && (
          <ReasonModal
            title="Заблокировать устройство"
            actionLabel="Подтвердить блокировку"
            user={user}
            allowDuration
            onClose={() => setBanDeviceTarget(null)}
            onSubmit={(reason, durationMinutes) => banDevice({ deviceId: banDeviceTarget.deviceId, targetId: user.id, reason, durationMinutes }) as Promise<void>}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function SupportPanel() {
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastText, setBroadcastText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: threads = [] } = useQuery(wyreLiveQuery<SupportThread[]>("wyre.adminSupportThreads", {}));
  const { data: messages = [] } = useQuery({ ...wyreLiveQuery<SupportMessage[]>("wyre.adminSupportMessages", { userId: activeUserId ?? "" }), enabled: Boolean(activeUserId) });
  const { mutateAsync: sendReply } = useMutation(wyreMutation("wyre.adminSendSupportMessage"));
  const { mutateAsync: sendBroadcast } = useMutation(wyreMutation("wyre.adminBroadcastMessage"));
  const active = threads.find((thread) => thread.userId === activeUserId) ?? null;

  async function run(action: () => Promise<unknown>, success?: () => void) {
    setError(null);
    setBusy(true);
    try {
      await action();
      success?.();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Не удалось выполнить действие");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-[var(--muted)]">Переписка от имени официального аккаунта Wyre: ответы на вопросы и личные уведомления.</p>
        <button onClick={() => setBroadcastOpen(true)} className="glass-button !h-8 !w-auto gap-1.5 px-2.5 text-[10px]">
          <Megaphone size={12} /> Отправить всем
        </button>
      </div>
      {error && <p className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>}
      <div className="glass-panel !rounded-2xl px-3">
        {threads.map((thread) => (
          <button key={thread.chatId} onClick={() => setActiveUserId(thread.userId)} className={cn("admin-row w-full text-left", activeUserId === thread.userId && "bg-white/[0.04]")}>
            <Avatar initials={thread.initials} colors={thread.colors} size="sm" />
            <div className="min-w-40 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-semibold">{thread.name}</span>
                <span className="text-xs text-[var(--muted)]">{thread.username}</span>
              </div>
              <p className="truncate text-xs text-[var(--muted)]">{thread.fromSupport ? "Wyre: " : ""}{thread.last}</p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="text-[10px] text-[var(--muted)]">{new Date(thread.lastMessageAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
              {thread.unread > 0 && <span className="rounded-full bg-[var(--accent1)] px-1.5 text-[9px] font-bold text-white">{thread.unread}</span>}
            </div>
          </button>
        ))}
        {!threads.length && <p className="px-2 py-6 text-sm text-[var(--muted)]">Обращений пока нет</p>}
      </div>

      {active && (
        <div className="glass-panel mt-4 !rounded-2xl p-3">
          <div className="flex items-center gap-2 border-b border-[var(--line)] pb-2">
            <PhoneCall size={14} className="text-[var(--accent1)]" />
            <p className="min-w-0 flex-1 truncate text-xs font-semibold">Чат с {active.name} от имени Wyre</p>
            <GlassButton onClick={() => setActiveUserId(null)} title="Закрыть"><X size={14} /></GlassButton>
          </div>
          <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
            {messages.map((message) => (
              <div key={message.id} className={cn("flex", message.fromSupport ? "justify-end" : "justify-start")}>
                <div className={cn(
                  "max-w-[80%] rounded-xl px-3 py-2 text-xs leading-5",
                  message.fromSupport ? "bg-[var(--accent1)]/25" : "bg-white/[0.06]",
                )}>
                  <p className="whitespace-pre-wrap break-words">{message.text}</p>
                  <p className="mt-1 text-right text-[9px] text-[var(--muted)]">{new Date(message.createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</p>
                </div>
              </div>
            ))}
            {!messages.length && <p className="py-4 text-center text-xs text-[var(--muted)]">Сообщений ещё нет</p>}
          </div>
          <div className="mt-3 flex items-end gap-2">
            <textarea
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              placeholder="Ответ от имени Wyre"
              maxLength={4000}
              className="glass-input min-h-10 flex-1 resize-none py-2 text-xs"
              rows={2}
            />
            <button
              onClick={() => {
                const text = reply.trim();
                if (!text) return;
                void run(() => sendReply({ userId: active.userId, text }), () => setReply(""));
              }}
              disabled={busy || !reply.trim()}
              className="glass-button !h-10 !w-10 shrink-0 disabled:opacity-50"
              title="Отправить"
            >
              <Send size={15} />
            </button>
          </div>
        </div>
      )}

      <AnimatePresence>
        {broadcastOpen && (
          <div className="modal-backdrop" onClick={() => setBroadcastOpen(false)}>
            <motion.div {...modalVariants} onClick={(event) => event.stopPropagation()} className="modal-shell !max-w-md">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Уведомление всем</h2>
                <GlassButton onClick={() => setBroadcastOpen(false)}><X size={16} /></GlassButton>
              </div>
              <p className="mt-2 text-xs text-[var(--muted)]">Сообщение придёт в чат Wyre каждому пользователю от имени официального аккаунта.</p>
              <textarea
                value={broadcastText}
                onChange={(event) => setBroadcastText(event.target.value)}
                className="glass-input mt-4 min-h-24 resize-none"
                placeholder="Текст уведомления"
                maxLength={2000}
                autoFocus
              />
              <PrimaryButton
                disabled={busy || broadcastText.trim().length < 1}
                onClick={() => {
                  const text = broadcastText.trim();
                  if (!text) return;
                  void run(() => sendBroadcast({ text }), () => { setBroadcastOpen(false); setBroadcastText(""); });
                }}
                className="mt-5 w-full"
              >
                <Send size={16} /> {busy ? "Отправляем…" : "Отправить всем"}
              </PrimaryButton>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"users" | "support" | "log">("users");
  const [warningTarget, setWarningTarget] = useState<AdminUser | null>(null);
  const [banTarget, setBanTarget] = useState<AdminUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [deviceTarget, setDeviceTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: users = [], isLoading } = useQuery(wyreLiveQuery<AdminUser[]>("wyre.adminUsers", { query }));
  const { data: log = [] } = useQuery({ ...wyreLiveQuery<AdminLog[]>("wyre.adminLog", {}), enabled: tab === "log" });
  const { mutateAsync: issueWarning } = useMutation(wyreMutation("wyre.issueWarning"));
  const { mutateAsync: removeWarning } = useMutation(wyreMutation("wyre.removeWarning"));
  const { mutateAsync: setBadgeMutation } = useMutation(wyreMutation("wyre.setUserBadge"));
  const { mutateAsync: setRoleMutation } = useMutation(wyreMutation("wyre.setUserRole"));
  const { mutateAsync: banUser } = useMutation(wyreMutation("wyre.banUser"));
  const { mutateAsync: unbanUser } = useMutation(wyreMutation("wyre.unbanUser"));
  const { mutateAsync: deleteUserAccount } = useMutation(wyreMutation("wyre.deleteUserAccount"));

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Не удалось выполнить действие");
    }
  }

  function setBadge(user: AdminUser, badge?: BadgeKind) {
    void run(() => setBadgeMutation({ targetId: user.id, badge: badge ?? null }));
  }

  return (
    <motion.div {...pageVariants} className="fixed inset-0 z-[150] overflow-y-auto bg-[var(--bg)]">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-[var(--line)] bg-[var(--surface-solid)]/85 px-5 py-4 backdrop-blur-xl sm:px-10">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-blue-600 text-white"><ShieldCheck size={17} /></span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">Админ-панель</h1>
          <p className="text-xs text-[var(--muted)]">MongoDB · серверная проверка прав · журнал действий</p>
        </div>
        <GlassButton onClick={onClose} title="Закрыть"><X size={18} /></GlassButton>
      </header>

      <div className="mx-auto max-w-4xl px-5 py-6 sm:px-10">
        <SegmentedControl
          layoutId="admin-tabs"
          value={tab}
          onChange={setTab}
          options={[{ value: "users", label: "Пользователи" }, { value: "support", label: "Поддержка" }, { value: "log", label: "Лог действий" }]}
        />
        {error && <p className="mt-4 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>}

        {tab === "users" && (
          <>
            <label className="search-box mb-4 mt-5 max-w-sm">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Имя, username или email" />
            </label>
            <div className="glass-panel !rounded-2xl px-3">
              {users.map((user) => (
                <div key={user.id} className="admin-row flex-wrap">
                  <Avatar initials={user.initials} colors={user.colors} size="sm" />
                  <div className="min-w-40 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-semibold">{user.name}</span>
                      <UserBadge kind={user.badge} size={15} />
                      <span className={cn("role-chip", `role-${user.role}`)}>{user.role}</span>
                    {user.banned && (
                      <span className="banned-chip" title={user.banReason ?? undefined}>
                        заблокирован{user.bannedUntil && new Date(user.bannedUntil).getFullYear() < 9999 ? ` · ${formatRemaining(user.bannedUntil)}` : ""}
                      </span>
                    )}
                  </div>
                    <p className="text-xs text-[var(--muted)]">{user.username}</p>
                    {user.warningDetails?.map((warning) => (
                      <p key={warning.issuedAt} className="mt-1 flex items-center gap-2 text-[10px] text-amber-400">
                        <span className="min-w-0 flex-1 truncate">
                          {warning.reason}{warning.expiresAt ? ` · ${formatRemaining(warning.expiresAt)}` : ""}
                        </span>
                        <button
                          onClick={() => void run(() => removeWarning({ targetId: user.id, issuedAt: warning.issuedAt }))}
                          className="shrink-0 font-semibold text-emerald-400"
                          title="Снять предупреждение"
                        >
                          снять
                        </button>
                      </p>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <button onClick={() => setWarningTarget(user)} disabled={user.warnings >= 2} className="warning-chip" title="Выдать предупреждение">
                      <TriangleAlert size={10} /> {user.warnings}/2
                    </button>
                    <button onClick={() => setBadge(user, user.badge === "official" ? undefined : "official")} className={cn("glass-button !h-8 !w-8", user.badge === "official" && "glass-button-active")} title="Бейдж Official">
                      <ShieldCheck size={13} />
                    </button>
                    <button onClick={() => setBadge(user, user.badge === "dev" ? undefined : "dev")} className={cn("glass-button !h-8 !w-8", user.badge === "dev" && "glass-button-active")} title="Бейдж Dev">
                      <span className="text-[9px] font-bold">&lt;/&gt;</span>
                    </button>
                    {user.role !== "owner" && (
                      <select
                        value={user.role}
                        onChange={(event) => void run(() => setRoleMutation({ targetId: user.id, role: event.target.value }))}
                        className="glass-select !min-h-8 !w-28 !px-2 text-xs"
                        title="Роль"
                      >
                        <option value="user">user</option>
                        <option value="moderator">moderator</option>
                        <option value="admin">admin</option>
                      </select>
                    )}
                    {user.banned ? (
                      <button onClick={() => void run(() => unbanUser({ targetId: user.id }))} className="glass-button !h-8 !w-auto px-2 text-[10px] text-emerald-400">Разбан</button>
                    ) : (
                      <button onClick={() => setBanTarget(user)} className="glass-button !h-8 !w-8 !text-red-400" title="Заблокировать"><Ban size={13} /></button>
                    )}
                    {user.role !== "owner" && (
                      <button onClick={() => setDeleteTarget(user)} className="glass-button !h-8 !w-8 !text-red-400" title="Удалить аккаунт навсегда"><Trash2 size={13} /></button>
                    )}
                    <button onClick={() => setDeviceTarget(deviceTarget === user.id ? null : user.id)} className={cn("glass-button !h-8 !w-8", deviceTarget === user.id && "glass-button-active")} title="Устройства">
                      <Laptop size={13} />
                    </button>
                  </div>
                  {deviceTarget === user.id && <DevicePanel user={user} />}
                </div>
              ))}
              {!users.length && <div className="flex items-center gap-2 px-2 py-6 text-sm text-[var(--muted)]"><User size={16} /> {isLoading ? "Загружаем…" : "Пользователи не найдены"}</div>}
            </div>
          </>
        )}

        {tab === "support" && <SupportPanel />}

        {tab === "log" && (
          <div className="glass-panel mt-5 !rounded-2xl px-3">
            {log.map((entry) => (
              <div key={entry.id} className="admin-row">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/5"><History size={15} /></span>
                <div className="min-w-0 flex-1"><p className="text-sm">{entry.action}</p><p className="text-xs text-[var(--muted)]">{entry.actor} · {entry.time}</p></div>
              </div>
            ))}
            {!log.length && <p className="px-2 py-6 text-sm text-[var(--muted)]">Действий пока нет</p>}
          </div>
        )}
      </div>

      <AnimatePresence>
        {warningTarget && (
          <ReasonModal
            title="Предупредить"
            actionLabel="Выдать предупреждение"
            user={warningTarget}
            allowDuration
            foreverLabel="Бессрочно"
            onClose={() => setWarningTarget(null)}
            onSubmit={(reason, durationMinutes) => issueWarning({ targetId: warningTarget.id, reason, durationMinutes }) as Promise<void>}
          />
        )}
        {banTarget && (
          <ReasonModal
            title="Заблокировать"
            actionLabel="Подтвердить блокировку"
            user={banTarget}
            allowDuration
            cascadeLabel="Также заблокировать все устройства аккаунта. Внимание: устройство может быть общим для семьи."
            onClose={() => setBanTarget(null)}
            onSubmit={(reason, durationMinutes, cascadeDevices) => banUser({ targetId: banTarget.id, reason, durationMinutes, cascadeDevices }) as Promise<void>}
          />
        )}
        {deleteTarget && (
          <ReasonModal
            title="Удалить аккаунт"
            actionLabel="Удалить навсегда"
            user={deleteTarget}
            onClose={() => setDeleteTarget(null)}
            onSubmit={(reason) => deleteUserAccount({ targetId: deleteTarget.id, reason }) as Promise<void>}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
