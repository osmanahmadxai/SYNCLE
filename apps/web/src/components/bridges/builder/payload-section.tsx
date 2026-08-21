'use client';

/**
 * "what gets sent": the wrap-key input plus a live preview of the payload —
 * a schema (field → JS type) and a real sample body rendered with the exact
 * transform / mapping the runner will use.
 */
import { useMemo, type Dispatch } from 'react';
import { useTranslations } from 'next-intl';
import { mapRow, renderRow } from '@syncle/core';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { BuilderAction, BuilderDraft } from './draft';

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
}: {
  draft: Pick<BuilderDraft, 'wrapKey' | 'table' | 'destKind' | 'dbTargets'>;
  dispatch: Dispatch<BuilderAction>;
  sampleRow: Record<string, unknown> | undefined;
  includedList: string[];
}) {
  const t = useTranslations('bridgeBuilder');
  const { wrapKey, table, destKind, dbTargets } = draft;

  /* live payload: schema (field → type) + a real sample body */
  const preview = useMemo(() => {
    if (!sampleRow || includedList.length === 0) return null;
    const schemaShape: Record<string, string> = {};
    for (const c of includedList) schemaShape[c] = jsType(sampleRow[c]);
    let body: unknown = null;
    let error: string | null = null;
    try {
      if (destKind === 'database') {
        const renames = dbTargets[0]?.renames ?? {};
        body = mapRow(
          sampleRow,
          includedList.map((s) => ({ source: s, target: renames[s]?.trim() || s })),
        );
      } else {
        body = renderRow(
          sampleRow,
          {
            template: '{{$row}}',
            fields: includedList,
            wrapKey: wrapKey || undefined,
          },
          { table: table || '(table)', now: new Date().toISOString(), index: 0 },
        ).body;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return {
      schema: wrapKey ? { [wrapKey]: schemaShape } : schemaShape,
      body,
      error,
    };
  }, [sampleRow, includedList, wrapKey, table, destKind, dbTargets]);

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
