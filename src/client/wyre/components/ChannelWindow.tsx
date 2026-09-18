import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Eye, Heart, MessageCircle, Send, X } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { wyreLiveQuery, wyreMutation } from "../../lib/api";
import { Avatar, GlassButton, PrimaryButton } from "./Glass";

type ChannelView = { id: string; title: string; description: string; initials: string; colors: [string, string]; subscribers: number; owner: boolean };
type PostView = { id: string; text: string; createdAt: string; edited: boolean; views: number; comments: number; reactions: { emoji: string; count: number; mine: boolean }[] };
type CommentView = { id: string; text: string; createdAt: string; edited: boolean; mine: boolean; author: string };

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function formatDay(value: string) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Сегодня";
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/**
 * Channels reuse the chat shell: same header, same message list and the same
 * composer, so posts read like messages instead of a separate feed style.
 */
export function ChannelWindow({ channelId, onBack }: { channelId: string; onBack: () => void }) {
  const { data: channels = [] } = useQuery(wyreLiveQuery<ChannelView[]>("wyre.listChannels", {}));
  const channel = useMemo(() => channels.find((item) => item.id === channelId), [channels, channelId]);
  const { data: posts = [] } = useQuery(wyreLiveQuery<PostView[]>("wyre.channelFeed", { channelId }));
  const [postText, setPostText] = useState("");
  const [commentsFor, setCommentsFor] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data: comments = [] } = useQuery({ ...wyreLiveQuery<CommentView[]>("wyre.postComments", { postId: commentsFor ?? "" }), enabled: Boolean(commentsFor) });
  const { mutateAsync: publish, isPending: publishing } = useMutation(wyreMutation("wyre.publishPost"));
  const { mutate: viewPost } = useMutation(wyreMutation("wyre.viewChannelPost"));
  const { mutate: react } = useMutation(wyreMutation("wyre.reactChannelPost"));
  const { mutateAsync: comment, isPending: commenting } = useMutation(wyreMutation("wyre.commentChannelPost"));

  useEffect(() => { posts.forEach((post) => viewPost({ postId: post.id })); }, [posts.map((post) => post.id).join(","), viewPost]);

  // Oldest first, exactly like a chat history.
  const ordered = useMemo(() => [...posts].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()), [posts]);

  async function publishPost() {
    if (!postText.trim()) return;
    setError(null);
    try { await publish({ channelId, text: postText.trim() }); setPostText(""); }
    catch (publishError) { setError(publishError instanceof Error ? publishError.message : "Не удалось опубликовать пост"); }
  }

  async function sendComment() {
    if (!commentsFor || !commentText.trim()) return;
    setError(null);
    try { await comment({ postId: commentsFor, text: commentText.trim() }); setCommentText(""); }
    catch (commentError) { setError(commentError instanceof Error ? commentError.message : "Не удалось отправить комментарий"); }
  }

  if (!channel) return <section className="chat-window"><div className="grid h-full place-items-center text-sm text-[var(--muted)]">Загружаем канал…</div></section>;

  return (
    <section className="chat-window">
      <header className="chat-header glass-panel">
        <button onClick={onBack} className="mr-1 grid h-9 w-9 place-items-center rounded-full transition hover:bg-white/10 md:hidden"><ArrowLeft size={19} /></button>
        <Avatar initials={channel.initials} colors={channel.colors} size="sm" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{channel.title}</h2>
          <p className="mt-0.5 truncate text-[10px] text-[var(--muted)]">{channel.subscribers} подписчиков{channel.description ? ` · ${channel.description}` : ""}</p>
        </div>
      </header>

      <div className="chat-backdrop" />
      <div className="message-list">
        <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-7 sm:px-8">
          {!ordered.length && <div className="py-16 text-center text-sm text-[var(--muted)]">В канале пока нет публикаций.</div>}
          {ordered.map((post, index) => {
            const previous = ordered[index - 1];
            const showDate = !previous || new Date(previous.createdAt).toDateString() !== new Date(post.createdAt).toDateString();
            const liked = post.reactions.find((item) => item.emoji === "❤");
            return (
              <div key={post.id}>
                {showDate && <div className="date-divider"><span>{formatDay(post.createdAt)}</span></div>}
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.14, ease: "easeOut" }} className="message-wrap justify-start">
                  <div className="relative max-w-[82%] sm:max-w-[68%]">
                    <div className="message-bubble message-theirs text-left">
                      <span className="whitespace-pre-wrap">{post.text}</span>
                      <span className="mt-2 flex items-center gap-2 text-[9px] opacity-70">
                        {post.edited && <span>изм.</span>}
                        <span>{formatTime(post.createdAt)}</span>
                        <span className="flex items-center gap-1"><Eye size={10} /> {post.views}</span>
                        <button onClick={() => react({ postId: post.id, emoji: "❤" })} className="flex items-center gap-1">
                          <Heart size={11} className={liked?.mine ? "fill-current text-red-400" : ""} /> {liked?.count ?? 0}
                        </button>
                        <button onClick={() => setCommentsFor(post.id)} className="flex items-center gap-1">
                          <MessageCircle size={11} /> {post.comments}
                        </button>
                      </span>
                    </div>
                  </div>
                </motion.div>
              </div>
            );
          })}
        </div>
      </div>

      {channel.owner ? (
        <div className="composer-zone">
          <div className="composer glass-panel">
            <textarea
              value={postText}
              onChange={(event) => setPostText(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void publishPost(); } }}
              rows={1}
              placeholder="Новая публикация"
              className="min-h-9 flex-1 resize-none bg-transparent text-sm outline-none"
            />
            <button onClick={() => void publishPost()} disabled={publishing || !postText.trim()} className="send-button disabled:opacity-40" title="Опубликовать">
              <Send size={18} />
            </button>
          </div>
          {error && <p className="mt-2 text-center text-xs text-red-400">{error}</p>}
        </div>
      ) : (
        <div className="composer-zone"><div className="composer glass-panel"><p className="flex-1 text-center text-xs text-[var(--muted)]">Публиковать может только владелец канала</p></div></div>
      )}

      <AnimatePresence>
        {commentsFor && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="modal-backdrop" onClick={() => setCommentsFor(null)}>
            <motion.div initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} onClick={(event) => event.stopPropagation()} className="modal-shell !max-w-lg">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Комментарии</h2>
                <GlassButton onClick={() => setCommentsFor(null)}><X size={16} /></GlassButton>
              </div>
              <div className="mt-4 max-h-[45dvh] space-y-2 overflow-y-auto">
                {comments.map((item) => (
                  <div key={item.id} className="rounded-xl bg-white/5 p-3">
                    <p className="text-[10px] font-semibold text-[var(--accent1)]">{item.author}</p>
                    <p className="mt-1 text-xs">{item.text}</p>
                  </div>
                ))}
                {!comments.length && <p className="py-8 text-center text-xs text-[var(--muted)]">Комментариев пока нет</p>}
              </div>
              <div className="mt-4 flex gap-2">
                <input value={commentText} onChange={(event) => setCommentText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void sendComment(); }} placeholder="Комментарий" className="glass-input flex-1" />
                <PrimaryButton disabled={commenting || !commentText.trim()} onClick={() => void sendComment()}><Send size={14} /></PrimaryButton>
              </div>
              {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
