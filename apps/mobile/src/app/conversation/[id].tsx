import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowLeft, ArrowUp, Play, Users } from 'lucide-react-native';
import type { Bot, ChatMessage, ConversationDetail } from '@slopbot/contracts';
import { api } from '@/src/lib/api';
import { useApp } from '@/src/lib/app-state';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { THEME } from '@/lib/theme';
import { Screen } from '@/src/components/screen';
import { BotAvatar } from '@/src/components/bot-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { Textarea } from '@/components/ui/textarea';

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, refresh } = useApp();
  const { colorScheme = 'light' } = useColorScheme();
  const colors = THEME[colorScheme];
  const insets = useSafeAreaInsets();
  const [detail, setDetail] = useState<ConversationDetail>();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api<ConversationDetail>(`/api/conversations/${id}`));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load room.');
    }
  }, [id]);

  useEffect(() => {
    let active = true;
    void api<ConversationDetail>(`/api/conversations/${id}`).then((result) => {
      if (!active) return;
      setDetail(result);
      setError(undefined);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not load room.');
    });
    return () => { active = false; };
  }, [id]);

  const running = detail?.conversation.runStatus === 'running';
  useEffect(() => {
    if (!running) { void refresh(); return; }
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [running, load, refresh]);

  useEffect(() => {
    const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    return () => clearTimeout(timer);
  }, [detail?.messages.length]);

  async function send() {
    const content = draft.trim();
    if (!content || busy || running) return;
    setBusy(true);
    setDraft('');
    setError(undefined);
    try {
      await api(`/api/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
      await load();
    } catch (cause) {
      setDraft(content);
      setError(cause instanceof Error ? cause.message : 'Message failed.');
    } finally {
      setBusy(false);
    }
  }

  async function round() {
    setBusy(true);
    try {
      await api(`/api/conversations/${id}/round`, { method: 'POST' });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Round failed.');
    } finally {
      setBusy(false);
    }
  }

  async function approve(actionId: string, approved: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/conversations/${id}/approvals/${actionId}`, { method: 'POST', body: JSON.stringify({ approved }) });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update approval.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen scroll={false}>
      <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={insets.top} style={{ flex: 1 }}>
        <View className="flex-row items-center border-b border-border px-3 py-2" style={{ gap: 8 }}>
          <Pressable
            accessibilityLabel="Back"
            className="h-11 w-11 items-center justify-center active:bg-muted"
            onPress={() => router.back()}
          >
            <ArrowLeft size={20} />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text className="text-sm font-medium" numberOfLines={1}>
              {detail?.conversation.title ?? 'Loading room…'}
            </Text>
            <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
              {detail?.conversation.botIds.map((botId) => `@${data?.bots.find((bot) => bot.id === botId)?.handle ?? 'unknown'}`).join(' · ')}
            </Text>
          </View>
          <Button disabled={busy || running} onPress={() => void round()} size="sm" variant="outline">
            <Play size={14} /><Text>Round</Text>
          </Button>
        </View>

        {!detail ? (
          <View className="flex-1 items-center justify-center p-6">
            {error ? (
              <>
                <Text className="text-center text-sm leading-6 text-destructive">{error}</Text>
                <Button className="mt-5" onPress={() => void load()} variant="outline"><Text>Try again</Text></Button>
              </>
            ) : <ActivityIndicator />}
          </View>
        ) : (
          <FlatList
            contentContainerStyle={{ padding: 20, paddingBottom: 32, gap: 22, flexGrow: detail.messages.length === 0 ? 1 : 0 }}
            style={{ flex: 1, width: '100%' }}
            data={detail.messages}
            keyExtractor={(message) => message.id}
            ListEmptyComponent={
              <View className="flex-1 items-center justify-center px-6 py-16">
                <View className="mb-5 h-12 w-12 items-center justify-center bg-muted">
                  <Users className="text-muted-foreground" size={24} />
                </View>
                <Text className="text-xl font-medium tracking-[-0.8px]">The floor is yours.</Text>
                <Text className="mt-3 max-w-72 text-center text-xs leading-5 text-muted-foreground">
                  Send a message, or start a round and let every bot respond once.
                </Text>
                <Button className="mt-6" disabled={busy} onPress={() => void round()} variant="outline"><Text>Start bot round</Text></Button>
              </View>
            }
            ListFooterComponent={<>
              {detail.pendingActions.map((action) => (
                <View className="border border-border bg-muted p-4" key={action.id}>
                  <Text className="mb-2 text-xs font-medium text-muted-foreground">Approval required</Text>
                  <Text className="mb-4 text-xs leading-5">{action.summary}</Text>
                  <View className="flex-row gap-3">
                    <Button disabled={busy} onPress={() => void approve(action.id, true)} size="sm"><Text>Approve send</Text></Button>
                    <Button disabled={busy} onPress={() => void approve(action.id, false)} size="sm" variant="ghost"><Text>Deny</Text></Button>
                  </View>
                </View>
              ))}
              {running ? (
                <View className="flex-row items-center gap-2">
                  <ActivityIndicator size="small" />
                  <Text className="text-xs text-muted-foreground">Bots are responding in sequence…</Text>
                </View>
              ) : null}
              {error ? <Text className="text-xs leading-5 text-destructive">{error}</Text> : null}
            </>}
            ref={listRef}
            renderItem={({ item }) => <Message bots={data?.bots ?? []} message={item} />}
          />
        )}

        <View className="border-t border-border bg-background px-4 pt-3">
          <View className="flex-row items-end" style={{ gap: 8 }}>
            <Textarea
              className="max-h-32 min-h-11 w-auto flex-1 px-4 py-3 text-xs"
              style={{ flex: 1, minWidth: 0 }}
              editable={!running && !busy}
              onChangeText={setDraft}
              placeholder={running ? 'Wait for this round…' : 'Message the group…'}
              value={draft}
            />
            <Button
              accessibilityLabel="Send message"
              className="h-11 w-11"
              disabled={!draft.trim() || busy || running}
              onPress={() => void send()}
              size="icon"
            >
              {busy ? <ActivityIndicator color={colors.primaryForeground} /> : <Icon as={ArrowUp} size={18} />}
            </Button>
          </View>
          <View className="mt-2 flex-row items-center justify-between gap-3">
            <Text className="text-[10px] uppercase text-muted-foreground">Max 4 bots per round</Text>
            <Badge variant="secondary"><Text>{running ? 'THINKING' : 'READY'}</Text></Badge>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Message({ message, bots }: { message: ChatMessage; bots: Bot[] }) {
  const { colorScheme = 'light' } = useColorScheme();
  const colors = THEME[colorScheme];

  if (message.senderType === 'user') {
    return (
      <View style={{ alignItems: 'flex-end', width: '100%' }}>
        <View style={{ backgroundColor: colors.muted, borderColor: colors.border, borderWidth: 1, maxWidth: '88%', paddingHorizontal: 16, paddingVertical: 12 }}>
          <Text style={{ color: colors.foreground, fontSize: 12, lineHeight: 20, flexWrap: 'wrap' }}>{message.content}</Text>
          <Text style={{ color: colors.mutedForeground, marginTop: 8, textAlign: 'right', fontSize: 9 }}>YOU</Text>
        </View>
      </View>
    );
  }

  if (message.senderType === 'system') {
    return <Text className="border-l-2 border-destructive pl-3 text-xs leading-5 text-muted-foreground">{message.content}</Text>;
  }

  const bot = bots.find((item) => item.id === message.senderId);
  return (
    <View style={{ width: '100%', flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
      <BotAvatar bot={bot} size={32} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View className="mb-1 flex-row items-baseline gap-2">
          <Text className="text-xs font-medium">{bot?.name ?? 'Removed bot'}</Text>
          <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>@{bot?.handle ?? 'unknown'}</Text>
        </View>
        <Text className={`text-xs leading-6 ${message.status === 'failed' ? 'text-destructive' : ''}`} style={{ width: '100%', flexWrap: 'wrap' }}>
          {message.content}
        </Text>
      </View>
    </View>
  );
}
