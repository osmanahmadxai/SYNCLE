'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * The install command with a copy button — the one thing most visitors came
 * to take away. A wash, a prompt and the text; no border, no chrome.
 *
 * On phones the command WRAPS instead of scrolling: iOS and Android hide
 * scrollbars, so an overflowing command just looks cut off mid-URL. Desktop
 * keeps the single line.
 */
export function CopyCommand({
  command,
  className,
}: {
  command: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codeRef = useRef<HTMLElement>(null);

  // a pending timer would set state on an unmounted component
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // clipboard is unavailable outside a secure context or without
      // permission — select the text so ⌘C still works
      if (codeRef.current) {
        const range = document.createRange();
        range.selectNodeContents(codeRef.current);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }, [command]);

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
        // wraps below sm; scrolls (single line) from sm up
        className="min-w-0 flex-1 whitespace-pre-wrap break-all text-left sm:overflow-x-auto sm:whitespace-nowrap sm:break-normal"
      >
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy install command'}
        className="shrink-0 text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}
