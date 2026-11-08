import '../../global.css';
import React from 'react';
import { Tabs } from 'expo-router';
import { ThemeProvider } from 'expo-router/react-navigation';
import { PortalHost } from '@rn-primitives/portal';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'nativewind';
import { Bot, Cable, MessageCircle } from 'lucide-react-native';
import { NAV_THEME, THEME } from '@/lib/theme';
import { AppProvider } from '@/src/lib/app-state';
import { AppGate } from '@/src/components/app-gate';

export { ErrorBoundary } from 'expo-router';

export default function RootLayout() {
  const { colorScheme = 'light' } = useColorScheme();
  const colors = THEME[colorScheme];

  return (
    <ThemeProvider value={NAV_THEME[colorScheme]}>
      <AppProvider>
        <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
        <AppGate>
          <Tabs
            screenOptions={{
              headerShown: false,
              tabBarActiveTintColor: colors.foreground,
              tabBarInactiveTintColor: colors.mutedForeground,
              tabBarStyle: {
                backgroundColor: colors.background,
                borderTopColor: colors.border,
                borderTopWidth: 1,
              },
              tabBarItemStyle: { paddingVertical: 4 },
              tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
            }}
          >
            <Tabs.Screen name="index" options={{ title: 'Rooms', tabBarIcon: ({ color }) => <MessageCircle color={color} size={22} /> }} />
            <Tabs.Screen name="bots" options={{ title: 'Bots', tabBarIcon: ({ color }) => <Bot color={color} size={22} /> }} />
            <Tabs.Screen name="connections" options={{ title: 'Tools', tabBarIcon: ({ color }) => <Cable color={color} size={22} /> }} />
            <Tabs.Screen name="conversation/[id]" options={{ href: null, tabBarStyle: { display: 'none' } }} />
            <Tabs.Screen name="integrations" options={{ href: null, tabBarStyle: { display: 'none' } }} />
          </Tabs>
        </AppGate>
        <PortalHost />
      </AppProvider>
    </ThemeProvider>
  );
}
