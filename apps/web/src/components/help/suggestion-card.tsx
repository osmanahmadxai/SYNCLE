'use client';

/**
 * one suggestion: what is happening, why, what most likely caused it, what to
 * do — numbered — and buttons that go where it is done.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertOctagon,
  AlertTriangle,
  BookOpen,
  Check,
  ChevronRight,
  Copy,
  Info,
} from 'lucide-react';
import type { Hint, HintAction, Severity } from '@/lib/hints/diagnose';
import { useHelp } from '@/lib/hints/help-store';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Steps } from './rich-text';

const TONE: Record<
  Severity,
  { icon: typeof Info; border: string; text: string; chip: string }
> = {
  critical: {
    icon: AlertOctagon,
    border: 'border-l-red-500',
    text: 'text-red-600 dark:text-red-400',
    chip: 'bg-red-500/10 text-red-600 dark:text-red-400',
  },
  warning: {
    icon: AlertTriangle,
    border: 'border-l-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
    chip: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
  info: {
    icon: Info,
    border: 'border-l-sky-500',
    text: 'text-sky-600 dark:text-sky-400',
    chip: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  },
};

export function SuggestionCard({
  hint,
  isNew,
  dismissed = false,
}: {
  hint: Hint;
  isNew: boolean;
  dismissed?: boolean;
}) {
  const t = useTranslations('help');
  const { selectBridge, openBridgeEditor, openDataSources } = useStudio();
  const { close, dismiss, restore, openHelp } = useHelp();
  const [copied, setCopied] = useState(false);
  const tone = TONE[hint.severity];
  const Icon = tone.icon;

  const rule = `rules.${hint.rule}` as const;
  const known = hint.cause && hint.cause !== 'unknown';
  const steps = known
    ? t(`causes.${hint.cause}.steps`)
    : t(`${rule}.steps`, hint.values);

  const run = (action: HintAction) => {
    close();
    if (action.kind === 'open-bridge') selectBridge(action.bridgeId);
    else if (action.kind === 'edit-bridge') {
      selectBridge(action.bridgeId);
      openBridgeEditor({ editingId: action.bridgeId });
    } else if (action.kind === 'new-bridge') openBridgeEditor();
    else openDataSources();
  };
  const label = (action: HintAction) =>
    action.kind === 'open-bridge'
      ? t('actions.openBridge')
      : action.kind === 'edit-bridge'
        ? t('actions.editBridge')
        : action.kind === 'new-bridge'
          ? t('actions.newBridge')
          : t('actions.dataSources');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hint.detail ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // no clipboard (an insecure origin): the text is selectable as it is
    }
  };

  return (
    <article
      className={cn(
        'bg-card space-y-3 rounded-md border border-l-4 p-3 shadow-sm',
        tone.border,
        dismissed && 'opacity-60',
      )}
    >
      <header className="flex items-start gap-2">
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone.text)} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-snug">
            {t(`${rule}.title`, hint.values)}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                'rounded px-1.5 py-px text-[10px] font-medium',
                tone.chip,
              )}
            >
              {t(`severity.${hint.severity}`)}
            </span>
            {isNew && !dismissed && (
              <span className="bg-primary text-primary-foreground rounded px-1.5 py-px text-[10px] font-semibold">
                {t('new')}
              </span>
            )}
          </div>
        </div>
      </header>

      <p className="text-muted-foreground text-xs leading-relaxed">
        {t(`${rule}.body`, hint.values)}
      </p>

      {known && (
        <div className="bg-muted/60 rounded-md px-2.5 py-2 text-xs">
          <span className="text-muted-foreground">{t('likelyCause')}: </span>
          <span className="font-medium">{t(`causes.${hint.cause}.title`)}</span>
        </div>
      )}

      <section className="space-y-1.5">
        <h4 className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">
          {t('whatToDo')}
        </h4>
        <Steps text={steps} />
      </section>

      {hint.detail && (
        <details className="group">
          <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1 text-[11px]">
            <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
            {t('errorText')}
          </summary>
          <div className="relative mt-1.5">
            <pre className="bg-muted max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 pr-8 font-mono text-[11px]">
              {hint.detail}
            </pre>
            <button
              type="button"
              onClick={copy}
              className="text-muted-foreground hover:text-foreground absolute right-1.5 top-1.5"
              title={copied ? t('copied') : t('copy')}
              aria-label={copied ? t('copied') : t('copy')}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </details>
      )}

      <footer className="flex flex-wrap items-center gap-1.5">
        {hint.actions.map((action, i) => (
          <Button
            key={i}
            size="sm"
            variant={i === 0 ? 'default' : 'outline'}
            className="h-7 text-xs"
            onClick={() => run(action)}
          >
            {label(action)}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 text-xs"
          onClick={() => openHelp({ tab: 'guide', section: hint.guide })}
        >
          <BookOpen className="h-3.5 w-3.5" />
          {t('readGuide')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground ml-auto h-7 text-xs"
          onClick={() => (dismissed ? restore(hint) : dismiss(hint))}
        >
          {dismissed ? t('restore') : t('dismiss')}
        </Button>
      </footer>
    </article>
  );
}
