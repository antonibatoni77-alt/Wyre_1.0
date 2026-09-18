// Shared animation presets (Этап 0 — фундамент анимаций).
// Everything in the app should reuse these instead of inventing new curves ad-hoc.

export const springs = {
  snappy: { type: "spring", stiffness: 480, damping: 34, mass: 0.7 },
  soft: { type: "spring", stiffness: 300, damping: 30 },
  slow: { type: "spring", stiffness: 210, damping: 26 },
} as const;

export const easing = {
  standard: [0.16, 1, 0.3, 1],
  decel: [0.05, 0.7, 0.1, 1],
} as const;

export const durations = {
  fast: 0.16,
  normal: 0.28,
  slow: 0.45,
};

// Fade + scale, used by every modal / popover / menu in the app.
export const modalVariants = {
  initial: { opacity: 0, scale: 0.94, y: 14 },
  animate: { opacity: 1, scale: 1, y: 0, transition: springs.snappy },
  exit: { opacity: 0, scale: 0.96, y: 10, transition: { duration: durations.fast } },
};

export const popVariants = {
  initial: { opacity: 0, scale: 0.7, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0, transition: springs.snappy },
  exit: { opacity: 0, scale: 0.75, transition: { duration: durations.fast } },
};

// Horizontal slide, used for onboarding steps / auth transitions.
export function slideVariants(direction: 1 | -1 = 1) {
  return {
    initial: { opacity: 0, x: 32 * direction },
    animate: { opacity: 1, x: 0, transition: { duration: durations.normal, ease: easing.standard } },
    exit: { opacity: 0, x: -24 * direction, transition: { duration: durations.fast, ease: easing.standard } },
  };
}

// Vertical page swap, used between major sections (chats/contacts/settings/account).
export const pageVariants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: durations.normal, ease: easing.standard } },
  exit: { opacity: 0, y: -6, transition: { duration: durations.fast } },
};

export const collapseVariants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: "auto", opacity: 1, transition: { duration: durations.normal, ease: easing.standard } },
  exit: { height: 0, opacity: 0, transition: { duration: durations.fast } },
};

// Shared layoutId tokens for sliding indicators (nav, tabs, segmented controls).
export const layoutIds = {
  navIndicator: "wyre-nav-indicator",
  folderIndicator: "wyre-folder-indicator",
  segmentIndicator: "wyre-segment-indicator",
};
