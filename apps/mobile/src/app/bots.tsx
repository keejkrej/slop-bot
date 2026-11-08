import React, { useState } from 'react';
import { View } from 'react-native';
import { Plus } from 'lucide-react-native';
import { useApp } from '@/src/lib/app-state';
import { Screen, ScreenTitle } from '@/src/components/screen';
import { BotAvatar } from '@/src/components/bot-avatar';
import { BotDialog } from '@/src/components/product-dialogs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Text } from '@/components/ui/text';

export default function BotsScreen() {
  const { data } = useApp();
  const [creating, setCreating] = useState(false);
  if (!data) return null;

  return (
    <Screen>
      <ScreenTitle
        eyebrow="CASTING ROOM"
        title="Your bots."
        description="Distinct instructions, models, and tools. Put them together and see what happens."
        action={<Button accessibilityLabel="Create bot" size="icon" variant="outline" onPress={() => setCreating(true)}><Plus size={20} /></Button>}
      />

      <View style={{ gap: 12 }}>
        {data.bots.map((bot) => (
          <Card key={bot.id}>
            <CardHeader>
              <View className="flex-row items-center" style={{ gap: 12 }}>
                <BotAvatar bot={bot} size={40} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <CardTitle numberOfLines={1}>{bot.name}</CardTitle>
                  <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={1}>@{bot.handle}</Text>
                </View>
              </View>
            </CardHeader>
            <CardContent>
              <Text className="text-xs leading-5 text-muted-foreground">{bot.persona}</Text>
              <View className="mt-4 flex-row flex-wrap gap-2">
                <Badge variant="outline"><Text>{bot.model.split('/').pop()}</Text></Badge>
                <Badge variant="secondary">
                  <Text>{bot.integrationIds.length} {bot.integrationIds.length === 1 ? 'tool link' : 'tool links'}</Text>
                </Badge>
              </View>
            </CardContent>
          </Card>
        ))}
      </View>

      {creating ? <BotDialog integrations={data.integrations} onOpenChange={setCreating} open={creating} /> : null}
    </Screen>
  );
}
