import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps one broken panel from blanking the whole application.
 * Without this, any render-time exception in a call overlay or chat panel left
 * the user with an empty black page and no way back.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; label?: string; onReset?: () => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Wyre UI error", this.props.label ?? "", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-40 place-items-center p-6 text-center">
        <div>
          <p className="text-sm font-semibold">Не удалось отобразить {this.props.label ?? "этот раздел"}</p>
          <p className="mt-1 text-xs text-[var(--muted)]">{this.state.error.message}</p>
          <button
            onClick={() => {
              this.setState({ error: null });
              this.props.onReset?.();
            }}
            className="mt-4 rounded-xl bg-white/10 px-4 py-2 text-xs font-semibold"
          >
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }
}
