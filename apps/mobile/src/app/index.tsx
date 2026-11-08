import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronRight, Plus, Users } from 'lucide-react-native';
import { useApp } from '@/src/lib/app-state';
import { Screen, ScreenTitle } from '@/src/components/screen';
import { BotAvatarGroup } from '@/src/components/bot-avatar';
import { ConversationDialog } from '@/src/components/product-dialogs';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

export default function RoomsScreen() {
  const { data } = useApp();
  const [creating, setCreating] = useState(false);
  if (!data) return null;

  return (
    <Screen>
      <ScreenTitle
        eyebrow="BOT ROOMS"
        title="Your rooms."
        description="Pick up a conversation or bring a few bots together."
        action={<Button accessibilityLabel="Create room" size="icon" variant="outline" onPress={() => setCreating(true)}><Plus size={20} /></Button>}
      />

      <View className="border-t border-border">
        {data.conversations.map((conversation) => {
          const roomBots = conversation.botIds.flatMap((id) => {
            const bot = data.bots.find((item) => item.id === id);
            return bot ? [bot] : [];
          });
          const running = conversation.runStatus === 'running';

          return (
            <Pressable
              accessibilityLabel={`Open ${conversation.title}`}
              className="flex-row items-center border-b border-border py-4 active:bg-muted"
              style={{ gap: 12 }}
              key={conversation.id}
              onPress={() => router.push({ pathname: '/conversation/[id]', params: { id: conversation.id } })}
            >
              <BotAvatarGroup bots={roomBots} size={28} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text className="text-sm font-medium" numberOfLines={1}>{conversation.title}</Text>
                <Text className="mt-1 text-[10px] text-muted-foreground" numberOfLines={1}>
                  {conversation.botIds.length} {conversation.botIds.length === 1 ? 'bot' : 'bots'} · {running ? 'thinking…' : 'ready'}
                </Text>
              </View>
              <ChevronRight className="shrink-0 text-muted-foreground" size={16} />
            </Pressable>
          );
        })}
      </View>

      {data.conversations.length === 0 ? (
        <View className="items-center rounded-none border border-dashed border-border px-6 py-14">
          <Users className="mb-4 text-muted-foreground" size={30} />
          <Text className="text-base font-medium">No bot rooms yet</Text>
          <Text className="mt-2 text-center text-sm leading-6 text-muted-foreground">
            Bring a few bots together and start a conversation.
          </Text>
          <Button className="mt-6" onPress={() => setCreating(true)} variant="outline"><Text>Create a room</Text></Button>
        </View>
      ) : null}

      <View className="mt-8 flex-row items-center gap-2 border-t border-border pt-4">
        <View className="h-2 w-2 bg-foreground" />
        <Text className="flex-1 text-[10px] uppercase leading-5 text-muted-foreground">
          {data.agentMode === 'gateway' ? 'AI gateway connected' : 'Demo responder · Add AI_GATEWAY_API_KEY for real inference'}
        </Text>
      </View>

      {creating ? <ConversationDialog bots={data.bots} onOpenChange={setCreating} open={creating} /> : null}
    </Screen>
  );
}
