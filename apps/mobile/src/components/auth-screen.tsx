import React, { useState } from 'react';
import { View } from 'react-native';
import { Triangle } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { THEME } from '@/lib/theme';
import { signInWithVercel } from '@/src/lib/vercel-auth';
import { useApp } from '@/src/lib/app-state';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { Screen } from './screen';

export function AuthScreen() {
  const { refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  async function signIn() {
    setBusy(true);
    setMessage(undefined);
    try {
      await signInWithVercel();
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Vercel sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen scroll={false}>
      <View style={{ flex: 1, justifyContent: 'center', padding: 20 }}>
        <View style={{ width: '100%', maxWidth: 384, alignSelf: 'center' }}>
          <View className="mb-10 flex-row items-center" style={{ gap: 12 }}>
            <LogoMark />
            <Text className="font-medium tracking-[-1px]">SLOP BOT</Text>
          </View>
          <Text className="mb-2 text-xs uppercase tracking-[1.5px] text-muted-foreground">
            Your personal bot club
          </Text>
          <Text className="mb-4 text-3xl leading-10 tracking-[-1.5px]">Sign in with Vercel.</Text>
          <Text className="mb-8 text-xs leading-5 text-muted-foreground">
            Single-tenant access. Only the Vercel account approved by this deployment can continue.
          </Text>
          {message ? <Text className="mb-4 text-xs leading-5 text-destructive">{message}</Text> : null}
          <Button disabled={busy} onPress={() => void signIn()} variant="outline">
            <Icon as={Triangle} size={14} />
            <Text>{busy ? 'Opening Vercel…' : 'Continue with Vercel'}</Text>
          </Button>
        </View>
      </View>
    </Screen>
  );
}

function LogoMark() {
  const { colorScheme = 'light' } = useColorScheme();
  const colors = THEME[colorScheme];
  const cell = { width: 9, height: 9, backgroundColor: colors.background };

  return (
    <View style={{ width: 28, height: 28, flexDirection: 'row', flexWrap: 'wrap', gap: 2, backgroundColor: colors.foreground, padding: 4 }}>
      <View style={cell} />
      <View style={[cell, { opacity: 0.4 }]} />
      <View style={[cell, { opacity: 0.4 }]} />
      <View style={cell} />
    </View>
  );
}
