import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { MessageCircle, X } from "lucide-react";
import { wyreQuery } from "../../lib/api";
import type { UserProfile } from "../types";
import { modalVariants } from "../utils/motion";
import { Avatar, GlassButton, PrimaryButton, UserBadge, WarningIndicator } from "./Glass";

export function ProfileModal({
  userId,
  onClose,
  onMessage,
}: {
  userId: string;
  onClose: () => void;
  onMessage: (userId: string) => void;
}) {
  const { data: profile, isLoading, error } = useQuery(wyreQuery<UserProfile>("wyre.userProfile", { userId }));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <motion.div {...modalVariants} onClick={(event) => event.stopPropagation()} className="modal-shell !max-w-md">
        <div className="flex items-start justify-between">
          <div><p className="eyebrow">Профиль</p><h2 className="mt-1 text-xl font-semibold">О человеке</h2></div>
          <GlassButton onClick={onClose} title="Закрыть"><X size={18} /></GlassButton>
        </div>
        {isLoading ? <p className="py-12 text-center text-sm text-[var(--muted)]">Загружаем профиль…</p> : error || !profile ? <p className="py-12 text-center text-sm text-red-400">Не удалось загрузить профиль</p> : (
          <>
            <div className="mt-7 flex flex-col items-center text-center">
              <Avatar initials={profile.initials} colors={profile.colors} size="xl" avatarUrl={profile.avatarUrl} presence={profile.presence} />
              <div className="mt-4 flex items-center gap-1.5 text-lg font-semibold">{profile.name}<UserBadge kind={profile.badge} /><WarningIndicator warnings={profile.warnings} /></div>
              <p className="mt-1 text-sm text-[var(--muted)]">@{profile.username}</p>
              <p className="mt-3 text-sm text-[var(--muted)]">{profile.status}</p>
            </div>
            {profile.bio && <p className="mt-6 text-center text-sm leading-6">{profile.bio}</p>}
            {profile.phone && <p className="mt-4 text-center text-sm text-[var(--muted)]">{profile.phone}</p>}
            {!profile.isSelf && <div className="mt-7 flex gap-3">
              {profile.canMessage && <PrimaryButton onClick={() => { onClose(); onMessage(profile.userId); }} className="flex-1"><MessageCircle size={17} /> Сказать привет</PrimaryButton>}
            </div>}
          </>
        )}
      </motion.div>
    </div>
  );
}
