import type { KeyCount } from './types';

/** Custom key bindings per key mode, persisted in localStorage. */

const DEFAULT_CODES: Record<KeyCount, string[]> = {
  4: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
  5: ['KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK'],
  7: ['KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL'],
};

const STORE_KEY = 'beat7-keys';

function loadAll(): Partial<Record<KeyCount, string[]>> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveAll(all: Partial<Record<KeyCount, string[]>>): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* private mode */ }
}

export function getKeyCodes(keys: KeyCount): string[] {
  const saved = loadAll()[keys];
  if (Array.isArray(saved) && saved.length === keys && saved.every((s) => typeof s === 'string')) {
    return saved;
  }
  return DEFAULT_CODES[keys];
}

/** Bind a key to a lane; if the key is used by another lane, the two lanes swap. */
export function setKeyCode(keys: KeyCount, lane: number, code: string): string[] {
  const codes = [...getKeyCodes(keys)];
  if (lane < 0 || lane >= codes.length) return codes;
  const other = codes.indexOf(code);
  if (other >= 0 && other !== lane) codes[other] = codes[lane];
  codes[lane] = code;
  const all = loadAll();
  all[keys] = codes;
  saveAll(all);
  return codes;
}

export function resetKeyCodes(keys: KeyCount): string[] {
  const all = loadAll();
  delete all[keys];
  saveAll(all);
  return DEFAULT_CODES[keys];
}

const SPECIAL_LABELS: Record<string, string> = {
  Space: '␣', Enter: '⏎', Tab: '⇥', CapsLock: '⇪',
  ShiftLeft: '⇧L', ShiftRight: '⇧R', ControlLeft: '^L', ControlRight: '^R',
  AltLeft: '⌥L', AltRight: '⌥R',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Backslash: '\\', BracketLeft: '[', BracketRight: ']', Backquote: '`',
  Minus: '-', Equal: '=',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
};

/** Short display label for a KeyboardEvent.code. */
export function labelFor(code: string): string {
  if (SPECIAL_LABELS[code]) return SPECIAL_LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'N' + code.slice(6);
  return code.length > 4 ? code.slice(0, 4) : code;
}

/** True on phones/tablets — enables tap/hold lane controls. */
export function isTouchDevice(): boolean {
  return navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
}
