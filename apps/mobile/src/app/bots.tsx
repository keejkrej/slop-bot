import React, { useState } from 'react';
import { View } from 'react-native';
import { Plus } from 'lucide-react-native';
import { useApp } from '@/src/lib/app-state';
import { Screen, ScreenTitle } from '@/src/components/screen';
import { BotDialog } from '@/src/components/product-dialogs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Text } from '@/components/ui/text';

export default function BotsScreen() {
  const { data } = useApp(); const [creating, setCreating] = useState(false);
  if (!data) return null;
  return <Screen><ScreenTitle eyebrow="CASTING ROOM" title="Your bots." description="Personalities with their own instructions and tools." action={<Button size="icon" variant="outline" onPress={() => setCreating(true)}><Plus /></Button>} /><View className="gap-3">{data.bots.map((bot) => <Card key={bot.id}><CardHeader><View className="flex-row items-center gap-3"><View className="size-9 items-center justify-center" style={{ backgroundColor: bot.color }}><Text className="text-sm text-white">{bot.name[0]}</Text></View><View><CardTitle>{bot.name}</CardTitle><Text className="mt-1 text-[10px] text-muted-foreground">@{bot.handle}</Text></View></View></CardHeader><CardContent><Text className="text-xs leading-5 text-muted-foreground">{bot.persona}</Text><View className="mt-4 flex-row flex-wrap gap-2"><Badge variant="outline"><Text>{bot.model.split('/').pop()}</Text></Badge><Badge variant="secondary"><Text>{bot.integrationIds.length} TOOL LINKS</Text></Badge></View></CardContent></Card>)}</View><BotDialog integrations={data.integrations} onOpenChange={setCreating} open={creating} /></Screen>;
}
