import { motion } from "motion/react";
import { CircleUserRound, ContactRound, MessageCircle, Settings } from "lucide-react";
import { cn } from "../utils/cn";
import type { Section } from "../data";
import { Brand } from "./Brand";
import { layoutIds, springs } from "../utils/motion";

/**
 * Этап 1 — образцовая навигация: одна и та же glass-панель,
 * desktop = вертикальная колонка слева, mobile = горизонтальная лента снизу.
 * Активный раздел подсвечивается shared-layout индикатором (плавно скользит).
 */
export function Navigation({
  active,
  onChange,
  initials = "W",
  colors = ["#8b5cf6", "#2563eb"],
}: {
  active: Section;
  onChange: (section: Section) => void;
  initials?: string;
  colors?: [string, string] | string[];
}) {
  const items: { id: Section; label: string; icon: typeof MessageCircle }[] = [
    { id: "chats", label: "Чаты", icon: MessageCircle },
    { id: "contacts", label: "Контакты", icon: ContactRound },
    { id: "settings", label: "Настройки", icon: Settings },
    { id: "account", label: "Аккаунт", icon: CircleUserRound },
  ];

  return (
    <nav className="app-nav glass-panel">
      <div className="hidden md:block">
        <Brand compact />
      </div>
      <div className="nav-items">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onChange(item.id)}
              className={cn("nav-item", isActive && "text-white")}
              aria-label={item.label}
              aria-current={isActive}
            >
              {isActive && (
                <motion.span layoutId={layoutIds.navIndicator} className="nav-active" transition={springs.snappy} />
              )}
              <Icon size={21} className="relative z-10" />
              <span className="relative z-10 text-[10px] font-medium md:hidden">{item.label}</span>
              <span className="nav-tooltip">{item.label}</span>
            </button>
          );
        })}
      </div>
      <button
        onClick={() => onChange("account")}
        style={{ backgroundImage: `linear-gradient(135deg, ${colors[0]}, ${colors[1]})` }}
        className="hidden h-10 w-10 place-items-center rounded-full text-xs font-bold text-white transition hover:brightness-110 md:grid"
        aria-label="Аккаунт"
      >
        {initials}
      </button>
    </nav>
  );
}
