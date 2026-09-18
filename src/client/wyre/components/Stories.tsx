import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ImagePlus, LoaderCircle, Send, X } from "lucide-react";

import { wyreMutation } from "../../lib/api";
import type { Story } from "../data";
import { modalVariants } from "../utils/motion";
import { uploadSignedFile } from "../utils/upload";
import { Avatar, GlassButton, PrimaryButton } from "./Glass";

export function StoryCreator({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { mutateAsync: requestUpload } = useMutation(wyreMutation("wyre.requestStoryUpload"));
  const { mutateAsync: createStory } = useMutation(wyreMutation("wyre.createStory"));

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function publish() {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const contentType = file.type || (file.name.toLowerCase().endsWith(".mp4") ? "video/mp4" : "image/jpeg");
      const { url, fields, filePath } = (await requestUpload({
        fileName: file.name,
        fileSize: file.size,
        contentType,
      })) as { url: string; fields: Record<string, string>; filePath: string };

      await uploadSignedFile({ url, fields, file, fileName: file.name });

      await createStory({ caption, filePath, mimeType: contentType });
      onClose();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Не удалось опубликовать историю");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <motion.div {...modalVariants} onClick={(event) => event.stopPropagation()} className="modal-shell">
        <div className="flex items-center justify-between">
          <div>
            <p className="eyebrow">24 часа</p>
            <h2 className="mt-1 text-xl font-semibold">Новая история</h2>
          </div>
          <GlassButton onClick={onClose} title="Закрыть">
            <X size={18} />
          </GlassButton>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,video/webm,video/mp4,video/quicktime"
          className="hidden"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="glass-panel mt-6 grid aspect-[4/5] w-full max-h-[54dvh] place-items-center overflow-hidden rounded-[var(--r-lg)]"
        >
          {preview && file?.type.startsWith("video/") ? (
            <video src={preview} playsInline muted loop autoPlay className="h-full w-full object-cover" />
          ) : preview ? (
            <img src={preview} alt="Предпросмотр истории" className="h-full w-full object-cover" />
          ) : (
            <span className="flex flex-col items-center gap-3 text-sm text-[var(--muted)]">
              <ImagePlus size={32} /> Выбрать фото или видео
            </span>
          )}
        </button>

        <textarea
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
          maxLength={500}
          className="glass-input mt-4 min-h-20 resize-none"
          placeholder="Подпись к истории"
        />
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        <PrimaryButton disabled={!file || busy} onClick={() => void publish()} className="mt-5 w-full">
          {busy ? <LoaderCircle size={17} className="animate-spin" /> : <Send size={17} />}
          {busy ? "Публикуем…" : "Опубликовать"}
        </PrimaryButton>
      </motion.div>
    </div>
  );
}

export function StoryViewer({ stories, startIndex, onClose }: { stories: Story[]; startIndex: number; onClose: () => void }) {
  const [index, setIndex] = useState(Math.min(startIndex, Math.max(0, stories.length - 1)));
  const { mutate: markViewed } = useMutation(wyreMutation("wyre.markStoryViewed"));
  const story = stories[index];

  const advance = useCallback(() => {
    if (index + 1 >= stories.length) onClose();
    else setIndex((current) => current + 1);
  }, [index, stories.length, onClose]);

  useEffect(() => {
    if (!story) return;
    markViewed({ storyId: story.id });
    if (story.mimeType.startsWith("video/")) return;
    const timer = window.setTimeout(advance, 5000);
    return () => window.clearTimeout(timer);
  }, [story, markViewed, advance]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") advance();
      if (event.key === "ArrowLeft") setIndex((current) => Math.max(0, current - 1));
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [advance, onClose]);

  if (!story) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      drag="y"
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={0.18}
      onDragEnd={(_, info) => {
        if (info.offset.y < -70) onClose();
      }}
      className="fixed inset-0 z-[220] grid place-items-center overflow-hidden bg-[#05060d] text-white"
    >
      <div className="absolute left-4 right-4 top-3 z-20 flex gap-1">
        {stories.map((item, itemIndex) => (
          <span key={item.id} className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/25">
            <motion.span
              className="block h-full bg-white"
              initial={false}
              animate={{ width: itemIndex < index ? "100%" : itemIndex === index ? "100%" : "0%" }}
              transition={itemIndex === index && !story.mimeType.startsWith("video/") ? { duration: 5, ease: "linear" } : { duration: 0 }}
            />
          </span>
        ))}
      </div>

      <div className="absolute left-5 top-7 z-20 flex items-center gap-3">
        <Avatar initials={story.initials} colors={story.colors} size="sm" />
        <div>
          <p className="text-sm font-semibold">{story.name}</p>
          <p className="text-[10px] text-white/55">новая история</p>
        </div>
      </div>
      <button onClick={onClose} className="absolute right-5 top-7 z-30 grid h-10 w-10 place-items-center rounded-full bg-black/35" title="Закрыть">
        <X size={20} />
      </button>

      {story.mimeType.startsWith("video/") ? (
        <video src={story.mediaUrl} autoPlay playsInline controls onEnded={advance} className="h-full max-h-[100dvh] w-full object-contain" />
      ) : (
        <img src={story.mediaUrl} alt={story.caption || `История ${story.name}`} className="h-full max-h-[100dvh] w-full object-contain" />
      )}

      <button
        aria-label="Предыдущая история"
        className="absolute bottom-20 left-0 top-20 z-10 w-1/3"
        onClick={() => setIndex((current) => Math.max(0, current - 1))}
      />
      <button aria-label="Следующая история" className="absolute bottom-20 right-0 top-20 z-10 w-1/3" onClick={advance} />

      {story.caption && (
        <p className="absolute bottom-8 left-1/2 z-20 max-w-xl -translate-x-1/2 rounded-full bg-black/45 px-5 py-2 text-center text-sm backdrop-blur-xl">
          {story.caption}
        </p>
      )}
      <p className="absolute bottom-2 left-1/2 z-20 -translate-x-1/2 text-[10px] text-white/40">Смахните вверх, чтобы закрыть</p>
    </motion.div>
  );
}

export function StoriesLayer({
  creatorOpen,
  onCreatorClose,
  viewer,
  onViewerClose,
}: {
  creatorOpen: boolean;
  onCreatorClose: () => void;
  viewer: { stories: Story[]; startIndex: number } | null;
  onViewerClose: () => void;
}) {
  return (
    <AnimatePresence>
      {creatorOpen && <StoryCreator key="story-creator" onClose={onCreatorClose} />}
      {viewer && <StoryViewer key="story-viewer" stories={viewer.stories} startIndex={viewer.startIndex} onClose={onViewerClose} />}
    </AnimatePresence>
  );
}
