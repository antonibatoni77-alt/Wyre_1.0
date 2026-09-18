import { useRef, useState } from "react";
import { motion } from "motion/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { wyreMutation, wyreQuery } from "../../lib/api";
import { Camera, Check, Plus, Search, X } from "lucide-react";
import type { ModalKind } from "../data";
import type { Person } from "../types";
import { Avatar, CheckedBadge, Field, GlassButton, PrimaryButton, UserBadge, WarningIndicator } from "./Glass";
import { modalVariants } from "../utils/motion";
import { uploadSignedFile } from "../utils/upload";

export function CreationModal({
  kind,
  onClose,
  onCreated,
}: {
  kind: Exclude<ModalKind, null>;
  onClose: () => void;
  onCreated: (chatId: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Person[]>([]);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const { data: people = [], isLoading } = useQuery({
    ...wyreQuery<Person[]>("wyre.searchPeople", { query }),
    enabled: kind === "group",
  });

  const { mutate: createGroup, isPending: isCreating } = useMutation({
    ...wyreMutation("wyre.createGroup"),
    onSuccess: (result: unknown) => {
      const { chatId } = result as { chatId: string };
      // The photo is optional: the group must exist before it can be uploaded.
      if (photo) {
        void (async () => {
          try {
            const ticket = (await requestGroupAvatarUpload({ chatId, fileName: photo.name, fileSize: photo.size, contentType: photo.type || "image/jpeg" })) as {
              url: string;
              fields: Record<string, string>;
              filePath: string;
            };
            await uploadSignedFile({ url: ticket.url, fields: ticket.fields, file: photo, fileName: photo.name });
            await setGroupAvatar({ chatId, filePath: ticket.filePath, mimeType: photo.type || "image/jpeg" });
          } catch {
            // The group itself is already created; a failed photo must not block it.
          }
        })();
      }
      setCreated(true);
      onCreated(chatId);
    },
    onError: (err: Error) => setError(err.message || "Не удалось создать группу"),
  });
  const { mutateAsync: requestGroupAvatarUpload } = useMutation(wyreMutation("wyre.requestGroupAvatarUpload"));
  const { mutateAsync: setGroupAvatar } = useMutation(wyreMutation("wyre.setGroupAvatar"));
  const { mutate: createChannel, isPending: isCreatingChannel } = useMutation({
    ...wyreMutation("wyre.createChannel"),
    onSuccess: (result: unknown) => { const { channelId } = result as { channelId: string }; setCreated(true); onCreated(channelId); },
    onError: (err: Error) => setError(err.message || "Не удалось создать канал"),
  });

  function toggle(person: Person) {
    setSelected((items) =>
      items.some((item) => item.userId === person.userId)
        ? items.filter((item) => item.userId !== person.userId)
        : [...items, person],
    );
  }

  function submit() {
    setError(null);
    if (kind === "channel") { createChannel({ title: name.trim(), description: description.trim() }); return; }
    createGroup({ title: name.trim(), memberIds: selected.map((person) => person.userId) });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <motion.div {...modalVariants} onClick={(event) => event.stopPropagation()} className="modal-shell">
        {created ? (
          <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="py-12 text-center">
            <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-500/20 text-emerald-400">
              <Check size={30} />
            </span>
            <h2 className="mt-5 text-xl font-semibold">{kind === "channel" ? "Канал создан" : "Группа создана"}</h2>
            <PrimaryButton onClick={onClose} className="mt-7">
              Готово
            </PrimaryButton>
          </motion.div>
        ) : kind === "channel" ? (
          <>
            <div className="flex items-center justify-between">
              <div>
                <p className="eyebrow">Новый канал</p>
                <h2 className="mt-1 text-xl font-semibold">Создать канал</h2>
              </div>
              <GlassButton onClick={onClose}>
                <X size={18} />
              </GlassButton>
            </div>
            <div className="mt-6 space-y-4"><Field label="Название" value={name} onChange={setName} placeholder="Новости семьи" /><Field label="Описание" value={description} onChange={setDescription} placeholder="О чём этот канал" /></div>
            {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
            <PrimaryButton disabled={!name.trim() || isCreatingChannel} onClick={submit} className="mt-6 w-full"><Plus size={17} /> {isCreatingChannel ? "Создаём…" : "Создать канал"}</PrimaryButton>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div>
                <p className="eyebrow">Новый чат</p>
                <h2 className="mt-1 text-xl font-semibold">Создать группу</h2>
              </div>
              <GlassButton onClick={onClose}>
                <X size={18} />
              </GlassButton>
            </div>
            <div className="mt-6 flex items-center gap-4">
              <input
                ref={photoInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  if (file.size > 10 * 1024 * 1024) return setError("Фото группы должно быть меньше 10 МБ");
                  setPhoto(file);
                  setError(null);
                }}
              />
              <button className="avatar-upload" type="button" onClick={() => photoInputRef.current?.click()} title="Выбрать фото группы">
                {photo ? <img src={URL.createObjectURL(photo)} alt="Фото группы" className="h-full w-full rounded-[inherit] object-cover" /> : <><Camera size={20} /><span>Фото</span></>}
              </button>
              <div className="min-w-0 flex-1">
                <Field label="Название" value={name} onChange={setName} placeholder="Команда мечты" />
              </div>
            </div>
            <div className="mt-5">
              <p className="mb-2 text-xs font-medium text-[var(--muted)]">Участники</p>
              <label className="search-box mb-2">
                <Search size={16} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти по имени или @username" />
              </label>
              {selected.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {selected.map((person) => (
                    <span key={person.userId} className="glass-surface-pill flex items-center gap-1.5 py-1 pl-2.5 pr-1.5 text-xs">
                      {person.name}
                      <button onClick={() => toggle(person)} className="grid h-4 w-4 place-items-center rounded-full hover:bg-white/10" type="button">
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="max-h-44 overflow-y-auto rounded-2xl border border-white/8 bg-black/5 p-1">
                {people.map((person) => {
                  const checked = selected.some((item) => item.userId === person.userId);
                  return (
                    <button
                      key={person.userId}
                      onClick={() => toggle(person)}
                      type="button"
                      className="flex w-full items-center gap-3 rounded-xl p-2 text-left hover:bg-white/5"
                    >
                      <CheckedBadge checked={checked} />
                      <Avatar initials={person.initials} colors={person.colors} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-sm">{person.name}</span>
                      <UserBadge kind={person.badge} size={15} />
                      <WarningIndicator warnings={person.warnings} />
                    </button>
                  );
                })}
                {!people.length && (
                  <p className="py-6 text-center text-xs text-[var(--muted)]">
                    {isLoading ? "Ищем…" : "Никого не нашли"}
                  </p>
                )}
              </div>
            </div>
            {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
            <PrimaryButton disabled={!name.trim() || selected.length === 0 || isCreating} onClick={submit} className="mt-6 w-full">
              <Plus size={17} /> {isCreating ? "Создаём…" : "Создать"}
            </PrimaryButton>
          </>
        )}
      </motion.div>
    </div>
  );
}
