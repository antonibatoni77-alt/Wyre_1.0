import { useEffect, useRef, useState } from 'react';
import { loginWithMagicLink } from '../lib/api';
import { motion } from 'motion/react';

/**
 * Landing page for the emailed magic link. The token is already stored in an
 * httpOnly cookie by the server, so we only need to complete the exchange and
 * then hard-navigate to the app so the session query re-runs from scratch
 * (no race between the auth cookie and the cached session).
 */
export default function MagicLinkPage() {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    loginWithMagicLink()
      .then(() => {
        window.location.replace('/');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Ссылка недействительна или истекла');
      });
  }, []);

  return (
    <div className="app-root">
      <div className="grid h-full w-full place-items-center px-6">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="text-center">
          <div className="brand-mark mx-auto grid h-16 w-16 place-items-center rounded-[22px]">
            <svg viewBox="0 0 36 36" aria-hidden="true" className="h-8 w-8 p-0.5">
              <path
                d="M6 10l5 17 7-11 7 11 5-17"
                fill="none"
                stroke="white"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="3.2"
              />
            </svg>
          </div>
          {error ? (
            <>
              <h1 className="mt-5 text-lg font-semibold">Не удалось войти</h1>
              <p className="mt-2 max-w-xs text-sm text-[var(--muted)]">{error}</p>
              <a href="/" className="primary-button mx-auto mt-6 inline-flex">
                Вернуться ко входу
              </a>
            </>
          ) : (
            <p className="mt-5 text-sm text-[var(--muted)]">Подтверждаем вход…</p>
          )}
        </motion.div>
      </div>
    </div>
  );
}
