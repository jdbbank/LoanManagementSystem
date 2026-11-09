import { useEffect, useRef } from 'react';

/** A keystroke typed into a field or an open select belongs to that field, not to the shell. */
function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
}

/**
 * Registers one shell-level shortcut. Plain keys are ignored while the user types; a combo that
 * requires Ctrl/Cmd fires from anywhere, including inside a field.
 */
export function useHotkey(
  key: string,
  handler: () => void,
  { requireCombo = false }: { requireCombo?: boolean } = {}
) {
  const saved = useRef(handler);
  useEffect(() => {
    saved.current = handler;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== key) return;
      if (requireCombo !== (event.metaKey || event.ctrlKey)) return;
      if (!requireCombo && isTyping(event.target)) return;
      event.preventDefault();
      saved.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [key, requireCombo]);
}
