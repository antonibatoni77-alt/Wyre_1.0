import { cn } from "../utils/cn";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className={cn("brand-mark", compact ? "h-9 w-9 rounded-xl" : "h-12 w-12 rounded-2xl")}>
        <svg viewBox="0 0 36 36" aria-hidden="true" className="h-full w-full p-2.5">
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
      <span className={cn("font-semibold tracking-[-0.04em]", compact ? "text-xl" : "text-3xl")}>Wyre</span>
    </div>
  );
}
