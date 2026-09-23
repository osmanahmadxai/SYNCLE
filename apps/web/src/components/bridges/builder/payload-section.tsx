'use client';

/**
 * "what gets sent": the wrap-key input plus a live preview of the payload —
 * a schema (field → JS type) and a real sample body rendered with the exact
 * transform / mapping the runner will use.
 */
import { useMemo, type Dispatch } from 'react';
import { useTranslations } from 'next-intl';
import {
  applyColumnTransforms,
  mapRow,
  renderRow,
  type ColumnTransform,
} from '@syncle/core';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { BuilderAction, BuilderDraft } from './draft';

/** 64 hex characters, like the real thing, and plainly not it */
const HASH_STAND_IN = 'sha256:'.padEnd(64, '·');

function jsType(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function PayloadSection({
  draft,
  dispatch,
  sampleRow,
  includedList,
  transforms,
}: {
  draft: Pick<
    BuilderDraft,
    'wrapKey' | 'table' | 'destKind' | 'dbTargets' | 'template' | 'rename'
  >;
  dispatch: Dispatch<BuilderAction>;
  sampleRow: Record<string, unknown> | undefined;
  includedList: string[];
  transforms: ColumnTransform[];
}) {
  const t = useTranslations('bridgeBuilder');
  const { wrapKey, table, destKind, dbTargets } = draft;

  /* live payload: schema (field → type) + a real sample body */
  const preview = useMemo(() => {
    if (!sampleRow || includedList.length === 0) return null;
    const now = new Date().toISOString();
    // the same steps the runner applies, on the sample row. the one thing a
    // browser cannot do in a render is SHA-256, so a hashed value is shown as a
    // stand-in of the right shape; Dry run shows the real one
    const shaped = applyColumnTransforms(sampleRow, transforms, {
      table: table || '(table)',
      now,
      hash: () => HASH_STAND_IN,
    });
    const row = shaped.row;
    const schemaShape: Record<string, string> = {};
    for (const c of includedList) schemaShape[c] = jsType(row[c]);
    let body: unknown = null;
    let error: string | null = shaped.errors[0] ?? null;
    try {
      if (error) {
        // a cast set to fail the delivery, on a value that cannot be cast
      } else if (destKind === 'database') {
        const renames = dbTargets[0]?.renames ?? {};
        body = mapRow(
          row,
          includedList.map((s) => ({ source: s, target: renames[s]?.trim() || s })),
        );
      } else {
        body = renderRow(
          row,
          {
            template: draft.template || '{{$row}}',
            rename: draft.rename,
            fields: includedList,
            wrapKey: wrapKey || undefined,
          },
          { table: table || '(table)', now, index: 0 },
        ).body;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return {
      schema: wrapKey ? { [wrapKey]: schemaShape } : schemaShape,
      body,
      error,
      warnings: shaped.warnings,
      hashed: transforms.some((s) => s.kind === 'mask' && s.mode === 'hash'),
    };
  }, [
    sampleRow,
    includedList,
    transforms,
    wrapKey,
    table,
    destKind,
    dbTargets,
    draft.template,
    draft.rename,
  ]);

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">{t('whatGetsSent')}</h3>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1.5">
          <Label className="text-xs">{t('wrapKey')}</Label>
          <Input
            value={wrapKey}
            placeholder={t('wrapKeyPlaceholder')}
            className="h-8"
            onChange={(e) => dispatch({ type: 'setWrapKey', wrapKey: e.target.value })}
          />
        </div>
      </div>
      {preview?.error ? (
        <p className="text-destructive mt-2 text-xs">
          {preview.error}
        </p>
      ) : preview ? (
        <div className="mt-2 space-y-2">
          <div>
            <p className="text-muted-foreground mb-1 text-xs">
              {t('schemaTypes')}
            </p>
            <pre className="bg-muted max-h-40 overflow-auto rounded-md p-2 font-mono text-[11px] leading-relaxed">
              {JSON.stringify(preview.schema, null, 2)}
            </pre>
          </div>
          <div>
            <p className="text-muted-foreground mb-1 text-xs">
              {t('samplePayload')}
            </p>
            <pre className="bg-muted max-h-48 overflow-auto rounded-md p-2 font-mono text-[11px] leading-relaxed">
              {JSON.stringify(preview.body, null, 2)}
            </pre>
            {preview.hashed && (
              <p className="text-muted-foreground mt-1 text-[11px]">
                {t('hashStandIn')}
              </p>
            )}
            {preview.warnings.map((w) => (
              <p key={w} className="mt-1 text-[11px] text-amber-600 dark:text-amber-500">
                {w}
              </p>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground mt-2 text-xs">
          {t('previewHint')}
        </p>
      )}
    </section>
  );
}
