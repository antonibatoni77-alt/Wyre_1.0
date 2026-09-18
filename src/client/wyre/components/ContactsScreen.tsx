import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { wyreLiveQuery } from "../../lib/api";
import { MessageCircle, Search } from "lucide-react";
import type { Chat } from "../data";
import { Avatar, UserBadge, WarningIndicator } from "./Glass";

/**
 * Contacts are the people you actually talk to: peers of your existing direct
 * chats. New people are found through chat-list search, not a global directory.
 */
export function ContactsScreen({ onMessage, onOpenProfile }: { onMessage: (peerId: string) => void; onOpenProfile: (userId: string) => void }) {
  const [query, setQuery] = useState("");
  const { data: chats = [], isLoading } = useQuery(wyreLiveQuery<Chat[]>("wyre.listChats", {}));

  const contacts = useMemo(() => {
    const byUser = new Map<string, Chat>();
    for (const chat of chats) {
      if (chat.service || !chat.peerId) continue;
      if (!byUser.has(chat.peerId)) byUser.set(chat.peerId, chat);
    }
    const normalized = query.trim().toLowerCase();
    return [...byUser.values()]
      .filter((chat) => !normalized || `${chat.name}`.toLowerCase().includes(normalized))
      .map((chat) => ({
        userId: chat.peerId as string,
        name: chat.name,
        initials: chat.initials,
        colors: chat.colors,
        avatarUrl: chat.avatarUrl,
        presence: chat.presence,
        badge: chat.badge,
        warnings: chat.warnings,
      }));
  }, [chats, query]);

  return (
    <section className="section-screen">
      <div className="section-header">
        <div>
          <p className="eyebrow">Люди</p>
          <h1>Контакты</h1>
        </div>
      </div>
      <div className="contacts-content">
        <label className="search-box">
          <Search size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти контакт" />
        </label>
        <div className="mt-6 w-full">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
            Ваши контакты
          </p>
          {contacts.map((person, index) => (
            <motion.div
              key={person.userId}
              role="button"
              tabIndex={0}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(index, 12) * 0.035 }}
              onClick={() => onMessage(person.userId)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onMessage(person.userId); }}
              className="contact-row"
            >
              <button type="button" className="shrink-0" onClick={(event) => { event.stopPropagation(); onOpenProfile(person.userId); }} aria-label={`Открыть профиль ${person.name}`}>
                <Avatar initials={person.initials} colors={person.colors} avatarUrl={person.avatarUrl} presence={person.presence === "online" ? "online" : undefined} />
              </button>
              <div className="min-w-0 flex-1 text-left">
                <button type="button" className="text-left" onClick={(event) => { event.stopPropagation(); onOpenProfile(person.userId); }}>
                  <div className="flex items-center gap-1.5 font-semibold">{person.name}<UserBadge kind={person.badge} /><WarningIndicator warnings={person.warnings} /></div>
                  <p className="mt-1 text-xs text-[var(--muted)]">{person.presence === "online" ? "в сети" : person.presence === "offline" ? "не в сети" : ""}</p>
                </button>
              </div>
              <MessageCircle size={18} className="text-[var(--muted)]" />
            </motion.div>
          ))}
          {!contacts.length && (
            <p className="py-14 text-center text-sm text-[var(--muted)]">
              {isLoading ? "Загружаем…" : query ? "Никого не нашли" : "Контакты появятся, когда вы напишете кому-нибудь"}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
