'use client';

/**
 * "only rows where…": the bridge's source filters. The API has always taken a
 * list of them; the builder could write exactly one — the row selection — and
 * deleted any other on save. Conditions are ANDed; a live bridge applies them
 * to every change, a replay pushes them into the source's own query.
 */
import type { Dispatch } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  FILTER_OPERATORS,
  VALUELESS,
  type BuilderAction,
  type BuilderDraft,
  type FilterOperator,
} from './draft';
import { incompleteFilter } from './transform-options';

export function FiltersSection({
  draft,
  dispatch,
  columns,
}: {
  draft: Pick<BuilderDraft, 'filters' | 'extraFilters'>;
  dispatch: Dispatch<BuilderAction>;
  columns: string[];
}) {
  const t = useTranslations('builderFilters');
  const { filters, extraFilters } = draft;

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
            dispatch({ type: 'addFilter', column: columns[0] ?? '' })
          }
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t('add')}
        </Button>
      </div>

      {filters.length === 0 && extraFilters.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('none')}</p>
      ) : (
        <div className="grid gap-1.5">
          {filters.map((f, index) => (
            <div key={f.id} className="flex items-center gap-1.5">
              <span className="text-muted-foreground w-8 shrink-0 text-right text-[11px]">
                {index === 0 ? t('where') : t('and')}
              </span>
              <Select
                value={f.column}
                onValueChange={(column) =>
                  dispatch({ type: 'patchFilter', id: f.id, patch: { column } })
                }
              >
                <SelectTrigger
                  className="h-8 min-w-0 flex-1"
                  aria-label={t('column')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* a column the table no longer has stays selectable, so it can be seen and removed */}
                  {[...new Set([f.column, ...columns])]
                    .filter(Boolean)
                    .map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Select
                value={f.operator}
                onValueChange={(operator) =>
                  dispatch({
                    type: 'patchFilter',
                    id: f.id,
                    patch: { operator: operator as FilterOperator },
                  })
                }
              >
                <SelectTrigger
                  className="h-8 w-36 shrink-0"
                  aria-label={t('operator')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FILTER_OPERATORS.map((op) => (
                    <SelectItem key={op} value={op}>
                      {t(`op.${op}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {VALUELESS.has(f.operator) ? (
                <span className="flex-1" />
              ) : (
                <Input
                  className="h-8 min-w-0 flex-1"
                  value={f.value}
                  placeholder={t('value')}
                  aria-label={t('value')}
                  onChange={(e) =>
                    dispatch({
                      type: 'patchFilter',
                      id: f.id,
                      patch: { value: e.target.value },
                    })
                  }
                />
              )}
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0"
                aria-label={t('remove')}
                onClick={() => dispatch({ type: 'removeFilter', id: f.id })}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          {filters.some(incompleteFilter) && (
            <p className="text-destructive text-[11px]">{t('needsValue')}</p>
          )}
          {extraFilters.length > 0 && (
            <p className="text-muted-foreground text-[11px]">
              {t('kept', { count: extraFilters.length })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
