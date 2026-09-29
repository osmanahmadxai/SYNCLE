'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Put `text` on the clipboard, by whichever route the browser allows.
 *
 * navigator.clipboard is the right API but it throws more often than it
 * looks: an unfocused document, an http:// origin that is not localhost,
 * and a few Safari versions all reject it. execCommand is deprecated and
 * works in every one of those cases, so it is the fallback rather than the
 * other way round.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fall through
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // off-screen, but still focusable — display:none would not be selectable
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * The install command with a copy button. A wash, a prompt and the text.
 *
 * On phones the command WRAPS instead of scrolling: iOS and Android hide
 * scrollbars, so an overflowing command just looks cut off mid-URL.
 */
export function CopyCommand({
  command,
  className,
}: {
  command: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codeRef = useRef<HTMLElement>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    if (await writeClipboard(command)) {
      setState('copied');
    } else {
      // nothing worked: select the command so the keyboard shortcut does,
      // and say so, instead of leaving a button that looks broken
      if (codeRef.current) {
        const range = document.createRange();
        range.selectNodeContents(codeRef.current);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setState('manual');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2500);
  }, [command]);

  const label =
    state === 'copied' ? 'copied' : state === 'manual' ? 'press ⌘C' : 'copy';

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded bg-muted px-4 py-3 font-mono text-[13px] leading-6',
        className,
      )}
    >
      <span aria-hidden className="select-none text-muted-foreground">
        $
      </span>
      <code
        ref={codeRef}
        // break-words, not break-all: the URL stays in one piece and the
        // line wraps at the pipe instead of splitting "install" in half
        className="min-w-0 flex-1 whitespace-pre-wrap break-words text-left sm:overflow-x-auto sm:whitespace-nowrap sm:break-normal"
      >
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={state === 'copied' ? 'Copied' : 'Copy install command'}
        // negative margin keeps the layout while giving the 13px label a
        // hit target a finger can actually land on
        className="-m-2 shrink-0 whitespace-nowrap p-2 text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        {label}
      </button>
      <span aria-live="polite" className="sr-only">
        {state === 'copied'
          ? 'Command copied to clipboard'
          : state === 'manual'
            ? 'Command selected, press Command-C to copy'
            : ''}
      </span>
    </div>
  );
}
