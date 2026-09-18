// OS-level input injection for Wyre remote control (Windows).
//
// The native nut.js module is an optional dependency: when it is missing or
// fails to load, the desktop app keeps working and OS control is simply
// reported as unavailable — the browser-level remote control still functions.
let nut = null;
let loadAttempted = false;

function loadNut() {
  if (loadAttempted) return nut;
  loadAttempted = true;
  // Try the maintained community fork first, then the official packages.
  for (const name of ['@nut-tree-fork/nut-js', '@nut-tree/nut-js', 'nut-js']) {
    try {
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      nut = require(name);
      break;
    } catch {
      // Try the next candidate.
    }
  }
  return nut;
}

function available() {
  return Boolean(loadNut());
}

const KEY_MAP = {
  ' ': 'Space',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

function resolveKey(key) {
  if (!key) return null;
  if (/^[a-zA-Zа-яА-Я]$/.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  return KEY_MAP[key] ?? null;
}

/**
 * Applies one normalized remote-control event to this computer.
 * `bounds` is { width, height } of the primary display in pixels.
 */
async function inject(event, bounds) {
  const lib = loadNut();
  if (!lib || !bounds) return false;
  try {
    if (event.type === 'pointer_move' && event.x != null && event.y != null) {
      await lib.mouse.setPosition(new lib.Point(Math.min(Math.max(0, Math.round(event.x * bounds.width)), Math.max(0, bounds.width - 1)), Math.min(Math.max(0, Math.round(event.y * bounds.height)), Math.max(0, bounds.height - 1))));
    } else if (event.type === 'pointer_down') {
      await lib.mouse.pressButton(resolveButton(lib, event.button));
    } else if (event.type === 'pointer_up') {
      await lib.mouse.releaseButton(resolveButton(lib, event.button));
    } else if (event.type === 'key_down' && event.key) {
      const mapped = resolveKey(event.key);
      if (mapped) await lib.keyboard.pressKey(mapped);
    }
    return true;
  } catch {
    return false;
  }
}

function resolveButton(lib, button) {
  if (button === 2) return lib.Button.RIGHT;
  if (button === 1) return lib.Button.MIDDLE;
  return lib.Button.LEFT;
}

module.exports = { available, inject };
