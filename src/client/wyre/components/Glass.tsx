import type { CSSProperties, ReactNode } from "react";
import { motion } from "motion/react";
import { Check, TriangleAlert } from "lucide-react";
import { cn } from "../utils/cn";
import type { BadgeKind, Presence, Warning } from "../data";

/**
 * Этап 0 — фундамент: единая liquid-glass система.
 * Все панели / кнопки / инпуты во всём приложении используют эти компоненты,
 * а не пишут backdrop-filter заново на каждом экране.
 */

type GlassVariant = "panel" | "heavy" | "pill";

export function GlassPanel({
  children,
  className,
  variant = "panel",
  style,
  as: Component = "div",
}: {
  children?: ReactNode;
  className?: string;
  variant?: GlassVariant;
  style?: CSSProperties;
  as?: "div" | "section" | "header" | "nav";
}) {
  return (
    <Component
      className={cn(
        "glass-surface",
        variant === "heavy" && "glass-surface-heavy",
        variant === "pill" && "glass-surface-pill",
        className,
      )}
      style={style}
    >
      <span className="glass-specular" aria-hidden="true" />
      <span className="glass-content">{children}</span>
    </Component>
  );
}

export function GlassButton({
  children,
  className,
  active,
  title,
  onClick,
  type = "button",
  disabled,
}: {
  children: ReactNode;
  className?: string;
  active?: boolean;
  title?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  return (
    <motion.button
      whileTap={disabled ? undefined : { scale: 0.9 }}
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn("glass-button", active && "glass-button-active", className)}
    >
      {children}
    </motion.button>
  );
}

export function PrimaryButton({
  children,
  disabled,
  className,
  onClick,
  type = "button",
  tone = "accent",
}: {
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  tone?: "accent" | "danger";
}) {
  return (
    <motion.button
      whileHover={disabled ? undefined : { y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.98 }}
      disabled={disabled}
      onClick={onClick}
      type={type}
      className={cn("primary-button", tone === "danger" && "primary-button-danger", className)}
    >
      {children}
    </motion.button>
  );
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  maxLength,
  autoFocus,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  maxLength?: number;
  autoFocus?: boolean;
  hint?: string;
}) {
  return (
    <label className="block space-y-2">
      <span className="ml-1 text-xs font-medium text-[var(--muted)]">{label}</span>
      <input
        className="glass-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        maxLength={maxLength}
        autoFocus={autoFocus}
      />
      {hint && <span className="ml-1 block text-[11px] text-[var(--muted)]">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} className={cn("toggle", checked && "toggle-on")} type="button">
      <span />
    </button>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  layoutId,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  layoutId: string;
}) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={cn("segmented-item", value === option.value && "segmented-item-active")}
          type="button"
        >
          {value === option.value && (
            <motion.span layoutId={layoutId} className="segmented-active" transition={{ type: "spring", stiffness: 420, damping: 36 }} />
          )}
          <span className="relative z-10">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

export function UserBadge({ kind, size = 18 }: { kind?: BadgeKind; size?: number }) {
  if (!kind) return null;
  return (
    <span
      title={kind === "dev" ? "Разработчик Wyre" : "Официальный аккаунт"}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/25 text-white shadow-sm",
        kind === "dev"
          ? "bg-gradient-to-br from-violet-400 via-violet-600 to-indigo-950 shadow-violet-500/30"
          : "bg-gradient-to-br from-sky-300 via-blue-600 to-indigo-950 shadow-blue-500/30",
      )}
      style={{ width: size, height: size }}
    >
      <span className="absolute inset-x-[18%] top-[9%] h-[18%] rounded-full bg-white/35 blur-[1px]" />
      {kind === "dev" ? <svg viewBox="0 0 24 24" width={size * 0.76} height={size * 0.76} fill="none" aria-hidden="true"><path d="M8.6 7.2 4.2 12l4.4 4.8M15.4 7.2l4.4 4.8-4.4 4.8M13.7 5.8 10.3 18.2" stroke="currentColor" strokeWidth="2.15" strokeLinecap="round" strokeLinejoin="round" /></svg> : <svg viewBox="0 0 24 24" width={size * 0.76} height={size * 0.76} fill="none" aria-hidden="true"><path d="M12 3.4c2.1 1.7 4.1 2.1 6.2 2.4v5.1c0 4.2-2.5 7.4-6.2 9.7-3.7-2.3-6.2-5.5-6.2-9.7V5.8c2.1-.3 4.1-.7 6.2-2.4Z" fill="white" fillOpacity=".2" stroke="currentColor" strokeWidth="1.55" /><path d="m12 7.1 1.25 2.54 2.8.4-2.03 1.98.48 2.79L12 13.49l-2.5 1.32.48-2.79-2.03-1.98 2.8-.4L12 7.1Z" fill="currentColor" /></svg>}
    </span>
  );
}

export function WarningIndicator({ warnings }: { warnings?: Pick<Warning, "reason" | "date">[] }) {
  if (!warnings?.length) return null;
  return (
    <details className="relative shrink-0" onClick={(event) => event.stopPropagation()}>
      <summary className="warning-chip cursor-pointer list-none [&::-webkit-details-marker]:hidden" title="Публичные предупреждения">
        <TriangleAlert size={10} /> {warnings.length}
      </summary>
      <div className="glass-menu absolute right-0 top-full z-50 mt-2 w-64 p-3 text-left">
        <p className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold text-amber-400"><TriangleAlert size={13} /> Предупреждения ({warnings.length}/2)</p>
        {warnings.map((warning, index) => <div key={`${warning.reason}-${index}`} className="rounded-xl px-2 py-2 text-xs"><p>{warning.reason}</p>{warning.date && <p className="mt-0.5 text-[10px] text-[var(--muted)]">{warning.date}</p>}</div>)}
      </div>
    </details>
  );
}

export function Avatar({
  initials,
  colors,
  size = "md",
  presence,
  ring,
  avatarUrl,
}: {
  initials: string;
  colors: [string, string];
  size?: "sm" | "md" | "lg" | "xl";
  presence?: Presence;
  ring?: "unseen" | "seen" | "none";
  avatarUrl?: string | null;
}) {
  return (
    <div className="relative shrink-0">
      {ring && ring !== "none" && (
        <span
          className={cn(
            "absolute -inset-[3px] rounded-full",
            ring === "unseen"
              ? "bg-gradient-to-br from-[var(--accent1)] to-[var(--accent2)]"
              : "bg-[var(--line)]",
          )}
        />
      )}
      <div
        className={cn(
          "relative grid place-items-center overflow-hidden rounded-full font-semibold text-white shadow-lg",
          ring && ring !== "none" && "m-[3px]",
          size === "sm" && "h-9 w-9 text-xs",
          size === "md" && "h-12 w-12 text-sm",
          size === "lg" && "h-16 w-16 text-lg",
          size === "xl" && "h-28 w-28 text-3xl",
        )}
        style={{ background: `linear-gradient(145deg, ${colors[0]}, ${colors[1]})` }}
      >
        {avatarUrl
          ? <img src={avatarUrl} alt={initials} loading="lazy" decoding="async" className="h-full w-full object-cover" />
          : initials}
      </div>
      {presence === "online" && <span className="presence-dot presence-online" />}
      {presence === "typing" && <span className="presence-dot presence-typing" />}
      {(presence === "recording_voice" || presence === "recording_video") && <span className="presence-dot presence-recording" />}
      {presence === "talking" && <span className="presence-dot presence-talking" />}
      {presence === "recent" && <span className="presence-dot presence-recent" />}
    </div>
  );
}

export function CheckedBadge({ checked }: { checked: boolean }) {
  return (
    <span className={cn("checkbox", checked && "checkbox-on")}>
      {checked && <Check size={12} strokeWidth={3} />}
    </span>
  );
}
