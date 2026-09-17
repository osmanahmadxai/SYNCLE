'use client';

/**
 * bridges from a file. the file talks about connections by the ids they had
 * where it was exported; when this instance has no obvious counterpart for one
 * (same id, or the only connection here with that name and engine), the server
 * says so — with the candidates — and this asks.
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  bridgeExportSchema,
  type BridgeExportDocument,
  type UnresolvedConnection,
} from '@syncle/core';
import { ApiError } from '@/lib/api';
import { useImportBridges } from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** the file's text as an export document, or why it is not one */
export function readExport(
  text: string,
):
  | { document: BridgeExportDocument }
  | { problem: 'not-json' | 'not-an-export' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: 'not-json' };
  }
  const result = bridgeExportSchema.safeParse(parsed);
  return result.success
    ? { document: result.data }
    : { problem: 'not-an-export' };
}

export function ImportBridgesButton() {
  const t = useTranslations('bridgeTransfer');
  const input = useRef<HTMLInputElement>(null);
  const importBridges = useImportBridges();
  const { activeWorkspaceId, selectBridge } = useStudio();
  const [pending, setPending] = useState<{
    document: BridgeExportDocument;
    unresolved: UnresolvedConnection[];
  } | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});

  async function send(
    document: BridgeExportDocument,
    connectionMap?: Record<string, string>,
  ) {
    try {
      const result = await importBridges.mutateAsync({
        document,
        connectionMap,
        workspaceId: activeWorkspaceId ?? undefined,
      });
      setPending(null);
      toast.success(t('imported', { count: result.created.length }), {
        description: result.warnings.length
          ? result.warnings.join('\n')
          : undefined,
        duration: result.warnings.length ? 12_000 : undefined,
      });
      if (result.created.length === 1) selectBridge(result.created[0]!.id);
    } catch (err) {
      const details =
        err instanceof ApiError
          ? (err.details as
              | { reason?: string; unresolved?: UnresolvedConnection[] }
              | undefined)
          : undefined;
      if (details?.reason === 'unresolved-connections' && details.unresolved) {
        setMap({});
        setPending({ document, unresolved: details.unresolved });
        return;
      }
      toast.error(t('couldNotImport'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    const read = readExport(await file.text());
    if ('problem' in read) {
      toast.error(t('couldNotImport'), {
        description: t(read.problem === 'not-json' ? 'notJson' : 'notAnExport'),
      });
      return;
    }
    await send(read.document);
  }

  const complete = pending?.unresolved.every((u) => map[u.id]) ?? false;

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          void handleFile(e.target.files?.[0]);
          // the same file can be picked again
          e.target.value = '';
        }}
      />
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1 px-2 text-xs"
        title={t('importHint')}
        disabled={importBridges.isPending}
        onClick={() => input.current?.click()}
      >
        {importBridges.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Upload className="h-3.5 w-3.5" />
        )}
        {t('import')}
      </Button>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
      >
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{t('mapTitle')}</DialogTitle>
            <DialogDescription>{t('mapDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {pending?.unresolved.map((u) => (
              <div key={u.id} className="grid gap-1.5">
                <Label className="text-xs">
                  {u.name}{' '}
                  <span className="text-muted-foreground uppercase">
                    {u.engine}
                  </span>
                </Label>
                {u.candidates.length === 0 ? (
                  <p className="text-destructive text-xs">
                    {t('noCandidates', { engine: u.engine })}
                  </p>
                ) : (
                  <Select
                    value={map[u.id] ?? ''}
                    onValueChange={(v) => setMap((m) => ({ ...m, [u.id]: v }))}
                  >
                    <SelectTrigger className="h-8" aria-label={u.name}>
                      <SelectValue placeholder={t('pickConnection')} />
                    </SelectTrigger>
                    <SelectContent>
                      {u.candidates.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t('cancel')}
            </Button>
            <Button
              disabled={!complete || importBridges.isPending}
              onClick={() => pending && void send(pending.document, map)}
            >
              {importBridges.isPending && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              {t('importNow')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
