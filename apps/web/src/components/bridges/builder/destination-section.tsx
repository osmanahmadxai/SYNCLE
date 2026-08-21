'use client';

/**
 * where rows go: the HTTP-vs-database toggle, the HTTP endpoint form
 * (method/URL, auth, extra headers, idempotency), or the database targets
 * editor.
 */
import type { Dispatch } from 'react';
import { Database, Plus, Webhook, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DbTargetsEditor } from './db-targets-editor';
import type { AuthType, BuilderAction, BuilderDraft, Destination } from './draft';

export function DestinationSection({
  draft,
  dispatch,
  includedList,
  singlePk,
}: {
  draft: Pick<BuilderDraft, 'destKind' | 'dest' | 'dbTargets'>;
  dispatch: Dispatch<BuilderAction>;
  includedList: string[];
  singlePk: string | null;
}) {
  const t = useTranslations('bridgeBuilder');
  const { destKind, dest, dbTargets } = draft;

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{t('destination')}</h3>
      <div className="flex overflow-hidden rounded-md border text-xs">
        {(
          [
            ['http', t('httpEndpoint')],
            ['database', t('database')],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() =>
              dispatch({ type: 'setDestKind', destKind: k, sourcePk: singlePk })
            }
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 px-2.5 py-1.5 transition-colors',
              destKind === k
                ? 'bg-accent font-medium'
                : 'text-muted-foreground hover:bg-accent/50',
            )}
          >
            {k === 'http' ? (
              <Webhook className="h-3.5 w-3.5" />
            ) : (
              <Database className="h-3.5 w-3.5" />
            )}
            {label}
          </button>
        ))}
      </div>

      {destKind === 'database' && (
        <DbTargetsEditor
          targets={dbTargets}
          dispatch={dispatch}
          sourceColumns={includedList}
          sourcePk={singlePk}
        />
      )}

      {destKind === 'http' && (
      <>
      <div className="grid grid-cols-[90px_1fr] gap-2">
        <Select
          value={dest.method}
          onValueChange={(v) =>
            dispatch({
              type: 'patchDest',
              patch: { method: v as Destination['method'] },
            })
          }
        >
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="POST">POST</SelectItem>
            <SelectItem value="PUT">PUT</SelectItem>
            <SelectItem value="PATCH">PATCH</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={dest.url}
          placeholder="https://api.example.com/webhook"
          className="h-8"
          onChange={(e) =>
            dispatch({ type: 'patchDest', patch: { url: e.target.value } })
          }
        />
      </div>

      <Select
        value={dest.authType}
        onValueChange={(v) =>
          dispatch({ type: 'patchDest', patch: { authType: v as AuthType } })
        }
      >
        <SelectTrigger className="h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{t('authNone')}</SelectItem>
          <SelectItem value="bearer">{t('authBearer')}</SelectItem>
          <SelectItem value="header">{t('authHeader')}</SelectItem>
        </SelectContent>
      </Select>
      {dest.authType === 'bearer' && (
        <Input
          type="password"
          className="h-8"
          placeholder={t('token')}
          value={dest.authToken}
          onChange={(e) =>
            dispatch({ type: 'patchDest', patch: { authToken: e.target.value } })
          }
        />
      )}
      {dest.authType === 'header' && (
        <div className="grid grid-cols-2 gap-2">
          <Input
            className="h-8"
            placeholder="X-API-Key"
            value={dest.authHeaderName}
            onChange={(e) =>
              dispatch({
                type: 'patchDest',
                patch: { authHeaderName: e.target.value },
              })
            }
          />
          <Input
            className="h-8"
            type="password"
            placeholder={t('value')}
            value={dest.authHeaderValue}
            onChange={(e) =>
              dispatch({
                type: 'patchDest',
                patch: { authHeaderValue: e.target.value },
              })
            }
          />
        </div>
      )}

      {dest.headers.map((h, i) => (
        <div
          key={i}
          className="grid grid-cols-[1fr_1fr_auto] gap-1.5"
        >
          <Input
            className="h-8"
            placeholder={t('header')}
            value={h.key}
            onChange={(e) =>
              dispatch({
                type: 'patchDestHeader',
                index: i,
                patch: { key: e.target.value },
              })
            }
          />
          <Input
            className="h-8"
            placeholder={t('value')}
            value={h.value}
            onChange={(e) =>
              dispatch({
                type: 'patchDestHeader',
                index: i,
                patch: { value: e.target.value },
              })
            }
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => dispatch({ type: 'removeDestHeader', index: i })}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="h-7"
        onClick={() => dispatch({ type: 'addDestHeader' })}
      >
        <Plus className="mr-1 h-3.5 w-3.5" /> {t('header')}
      </Button>

      <label className="flex items-center justify-between rounded-md border p-2.5">
        <span className="text-xs">
          {t('send')} <code>Idempotency-Key</code>
        </span>
        <Switch
          checked={dest.idempotency}
          onCheckedChange={(v) =>
            dispatch({ type: 'patchDest', patch: { idempotency: v } })
          }
        />
      </label>
      </>
      )}
    </section>
  );
}
