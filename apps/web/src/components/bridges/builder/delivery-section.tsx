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
  draft: Pick<BuilderDraft, 'delivery' | 'syncMode' | 'destKind'>;
  dispatch: Dispatch<BuilderAction>;
}) {
  const t = useTranslations('bridgeBuilder');
  const { delivery, syncMode, destKind } = draft;

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
      {/* a live bridge defaults to `continue`: one bad row must not stop a
          listener. that used to mean the row was lost once the source's change
          log moved on; it is now parked in the dead-letter queue instead, so
          the choice is safe to offer either way */}
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
              {syncMode === 'oneTime'
                ? t('logContinue')
                : t('setAsideContinue')}
            </SelectItem>
            <SelectItem value="abort">
              {syncMode === 'oneTime' ? t('stopJob') : t('stopBridge')}
            </SelectItem>
          </SelectContent>
        </Select>
        {syncMode !== 'oneTime' && (
          <p className="text-muted-foreground text-xs">
            {delivery.onError === 'continue'
              ? t('onFailureContinueHint')
              : t('onFailureStopHint')}
          </p>
        )}
      </div>
      {/* a column the bridge maps, dropped or renamed at the source, used to
          reach the destination as NULL — over the value it held. `stop` is the
          default because that is the one outcome nobody chooses */}
      <div className="grid gap-1.5">
        <Label className="text-xs">{t('onSchemaChange')}</Label>
        <Select
          value={delivery.onSchemaChange}
          onValueChange={(v) =>
            dispatch({
              type: 'patchDelivery',
              patch: { onSchemaChange: v as 'stop' | 'continue' | 'evolve' },
            })
          }
        >
          <SelectTrigger className="h-8" aria-label={t('onSchemaChange')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stop">{t('schemaChangeStop')}</SelectItem>
            {destKind === 'database' && (
              <SelectItem value="evolve">{t('schemaChangeEvolve')}</SelectItem>
            )}
            <SelectItem value="continue">
              {t('schemaChangeContinue')}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          {t(`schemaChangeHint.${delivery.onSchemaChange}`)}
        </p>
      </div>
    </section>
  );
}
