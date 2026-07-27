'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useSetup } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function SetupScreen() {
  const t = useTranslations('auth.setup');
  const tc = useTranslations('common');
  const setup = useSetup();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    // the Enter-key handler bypasses the button's disabled state
    if (setup.isPending) return;
    if (username.trim().length < 3) {
      setError(t('usernameTooShort'));
      return;
    }
    if (password.length < 8) {
      setError(t('passwordTooShort'));
      return;
    }
    if (password !== confirm) {
      setError(t('passwordsNoMatch'));
      return;
    }
    setError(null);
    try {
      await setup.mutateAsync({ username: username.trim(), password });
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : tc('somethingWrong');
      setError(message);
      toast.error(t('couldNotCreate'), { description: message });
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/20 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <Image
            src="/logo-dark.png"
            alt="Syncle"
            width={747}
            height={412}
            priority
            className="mb-2 h-8 w-auto dark:hidden"
          />
          <Image
            src="/logo-white.png"
            alt="Syncle"
            width={747}
            height={412}
            priority
            className="mb-2 hidden h-8 w-auto dark:block"
          />
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="username">{t('username')}</Label>
              <Input
                id="username"
                autoFocus
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">{t('password')}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                {t('passwordHint')}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm">{t('confirm')}</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <Button type="submit" className="w-full" disabled={setup.isPending}>
              {setup.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="mr-2 h-4 w-4" />
              )}
              {t('submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
