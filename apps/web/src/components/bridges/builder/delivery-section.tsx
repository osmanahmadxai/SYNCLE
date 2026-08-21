'use client';

/** delivery tuning: batching, retries, pacing, and on-failure policy */
import type { Dispatch } from 'react';
import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { NumField } from './num-field';
import type { BuilderAction, BuilderDraft } from './draft';

export function DeliverySection({
  draft,
  dispatch,
}: {
  draft: Pick<BuilderDraft, 'delivery' | 'syncMode'>;
  dispatch: Dispatch<BuilderAction>;
}) {
  const t = useTranslations('bridgeBuilder');
  const { delivery, syncMode } = draft;

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{t('delivery')}</h3>
      <div className="grid grid-cols-2 gap-2">
        {syncMode === 'oneTime' && (
          <NumField
            label={t('batchSize')}
            value={delivery.batchSize}
            min={1}
            onChange={(v) =>
              dispatch({ type: 'patchDelivery', patch: { batchSize: v } })
            }
          />
        )}
        <NumField
          label={t('maxAttempts')}
          value={delivery.maxAttempts}
          min={1}
          onChange={(v) =>
            dispatch({ type: 'patchDelivery', patch: { maxAttempts: v } })
          }
        />
        {syncMode === 'oneTime' && (
          <NumField
            label={t('delayBetween')}
            value={delivery.minDelayMs}
            min={0}
            onChange={(v) =>
              dispatch({ type: 'patchDelivery', patch: { minDelayMs: v } })
            }
          />
        )}
        <NumField
          label={t('timeout')}
          value={delivery.timeoutMs}
          min={100}
          onChange={(v) =>
            dispatch({ type: 'patchDelivery', patch: { timeoutMs: v } })
          }
        />
      </div>
      {/* on-failure abort is a job concept. a listener must never stop on one bad delivery */}
      {syncMode === 'oneTime' && (
        <div className="grid gap-1.5">
          <Label className="text-xs">{t('onFailure')}</Label>
          <Select
            value={delivery.onError}
            onValueChange={(v) =>
              dispatch({
                type: 'patchDelivery',
                patch: { onError: v as 'continue' | 'abort' },
              })
            }
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="continue">
                {t('logContinue')}
              </SelectItem>
              <SelectItem value="abort">{t('stopJob')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </section>
  );
}
