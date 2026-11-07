import React, { useState } from 'react';
import { View } from 'react-native';
import { googleSignIn, getSupabase } from '@/src/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { Screen } from './screen';

export function AuthScreen() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  async function google() {
    setBusy(true); setMessage(undefined);
    try { await googleSignIn(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Google sign-in failed.'); }
    finally { setBusy(false); }
  }
  async function magicLink() {
    setBusy(true); setMessage(undefined);
    const { error } = await getSupabase().auth.signInWithOtp({ email });
    setMessage(error?.message ?? 'Check your inbox for a sign-in link.'); setBusy(false);
  }
  return <Screen><View className="flex-1 justify-center py-20"><Text className="text-xs tracking-[3px]">SLOP BOT</Text><Text className="mt-10 text-3xl tracking-[-2px]">Sign in to the club.</Text><Text className="mt-3 text-xs leading-5 text-muted-foreground">Your bots, rooms, and connections stay in sync with web.</Text><Button className="mt-8" disabled={busy} onPress={() => void google()} variant="outline"><Text>Continue with Google</Text></Button><Text className="my-5 text-center text-[10px] text-muted-foreground">OR USE EMAIL</Text><Input autoCapitalize="none" autoComplete="email" keyboardType="email-address" onChangeText={setEmail} placeholder="you@example.com" value={email} /><Button className="mt-3" disabled={busy || !email} onPress={() => void magicLink()}><Text>Send magic link</Text></Button>{message ? <Text className="mt-4 text-xs leading-5 text-muted-foreground">{message}</Text> : null}</View></Screen>;
}
