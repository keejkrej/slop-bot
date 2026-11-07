import React from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { THEME } from '@/lib/theme';
import { lyra } from '@slopbot/design-tokens';
import { Text } from '@/components/ui/text';

export function Screen({ children, scroll = true }: { children: React.ReactNode; scroll?: boolean }) {
  const { colorScheme } = useColorScheme();
  const colors = THEME[colorScheme ?? 'light'];
  return <SafeAreaView className="flex-1 bg-background" style={{ backgroundColor: colors.background }}>{scroll ? <ScrollView className="flex-1" contentContainerStyle={{ padding: lyra.spacing.xl, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">{children}</ScrollView> : <View className="flex-1">{children}</View>}</SafeAreaView>;
}

export function ScreenTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <View className="mb-6"><Text className="mb-2 text-[10px] uppercase tracking-[2px] text-muted-foreground">{eyebrow}</Text><View className="flex-row items-end justify-between gap-3"><View className="flex-1"><Text className="text-3xl tracking-[-2px]">{title}</Text><Text className="mt-2 text-xs leading-5 text-muted-foreground">{description}</Text></View>{action}</View></View>;
}
