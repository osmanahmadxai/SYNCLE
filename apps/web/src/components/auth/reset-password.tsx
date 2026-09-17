'use client';

/**
 * "I cannot sign in."
 *
 * There is no e-mail to send a link to. The proof of being the operator is what
 * it was on the first day: being able to read the server's console. Pressing
 * the button makes a code appear THERE — and says nothing here about whether
 * it did — and that code, with a new password, is a way back in.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { KeyRound, Loader2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useRequestPasswordReset, useResetPassword } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** what stops the form from being sent; null = nothing */
export function resetProblem(form: {
  code: string;
  password: string;
  confirm: string;
}): 'code' | 'short' | 'mismatch' | null {
  if (!form.code.trim()) return 'code';
  if (form.password.length < 8) return 'short';
  if (form.password !== form.confirm) return 'mismatch';
  return null;
}

export function ResetPassword({
  onBack,
  requested = false,
}: {
  onBack: () => void;
  requested?: boolean;
}) {
  const t = useTranslations('auth.reset');
  const tc = useTranslations('common');
  const request = useRequestPasswordReset();
  const reset = useResetPassword();
  const [asked, setAsked] = useState(requested);
  const [form, setForm] = useState({ code: '', password: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    setError(null);
    try {
      await request.mutateAsync();
      setAsked(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : tc('somethingWrong'));
    }
  }

  async function submit() {
    if (reset.isPending) return;
    const problem = resetProblem(form);
    if (problem) return setError(t(`problem.${problem}`));
    setError(null);
    try {
      await reset.mutateAsync({
        resetCode: form.code.trim(),
        newPassword: form.password,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : tc('somethingWrong'));
    }
  }

  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-sm">{t('how')}</p>
      {!asked ? (
        <Button
          type="button"
          className="w-full"
          disabled={request.isPending}
          onClick={() => void ask()}
        >
          {request.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <KeyRound className="mr-2 h-4 w-4" />
          )}
          {t('ask')}
        </Button>
      ) : (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="bg-muted/50 space-y-1 rounded-md p-3 text-xs">
            <p>{t('where')}</p>
            <p className="font-mono">syncle logs api</p>
            <p className="font-mono">docker compose logs api</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reset-code">{t('code')}</Label>
            <Input
              id="reset-code"
              autoFocus
              autoComplete="one-time-code"
              className="font-mono"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reset-password">{t('newPassword')}</Label>
            <Input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reset-confirm">{t('confirm')}</Label>
            <Input
              id="reset-confirm"
              type="password"
              autoComplete="new-password"
              value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            />
          </div>
          <Button type="submit" className="w-full" disabled={reset.isPending}>
            {reset.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {t('submit')}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
        onClick={onBack}
      >
        {t('back')}
      </button>
    </div>
  );
}
