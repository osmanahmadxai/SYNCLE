'use client';

/**
 * "change values on the way": masking, casts, computed columns. A list, because
 * the order is the point — lower-case the e-mail, THEN hash it — and each step
 * sees what the ones above it did.
 */
import type { Dispatch } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import type { ColumnTransform } from '@syncle/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { BuilderAction, BuilderDraft, DraftTransform } from './draft';
import {
  CAST_ERRORS,
  CAST_TARGETS,
  MASK_MODES,
  TEXT_OPS,
  TRANSFORM_KINDS,
  blankTransform,
  incompleteTransform,
  type TransformKind,
} from './transform-options';

export function TransformsSection({
  draft,
  dispatch,
  columns,
}: {
  draft: Pick<BuilderDraft, 'transforms'>;
  dispatch: Dispatch<BuilderAction>;
  columns: string[];
}) {
  const t = useTranslations('builderTransforms');
  const { transforms } = draft;

  const replace = (step: DraftTransform, next: ColumnTransform) =>
    dispatch({ type: 'replaceTransform', id: step.id, transform: next });

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('title')}</h3>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={columns.length === 0}
          onClick={() =>
            dispatch({
              type: 'addTransform',
              transform: blankTransform('mask', columns[0] ?? ''),
            })
          }
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t('add')}
        </Button>
      </div>

      {transforms.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('none')}</p>
      ) : (
        <div className="grid gap-2">
          {transforms.map((step, index) => (
            <div key={step.id} className="grid gap-1.5 rounded-md border p-2">
              <div className="flex items-center gap-1.5">
                <Select
                  value={step.kind}
                  onValueChange={(kind) =>
                    replace(
                      step,
                      blankTransform(
                        kind as TransformKind,
                        step.column || columns[0] || '',
                      ),
                    )
                  }
                >
                  <SelectTrigger
                    className="h-8 w-40 shrink-0"
                    aria-label={t('step')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRANSFORM_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {t(`kind.${k}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {/* a computed column or a default can name a column that does not exist yet */}
                {step.kind === 'set' || step.kind === 'default' ? (
                  <Input
                    className="h-8 min-w-0 flex-1 font-mono text-xs"
                    value={step.column}
                    placeholder={t('columnName')}
                    aria-label={t('columnName')}
                    list={`columns-${step.id}`}
                    onChange={(e) =>
                      replace(step, { ...step, column: e.target.value })
                    }
                  />
                ) : (
                  <Select
                    value={step.column}
                    onValueChange={(column) =>
                      replace(step, { ...step, column })
                    }
                  >
                    <SelectTrigger
                      className="h-8 min-w-0 flex-1"
                      aria-label={t('column')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[...new Set([step.column, ...columns])]
                        .filter(Boolean)
                        .map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                )}
                <datalist id={`columns-${step.id}`}>
                  {columns.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>

                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-7 shrink-0"
                  disabled={index === 0}
                  aria-label={t('moveUp')}
                  onClick={() =>
                    dispatch({ type: 'moveTransform', id: step.id, by: -1 })
                  }
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-7 shrink-0"
                  disabled={index === transforms.length - 1}
                  aria-label={t('moveDown')}
                  onClick={() =>
                    dispatch({ type: 'moveTransform', id: step.id, by: 1 })
                  }
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-7 shrink-0"
                  aria-label={t('remove')}
                  onClick={() =>
                    dispatch({ type: 'removeTransform', id: step.id })
                  }
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>

              {step.kind === 'mask' && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Select
                    value={step.mode}
                    onValueChange={(mode) =>
                      replace(step, {
                        ...step,
                        mode: mode as (typeof MASK_MODES)[number],
                      })
                    }
                  >
                    <SelectTrigger
                      className="h-8 w-52"
                      aria-label={t('maskMode')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MASK_MODES.map((m) => (
                        <SelectItem key={m} value={m}>
                          {t(`mask.${m}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {step.mode === 'partial' && (
                    <>
                      <label className="text-muted-foreground flex items-center gap-1 text-[11px]">
                        {t('keepStart')}
                        <Input
                          className="h-8 w-14"
                          inputMode="numeric"
                          value={String(step.keepStart)}
                          onChange={(e) =>
                            replace(step, {
                              ...step,
                              keepStart: clamp(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label className="text-muted-foreground flex items-center gap-1 text-[11px]">
                        {t('keepEnd')}
                        <Input
                          className="h-8 w-14"
                          inputMode="numeric"
                          value={String(step.keepEnd)}
                          onChange={(e) =>
                            replace(step, {
                              ...step,
                              keepEnd: clamp(e.target.value),
                            })
                          }
                        />
                      </label>
                    </>
                  )}
                  {(step.mode === 'partial' || step.mode === 'redact') && (
                    <label className="text-muted-foreground flex items-center gap-1 text-[11px]">
                      {t('fill')}
                      <Input
                        className="h-8 w-12 text-center font-mono"
                        value={step.fill}
                        onChange={(e) => {
                          // one character, replaced by the next one typed; never none
                          const last = [...e.target.value].pop();
                          if (last) replace(step, { ...step, fill: last });
                        }}
                      />
                    </label>
                  )}
                  {step.mode === 'hash' && (
                    <Input
                      className="h-8 min-w-0 flex-1"
                      value={step.salt ?? ''}
                      placeholder={t('salt')}
                      aria-label={t('salt')}
                      onChange={(e) =>
                        replace(step, {
                          ...step,
                          salt: e.target.value || undefined,
                        })
                      }
                    />
                  )}
                </div>
              )}

              {step.kind === 'cast' && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Select
                    value={step.to}
                    onValueChange={(to) =>
                      replace(step, {
                        ...step,
                        to: to as (typeof CAST_TARGETS)[number],
                      })
                    }
                  >
                    <SelectTrigger
                      className="h-8 w-40"
                      aria-label={t('castTo')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CAST_TARGETS.map((c) => (
                        <SelectItem key={c} value={c}>
                          {t(`cast.${c}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-muted-foreground text-[11px]">
                    {t('ifItCannot')}
                  </span>
                  <Select
                    value={step.onError}
                    onValueChange={(onError) =>
                      replace(step, {
                        ...step,
                        onError: onError as (typeof CAST_ERRORS)[number],
                      })
                    }
                  >
                    <SelectTrigger
                      className="h-8 min-w-0 flex-1"
                      aria-label={t('onCastError')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CAST_ERRORS.map((c) => (
                        <SelectItem key={c} value={c}>
                          {t(`castError.${c}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {step.kind === 'text' && (
                <Select
                  value={step.op}
                  onValueChange={(op) =>
                    replace(step, {
                      ...step,
                      op: op as (typeof TEXT_OPS)[number],
                    })
                  }
                >
                  <SelectTrigger className="h-8 w-52" aria-label={t('textOp')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TEXT_OPS.map((o) => (
                      <SelectItem key={o} value={o}>
                        {t(`text.${o}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {step.kind === 'default' && (
                <Input
                  className="h-8"
                  value={step.value === null ? '' : String(step.value)}
                  placeholder={t('defaultValue')}
                  aria-label={t('defaultValue')}
                  onChange={(e) =>
                    replace(step, { ...step, value: e.target.value })
                  }
                />
              )}

              {incompleteTransform(step) && (
                <p className="text-destructive text-[11px]">
                  {t('needsColumn')}
                </p>
              )}

              {step.kind === 'set' && (
                <div className="grid gap-1">
                  <Input
                    className="h-8 font-mono text-xs"
                    value={step.template}
                    placeholder="{{first_name}} {{last_name}}"
                    aria-label={t('template')}
                    onChange={(e) =>
                      replace(step, { ...step, template: e.target.value })
                    }
                  />
                  {/* braces mean "a value goes here" to the message format, so the tokens are passed in as values */}
                  <p className="text-muted-foreground text-[11px]">
                    {t('templateHint', {
                      token: '{{column}}',
                      now: '{{$now}}',
                      table: '{{$table}}',
                    })}
                  </p>
                </div>
              )}
            </div>
          ))}
          <p className="text-muted-foreground text-[11px]">{t('orderHint')}</p>
        </div>
      )}
    </section>
  );
}

function clamp(text: string): number {
  const n = Math.trunc(Number(text));
  return Number.isFinite(n) ? Math.min(64, Math.max(0, n)) : 0;
}
