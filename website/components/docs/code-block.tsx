'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A code block: a wash, the text, and a copy link in the corner. No syntax
 * highlighting on purpose — these docs quote shell commands, env files and
 * JSON, and plain ink keeps them readable without shipping a highlighter.
 *
 * `title` labels the block the way a filename comment would, and sits above
 * it as a line of small type rather than inside a bar of its own.
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
    <div className="my-5">
      {title && (
        <p className="mb-1.5 font-mono text-xs text-muted-foreground">{title}</p>
      )}
      <div className="relative rounded bg-muted">
        <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[13px] leading-relaxed">
          <code>{code}</code>
        </pre>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          className="absolute right-3 top-3 font-mono text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
    </div>
  );
}
