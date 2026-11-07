import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Plus, Users } from 'lucide-react-native';
import { useApp } from '@/src/lib/app-state';
import { lyra } from '@slopbot/design-tokens';
import { Screen, ScreenTitle } from '@/src/components/screen';
import { ConversationDialog } from '@/src/components/product-dialogs';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Badge } from '@/components/ui/badge';

export default function RoomsScreen() {
  const { data } = useApp();
  const [creating, setCreating] = useState(false);
  if (!data) return null;
  return <Screen><ScreenTitle eyebrow="BOT ROOMS" title="Let's talk." description="One bot for focus. A few bots for productive disagreement." action={<Button size="icon" onPress={() => setCreating(true)}><Plus /></Button>} />
    <View className="gap-3">{data.conversations.map((conversation) => <Pressable className="border border-border bg-card active:bg-muted" style={{ padding: lyra.spacing.lg }} key={conversation.id} onPress={() => router.push({ pathname: '/conversation/[id]', params: { id: conversation.id } })}><View className="flex-row items-center gap-3"><View className="flex-row">{conversation.botIds.map((id, index) => { const bot = data.bots.find((item) => item.id === id); return <View className="-ml-1 size-8 items-center justify-center border-2 border-background first:ml-0" key={id} style={{ backgroundColor: bot?.color ?? '#737373', zIndex: 10 - index }}><Text className="text-xs text-white">{bot?.name[0] ?? '?'}</Text></View>; })}</View><View className="flex-1"><Text className="text-sm font-medium">{conversation.title}</Text><Text className="mt-1 text-[10px] text-muted-foreground">{conversation.botIds.length} {conversation.botIds.length === 1 ? 'bot' : 'bots'}</Text></View><Badge variant={conversation.runStatus === 'running' ? 'default' : 'secondary'}><Text>{conversation.runStatus === 'running' ? 'THINKING' : 'READY'}</Text></Badge></View></Pressable>)}</View>
    {data.conversations.length === 0 ? <View className="items-center border border-dashed border-border px-5 py-16"><Users className="mb-4 text-muted-foreground" size={30} /><Text className="text-sm">No bot rooms yet.</Text><Button className="mt-5" onPress={() => setCreating(true)} variant="outline"><Text>Create a room</Text></Button></View> : null}
    <View className="mt-8 border-t border-border pt-4"><Text className="text-[10px] text-muted-foreground">{data.agentMode === 'gateway' ? 'VERCEL AI GATEWAY CONNECTED' : 'DEMO RESPONDER · ADD AI_GATEWAY_API_KEY FOR REAL INFERENCE'}</Text></View>
    <ConversationDialog bots={data.bots} onOpenChange={setCreating} open={creating} />
  </Screen>;
}
