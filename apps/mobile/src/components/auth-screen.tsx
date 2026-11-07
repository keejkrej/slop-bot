import React, { useState } from 'react';
import { View } from 'react-native';
import { signInWithVercel } from '@/src/lib/vercel-auth';
import { useApp } from '@/src/lib/app-state';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Screen } from './screen';

export function AuthScreen() {
  const { refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  async function signIn() {
    setBusy(true); setMessage(undefined);
    try { await signInWithVercel(); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Vercel sign-in failed.'); }
    finally { setBusy(false); }
  }

  return <Screen><View className="flex-1 justify-center py-20"><Text className="text-xs tracking-[3px]">SLOP BOT</Text><Text className="mt-10 text-3xl tracking-[-2px]">Sign in with Vercel.</Text><Text className="mt-3 text-xs leading-5 text-muted-foreground">Single-tenant access for your approved Vercel account. Bots, rooms, and connections stay in sync with web.</Text><Button className="mt-8" disabled={busy} onPress={() => void signIn()}><Text>{busy ? 'Opening Vercel…' : 'Continue with Vercel'}</Text></Button>{message ? <Text className="mt-4 text-xs leading-5 text-destructive">{message}</Text> : null}</View></Screen>;
}
