import React from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { THEME } from '@/lib/theme';
import { Text } from '@/components/ui/text';

export function Screen({ children, scroll = true }: { children: React.ReactNode; scroll?: boolean }) {
  const { colorScheme } = useColorScheme();
  const colors = THEME[colorScheme ?? 'light'];

  return (
    <SafeAreaView
      className="bg-background"
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      {scroll ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 36 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function ScreenTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return (
    <View className="mb-7">
      <Text className="text-[10px] font-medium uppercase tracking-[1.6px] text-muted-foreground">
        {eyebrow}
      </Text>
      <View className="mt-2 flex-row items-center justify-between" style={{ gap: 16 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text className="text-[32px] font-normal leading-10 tracking-[-1.8px]">
            {title}
          </Text>
        </View>
        {action}
      </View>
      <Text className="mt-2 text-xs leading-5 text-muted-foreground">
        {description}
      </Text>
    </View>
  );
}
