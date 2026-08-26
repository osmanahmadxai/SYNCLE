'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * The install command with a copy button — the one thing most visitors came
 * to take away.
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
        'flex items-start gap-3 rounded-md border bg-muted/60 py-2.5 pl-4 pr-2 sm:items-center',
        className,
      )}
    >
      <span
        aria-hidden
        className="mt-1 select-none font-mono text-sm text-muted-foreground/60 sm:mt-0"
      >
        $
      </span>
      <code
        ref={codeRef}
        // wraps below sm; scrolls (single line) from sm up
        className="min-w-0 flex-1 whitespace-pre-wrap break-all text-left font-mono text-[13px] leading-6 sm:overflow-x-auto sm:whitespace-nowrap sm:break-normal"
      >
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy install command'}
        className="shrink-0 rounded px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}
