import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Download, X, ZoomIn, ZoomOut } from "lucide-react";

export type MediaItem = {
  url: string;
  mimeType: string;
  fileName?: string;
  caption?: string;
};

/**
 * In-tab viewer for photos and videos. Files are streamed from the signed
 * download route with range support, so a large video starts playing instead of
 * being downloaded first.
 */
export function MediaViewer({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const isVideo = item.mimeType.startsWith("video/");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[120] flex flex-col bg-black/92 backdrop-blur-sm"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <span className="min-w-0 flex-1 truncate text-xs text-white/70">{item.fileName ?? item.caption ?? "Просмотр"}</span>
        {!isVideo && (
          <>
            <button onClick={() => setZoom((value) => Math.max(1, value - 0.5))} title="Уменьшить" className="grid h-9 w-9 place-items-center rounded-full hover:bg-white/10">
              <ZoomOut size={17} />
            </button>
            <button onClick={() => setZoom((value) => Math.min(4, value + 0.5))} title="Увеличить" className="grid h-9 w-9 place-items-center rounded-full hover:bg-white/10">
              <ZoomIn size={17} />
            </button>
          </>
        )}
        <a
          href={`${item.url}${item.url.includes("?") ? "&" : "?"}download=1`}
          download={item.fileName}
          title="Скачать"
          className="grid h-9 w-9 place-items-center rounded-full hover:bg-white/10"
        >
          <Download size={17} />
        </a>
        <button onClick={onClose} title="Закрыть" className="grid h-9 w-9 place-items-center rounded-full hover:bg-white/10">
          <X size={18} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4" onClick={(event) => event.target === event.currentTarget && onClose()}>
        {isVideo ? (
          <video src={item.url} controls autoPlay playsInline preload="metadata" className="max-h-full max-w-full rounded-2xl bg-black" />
        ) : (
          <img
            src={item.url}
            alt={item.caption || item.fileName || "Изображение"}
            style={{ transform: `scale(${zoom})` }}
            className="max-h-full max-w-full rounded-2xl object-contain transition-transform"
          />
        )}
      </div>
      {item.caption && <p className="shrink-0 px-4 pb-4 text-center text-xs text-white/70">{item.caption}</p>}
    </motion.div>
  );
}
