'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A code block with a copy button in the corner. No syntax highlighting on
 * purpose: these docs quote shell commands, env files and JSON, and plain
 * ink keeps them readable without shipping a highlighter.
 *
 * `title` labels the block the way a filename comment would — where the
 * content goes, or what runs it.
 */
export function CodeBlock({
  children,
  title,
}: {
  /** the code, as plain text — indentation is preserved */
  children: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const code = children.replace(/^\n/, '').replace(/\s+$/, '');

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="my-5 overflow-hidden rounded-md border">
      {title && (
        <div className="border-b bg-muted/60 px-4 py-1.5 font-mono text-xs text-muted-foreground">
          {title}
        </div>
      )}
      <div className="relative bg-muted/40">
        <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[13px] leading-relaxed">
          <code>{code}</code>
        </pre>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          className="absolute right-2 top-2 rounded border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
    </div>
  );
}
