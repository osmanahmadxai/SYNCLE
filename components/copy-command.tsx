'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The install command with a copy button — the one thing most visitors came
 * to take away, so it gets to be the loudest element on the page.
 *
 * On phones the command WRAPS instead of scrolling: iOS and Android hide
 * scrollbars, so an overflowing command just looks cut off mid-URL — on the
 * flagship element. Desktop keeps the single line.
 *
 * `prominent` marks the hero instance as the call to action (ring + glow);
 * the section and footer copies stay quiet so there is exactly one loudest.
 */
export function CopyCommand({
  command,
  className,
  prominent = false,
}: {
  command: string;
  className?: string;
  prominent?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      const node = document.getElementById('install-command');
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
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
        'flex items-start gap-3 rounded-xl border bg-card/40 py-2.5 pl-4 pr-2.5 backdrop-blur transition-shadow sm:items-center',
        prominent &&
          'ring-1 ring-foreground/15 shadow-[0_0_40px_-12px] shadow-foreground/20 hover:ring-foreground/25',
        copied && prominent && 'ring-foreground/40',
        className,
      )}
    >
      <span
        aria-hidden
        className="mt-1 select-none font-mono text-sm text-muted-foreground/50 sm:mt-0"
      >
        $
      </span>
      <code
        id="install-command"
        // wraps below sm; scrolls (single line) from sm up
        className="min-w-0 flex-1 whitespace-pre-wrap break-all text-left font-mono text-[13px] leading-6 sm:overflow-x-auto sm:whitespace-nowrap sm:break-normal sm:text-sm"
      >
        {command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy install command'}
        className="h-10 shrink-0 gap-1.5 px-3 text-xs text-muted-foreground hover:text-foreground sm:h-8 sm:px-2.5"
      >
        {copied ? (
          <>
            <Check className="size-3.5" /> Copied
          </>
        ) : (
          <>
            <Copy className="size-3.5" /> Copy
          </>
        )}
      </Button>
    </div>
  );
}
