import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronRight, MessageCircle } from 'lucide-react-native';
import type { Conversation } from '@slopbot/contracts';
import { api } from '@/src/lib/api';
import { useApp } from '@/src/lib/app-state';
import { Screen, ScreenTitle } from '@/src/components/screen';
import { BotAvatar } from '@/src/components/bot-avatar';
import { Text } from '@/components/ui/text';

export default function ChatsScreen() {
  const { data, refresh } = useApp();
  const [opening, setOpening] = useState<string>();
  const [error, setError] = useState<string>();
  if (!data) return null;

  async function openBot(botId: string) {
    const bot = data?.bots.find((item) => item.id === botId);
    if (!bot || opening) return;
    setOpening(botId);
    setError(undefined);
    try {
      const existing = data?.conversations.find((conversation) => conversation.botIds.includes(botId));
      const conversation = existing ?? (await api<{ conversation: Conversation }>('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: bot.name, botIds: [bot.id] }),
      })).conversation;
      await refresh();
      router.push({ pathname: '/conversation/[id]', params: { id: conversation.id } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open chat.');
    } finally {
      setOpening(undefined);
    }
  }

  return (
    <Screen>
      <ScreenTitle
        eyebrow="BOTS"
        title="Your chats."
        description="Choose a bot to pick up where you left off."
      />

      <View>
        {data.bots.map((bot) => {
          const conversation = data.conversations.find((item) => item.botIds.includes(bot.id));
          const running = conversation?.runStatus === 'running';
          return (
            <Pressable
              accessibilityLabel={`Chat with ${bot.name}`}
              className="flex-row items-center py-4 active:bg-muted"
              disabled={Boolean(opening)}
              style={{ gap: 12, opacity: opening && opening !== bot.id ? 0.5 : 1 }}
              key={bot.id}
              onPress={() => void openBot(bot.id)}
            >
              <BotAvatar bot={bot} size={36} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text className="text-sm font-medium" numberOfLines={1}>{bot.name}</Text>
                <Text className="mt-1 text-[10px] text-muted-foreground" numberOfLines={1}>
                  @{bot.handle}{running ? ' · thinking…' : ''}
                </Text>
              </View>
              <ChevronRight className="shrink-0 text-muted-foreground" size={16} />
            </Pressable>
          );
        })}
      </View>

      {error ? <Text className="mt-4 text-xs leading-5 text-destructive">{error}</Text> : null}

      {data.bots.length === 0 ? (
        <View className="mt-4 items-center px-6 py-14">
          <MessageCircle className="mb-4 text-muted-foreground" size={30} />
          <Text className="text-base font-medium">No bots yet</Text>
          <Text className="mt-2 text-center text-sm leading-6 text-muted-foreground">
            Create a bot first, then chat with it here.
          </Text>
        </View>
      ) : null}

      <View className="mt-8 flex-row items-center gap-2 pt-4">
        <View className="h-2 w-2 bg-foreground" />
        <Text className="flex-1 text-[10px] uppercase leading-5 text-muted-foreground">
          {data.agentMode === 'gateway' ? 'AI gateway connected' : 'Demo responder · Add AI_GATEWAY_API_KEY for real inference'}
        </Text>
      </View>
    </Screen>
  );
}
