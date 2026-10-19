'use client';

/**
 * the guide's and the suggestions' text, laid out. a message is plain text with
 * a few conventions — a blank line between paragraphs, `- ` for a bullet (two
 * spaces deeper for a nested one), `1. ` for a numbered step, backticks for
 * code — so translators write sentences, not markup.
 */
import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** `code`, and the words of a search, marked */
function inline(text: string, highlight: string[]): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={i}
          className="bg-muted rounded px-1 py-px font-mono text-[0.9em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{marked(part, highlight)}</Fragment>;
  });
}

function marked(text: string, words: string[]): ReactNode {
  const terms = words.filter((w) => w.length > 1);
  if (terms.length === 0) return text;
  const escaped = terms.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  return text.split(pattern).map((part, i) =>
    i % 2 === 1 ? (
      <mark
        key={i}
        className="rounded-sm bg-amber-200/70 px-px text-inherit dark:bg-amber-500/30"
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: { text: string; nested: string[] }[] }
  | { kind: 'ol'; items: string[] };

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of text.split(/\n{2,}/)) {
    const lines = chunk.split('\n');
    let current: Block | null = null;
    for (const line of lines) {
      const nested = /^ {2,}- (.*)$/.exec(line);
      const bullet = /^- (.*)$/.exec(line);
      const step = /^\d+\. (.*)$/.exec(line);
      if (nested && current?.kind === 'ul' && current.items.length > 0) {
        current.items[current.items.length - 1]!.nested.push(nested[1]!);
      } else if (bullet) {
        if (current?.kind !== 'ul')
          blocks.push((current = { kind: 'ul', items: [] }));
        current.items.push({ text: bullet[1]!, nested: [] });
      } else if (step) {
        if (current?.kind !== 'ol')
          blocks.push((current = { kind: 'ol', items: [] }));
        current.items.push(step[1]!);
      } else if (line.trim()) {
        if (current?.kind === 'p') current.text += ` ${line.trim()}`;
        else blocks.push((current = { kind: 'p', text: line.trim() }));
      }
    }
  }
  return blocks;
}

export function RichText({
  text,
  highlight = [],
  className,
}: {
  text: string;
  highlight?: string[];
  className?: string;
}) {
  return (
    <div className={cn('space-y-2 text-xs leading-relaxed', className)}>
      {parseBlocks(text).map((block, i) => {
        if (block.kind === 'p')
          return <p key={i}>{inline(block.text, highlight)}</p>;
        if (block.kind === 'ol')
          return (
            <ol key={i} className="list-decimal space-y-1 pl-5">
              {block.items.map((item, j) => (
                <li key={j}>{inline(item, highlight)}</li>
              ))}
            </ol>
          );
        return (
          <ul key={i} className="list-disc space-y-1 pl-5">
            {block.items.map((item, j) => (
              <li key={j}>
                {inline(item.text, highlight)}
                {item.nested.length > 0 && (
                  <ul className="mt-1 list-[circle] space-y-0.5 pl-4">
                    {item.nested.map((n, k) => (
                      <li key={k}>{inline(n, highlight)}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        );
      })}
    </div>
  );
}

/** a suggestion's steps: one per line, numbered */
export function Steps({ text }: { text: string }) {
  const steps = text.split('\n').filter((s) => s.trim());
  return (
    <ol className="space-y-1.5">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-2 text-xs leading-relaxed">
          <span className="bg-primary/10 text-primary flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold">
            {i + 1}
          </span>
          <span>{inline(step, [])}</span>
        </li>
      ))}
    </ol>
  );
}
