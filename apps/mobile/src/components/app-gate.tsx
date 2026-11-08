import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useApp } from '@/src/lib/app-state';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { AuthScreen } from './auth-screen';
import { Screen } from './screen';

export function AppGate({ children }: { children: React.ReactNode }) {
  const { data, loading, signedOut, error, refresh } = useApp();
  if (signedOut) return <AuthScreen />;
  if (loading || !data) return (
    <Screen scroll={false}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        {error ? (
          <>
            <Text className="text-center text-sm leading-6 text-destructive">{error}</Text>
            <Button className="mt-4" onPress={() => void refresh()} variant="outline"><Text>Try again</Text></Button>
          </>
        ) : (
          <>
            <ActivityIndicator />
            <Text className="mt-4 text-xs text-muted-foreground">Assembling your bots…</Text>
          </>
        )}
      </View>
    </Screen>
  );
  return <>{children}</>;
}
