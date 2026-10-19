'use client';

/**
 * the guide: every part of Syncle, in the words its screens use. searchable
 * (every word must match, in a title, a summary or the text); a suggestion
 * can open it on the section that explains it.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, Search } from 'lucide-react';
import type { GuideSection } from '@/lib/hints/diagnose';
import { GUIDE_SECTIONS, matchesSearch } from '@/lib/hints/guide';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { RichText } from './rich-text';

export function GuideView({ focus }: { focus: GuideSection | null }) {
  const t = useTranslations('help');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<GuideSection>>(
    () => new Set(focus ? [focus] : []),
  );
  const refs = useRef(new Map<GuideSection, HTMLElement>());

  // a suggestion asked for this section: open it and bring it into view
  useEffect(() => {
    if (!focus) return;
    setQuery('');
    setOpen((was) => new Set([...was, focus]));
    const id = window.setTimeout(
      () =>
        refs.current
          .get(focus)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      50,
    );
    return () => window.clearTimeout(id);
  }, [focus]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const sections = GUIDE_SECTIONS.map((id) => ({
    id,
    title: t(`guide.sections.${id}.title`),
    summary: t(`guide.sections.${id}.summary`),
    body: t(`guide.sections.${id}.body`),
  })).filter((s) =>
    matchesSearch(`${s.title}\n${s.summary}\n${s.body}`, query),
  );
  const searching = words.length > 0;

  const toggle = (id: GuideSection) =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">{t('guide.intro')}</p>
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.stopPropagation();
              setQuery('');
            }
          }}
          placeholder={t('guide.search')}
          aria-label={t('guide.search')}
          className="h-8 pl-7 text-xs"
        />
      </div>

      {sections.length === 0 && (
        <p className="text-muted-foreground py-6 text-center text-xs">
          {t('guide.noResults', { query })}
        </p>
      )}

      <div className="space-y-1.5">
        {sections.map((s) => {
          // a search opens what it found
          const expanded = searching || open.has(s.id);
          return (
            <section
              key={s.id}
              ref={(el) => {
                if (el) refs.current.set(s.id, el);
                else refs.current.delete(s.id);
              }}
              className={cn(
                'scroll-mt-2 rounded-md border transition-colors',
                focus === s.id && 'border-primary/60 ring-primary/20 ring-2',
              )}
            >
              <button
                type="button"
                onClick={() => toggle(s.id)}
                aria-expanded={expanded}
                className="hover:bg-accent/50 flex w-full items-start gap-2 rounded-md px-3 py-2 text-left"
              >
                <ChevronRight
                  className={cn(
                    'text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform',
                    expanded && 'rotate-90',
                  )}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{s.title}</span>
                  <span className="text-muted-foreground block text-[11px]">
                    {s.summary}
                  </span>
                </span>
              </button>
              {expanded && (
                <div className="border-t px-3 py-2.5 pl-8">
                  <RichText text={s.body} highlight={words} />
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
