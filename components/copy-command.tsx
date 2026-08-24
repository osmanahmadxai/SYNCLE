'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The install command with a copy button — the one thing most visitors came
 * to take away, so it gets to be the loudest element on the page.
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
        'flex items-center gap-3 rounded-xl border bg-card/40 py-2.5 pl-4 pr-2.5 backdrop-blur',
        className,
      )}
    >
      <span aria-hidden className="select-none font-mono text-sm text-muted-foreground">
        $
      </span>
      <code
        id="install-command"
        // text-left is explicit: the hero centres its children, and an
        // inherited text-center would float the command in the middle of its box
        className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-left font-mono text-[13px] leading-6 sm:text-sm"
      >
        {command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy install command'}
        className="h-8 shrink-0 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
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
