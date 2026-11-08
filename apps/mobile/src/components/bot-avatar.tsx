import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { MAX_GROUP_BOTS, type Bot } from '@slopbot/contracts';
import { useColorScheme } from 'nativewind';
import { THEME } from '@/lib/theme';
import { Text } from '@/components/ui/text';

type AvatarBot = Pick<Bot, 'id' | 'name' | 'color'>;

const AVATAR_OVERLAP = 8;

export function BotAvatar({ bot, size = 36, style }: { bot?: AvatarBot; size?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      className="items-center justify-center"
      style={[{ width: size, height: size, backgroundColor: bot?.color ?? '#737373' }, style]}
    >
      <Text className="font-medium text-white" style={{ fontSize: Math.max(11, size * 0.36) }}>
        {bot?.name[0]?.toUpperCase() ?? '?'}
      </Text>
    </View>
  );
}

export function BotAvatarGroup({ bots, size = 30 }: { bots: AvatarBot[]; size?: number }) {
  const { colorScheme = 'light' } = useColorScheme();

  const width = MAX_GROUP_BOTS * size - (MAX_GROUP_BOTS - 1) * AVATAR_OVERLAP;

  return (
    <View className="flex-row items-center" style={{ width, height: size }}>
      {bots.map((bot, index) => (
        <BotAvatar
          bot={bot}
          key={bot.id}
          size={size}
          style={{
            marginLeft: index === 0 ? 0 : -AVATAR_OVERLAP,
            borderWidth: 2,
            borderColor: THEME[colorScheme].background,
            zIndex: bots.length - index,
          }}
        />
      ))}
    </View>
  );
}
