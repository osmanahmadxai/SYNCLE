'use client';

/**
 * the bulb. dark while nothing needs anybody; lit — amber, red when it is
 * serious — as soon as something does, with a count, and pulsing while there
 * is a suggestion nobody has looked at yet. clicking it opens the panel: the
 * suggestions, worst first, each with what to do; and the guide.
 *
 * `?` opens it from anywhere that is not a text field.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Lightbulb } from 'lucide-react';
import { toast } from 'sonner';
import { topSeverity, type Hint } from '@/lib/hints/diagnose';
import { hintKey, useHelp } from '@/lib/hints/help-store';
import { useHints } from '@/lib/hints/use-hints';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SuggestionCard } from './suggestion-card';
import { GuideView } from './guide-view';

/** a key press that is someone typing, not a shortcut */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    !!target.closest('.monaco-editor')
  );
}

export function HelpBulb() {
  const t = useTranslations('help');
  const { hints, loaded } = useHints();
  const help = useHelp();
  const { load, openHelp } = help;

  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (typing(event.target)) return;
      event.preventDefault();
      const state = useHelp.getState();
      if (state.open) state.close();
      else state.openHelp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const active = hints.filter((h) => !help.dismissed.has(hintKey(h)));
  const dismissed = hints.filter((h) => help.dismissed.has(hintKey(h)));
  // only what will (or did) go wrong lights the bulb; good-to-know waits inside
  const alerting = active.filter((h) => h.severity !== 'info');
  const top = topSeverity(alerting);
  const unseen = alerting.some((h) => !help.seen.has(hintKey(h)));

  // a problem that turns up while somebody is here pops up once, as well as
  // lighting the bulb. what was already wrong when the page loaded only lights
  // it: a stack of toasts is not a welcome
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!loaded || !help.loaded) return;
    const keys = alerting.map(hintKey);
    if (known.current === null) {
      known.current = new Set(keys);
      return;
    }
    for (const hint of alerting) {
      const key = hintKey(hint);
      if (known.current.has(key)) continue;
      known.current.add(key);
      if (help.seen.has(key) || useHelp.getState().open) continue;
      const notify = hint.severity === 'critical' ? toast.error : toast.warning;
      notify(t(`rules.${hint.rule}.title`, hint.values), {
        description: t('bulbOn', { count: alerting.length }),
        action: {
          label: t('show'),
          onClick: () => openHelp({ tab: 'suggestions' }),
        },
        duration: 10_000,
      });
    }
  });

  const label =
    alerting.length > 0
      ? t('bulbOn', { count: alerting.length })
      : t('bulbOff');

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="relative h-8 w-8"
        title={label}
        aria-label={label}
        onClick={() =>
          openHelp({ tab: active.length > 0 ? 'suggestions' : 'guide' })
        }
      >
        {unseen && (
          <span
            aria-hidden
            className={cn(
              'absolute inset-1 animate-ping rounded-full',
              top === 'critical' ? 'bg-red-400/40' : 'bg-amber-400/40',
            )}
          />
        )}
        <Lightbulb
          className={cn(
            'relative h-4 w-4 transition-all duration-500',
            top === 'critical' &&
              'fill-red-300 text-red-500 drop-shadow-[0_0_6px_rgba(239,68,68,0.85)] dark:fill-red-500/60',
            top === 'warning' &&
              'fill-amber-300 text-amber-500 drop-shadow-[0_0_6px_rgba(245,158,11,0.85)] dark:fill-amber-400/60',
            top === null && 'text-muted-foreground',
          )}
        />
        {alerting.length > 0 && (
          <span
            className={cn(
              'absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] font-bold leading-none text-white',
              top === 'critical' ? 'bg-red-500' : 'bg-amber-500',
            )}
          >
            {alerting.length}
          </span>
        )}
      </Button>
      <HelpPanel active={active} dismissed={dismissed} />
    </>
  );
}

function HelpPanel({
  active,
  dismissed,
}: {
  active: Hint[];
  dismissed: Hint[];
}) {
  const t = useTranslations('help');
  const { open, tab, section, seen, close, setTab, markSeen } = useHelp();
  const [showDismissed, setShowDismissed] = useState(false);
  // what was new when the panel opened stays marked new while it is open
  const [newOnOpen, setNewOnOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open || tab !== 'suggestions') return;
    setNewOnOpen(
      new Set(active.filter((h) => !seen.has(hintKey(h))).map(hintKey)),
    );
    markSeen(active);
    // only on opening (or switching to the tab), not on every refresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader className="space-y-1 border-b px-5 py-4 text-left">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="h-4 w-4 fill-amber-300 text-amber-500" />
            {t('title')}
          </SheetTitle>
          <SheetDescription className="text-xs">
            {t('description')}
          </SheetDescription>
        </SheetHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as typeof tab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="mx-5 mt-3 grid grid-cols-2">
            <TabsTrigger value="suggestions" className="gap-1.5 text-xs">
              {t('tabSuggestions')}
              {active.length > 0 && (
                <span className="bg-muted-foreground/15 rounded-full px-1.5 text-[10px] tabular-nums">
                  {active.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="guide" className="text-xs">
              {t('tabGuide')}
            </TabsTrigger>
          </TabsList>

          <TabsContent
            value="suggestions"
            className="mt-0 min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4"
          >
            {active.length === 0 ? (
              <div className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-center">
                <Lightbulb className="h-8 w-8 opacity-30" />
                <p className="text-foreground text-sm font-medium">
                  {t('emptyTitle')}
                </p>
                <p className="max-w-xs text-xs">{t('emptyBody')}</p>
              </div>
            ) : (
              active.map((hint) => (
                <SuggestionCard
                  key={hint.id}
                  hint={hint}
                  isNew={newOnOpen.has(hintKey(hint))}
                />
              ))
            )}

            {dismissed.length > 0 && (
              <div className="space-y-3 pt-1">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline"
                  onClick={() => setShowDismissed((s) => !s)}
                >
                  {showDismissed
                    ? t('hideDismissed')
                    : t('showDismissed', { count: dismissed.length })}
                </button>
                {showDismissed &&
                  dismissed.map((hint) => (
                    <SuggestionCard
                      key={hint.id}
                      hint={hint}
                      isNew={false}
                      dismissed
                    />
                  ))}
              </div>
            )}
            <p className="text-muted-foreground pt-2 text-center text-[10px]">
              {t('shortcutHint')}
            </p>
          </TabsContent>

          <TabsContent
            value="guide"
            className="mt-0 min-h-0 flex-1 overflow-y-auto px-5 py-4"
          >
            <GuideView focus={section} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
