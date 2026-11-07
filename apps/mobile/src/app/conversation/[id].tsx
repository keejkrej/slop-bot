import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowLeft, ArrowUp, Users } from 'lucide-react-native';
import type { Bot, ChatMessage, ConversationDetail } from '@slopbot/contracts';
import { api } from '@/src/lib/api';
import { useApp } from '@/src/lib/app-state';
import { useColorScheme } from 'nativewind';
import { THEME } from '@/lib/theme';
import { Screen } from '@/src/components/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Textarea } from '@/components/ui/textarea';

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, refresh } = useApp();
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

  useEffect(() => { void load(); }, [load]);
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
    setBusy(true); setDraft(''); setError(undefined);
    try {
      await api(`/api/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
      await load();
    } catch (cause) {
      setDraft(content);
      setError(cause instanceof Error ? cause.message : 'Message failed.');
    } finally { setBusy(false); }
  }

  async function round() {
    setBusy(true);
    try { await api(`/api/conversations/${id}/round`, { method: 'POST' }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Round failed.'); }
    finally { setBusy(false); }
  }

  return (
    <Screen scroll={false}>
      <KeyboardAvoidingView className="flex-1" style={{ flex: 1 }}>
        <View className="flex-row items-center gap-3 border-b border-border px-4 py-3">
          <Pressable accessibilityLabel="Back" className="p-1" onPress={() => router.back()}>
            <ArrowLeft size={20} />
          </Pressable>
          <View className="flex-1">
            <Text className="text-sm font-medium" numberOfLines={1}>{detail?.conversation.title ?? 'Loading room…'}</Text>
            <Text className="mt-1 text-[9px] text-muted-foreground" numberOfLines={1}>
              {detail?.conversation.botIds.map((botId) => `@${data?.bots.find((bot) => bot.id === botId)?.handle ?? 'unknown'}`).join(' · ')}
            </Text>
          </View>
          <Button disabled={busy || running} onPress={() => void round()} size="sm" variant="outline">
            <Users size={14} /><Text>Round</Text>
          </Button>
        </View>

        {!detail ? (
          <View className="flex-1 items-center justify-center"><ActivityIndicator /></View>
        ) : (
          <FlatList
            contentContainerStyle={{ padding: 20, paddingBottom: 32, gap: 24 }}
            style={{ flex: 1, width: '100%' }}
            data={detail.messages}
            keyExtractor={(message) => message.id}
            ListEmptyComponent={
              <View className="items-center py-20">
                <Users className="mb-4 text-muted-foreground" size={32} />
                <Text className="text-xl tracking-[-1px]">The floor is yours.</Text>
                <Text className="mt-3 max-w-64 text-center text-xs leading-5 text-muted-foreground">Send a message, or start a round and let every bot respond once.</Text>
                <Button className="mt-6" disabled={busy} onPress={() => void round()} variant="outline"><Text>Start bot round</Text></Button>
              </View>
            }
            ListFooterComponent={<>
              {running ? <View className="flex-row items-center gap-2"><ActivityIndicator size="small" /><Text className="text-xs text-muted-foreground">Bots are responding in sequence…</Text></View> : null}
              {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
            </>}
            ref={listRef}
            renderItem={({ item }) => <Message bots={data?.bots ?? []} message={item} />}
          />
        )}

        <View className="border-t border-border p-3" style={{ width: '100%' }}>
          <View className="flex-row items-end gap-2" style={{ width: '100%' }}>
            <Textarea className="max-h-32 min-h-11 flex-1 py-3" style={{ minWidth: 0, flexShrink: 1 }} editable={!running && !busy} onChangeText={setDraft} placeholder={running ? 'Wait for this round…' : 'Message the group…'} value={draft} />
            <Button className="size-11" disabled={!draft.trim() || busy || running} onPress={() => void send()} size="icon">
              {busy ? <ActivityIndicator color="white" /> : <ArrowUp size={18} />}
            </Button>
          </View>
          <View className="mt-2 flex-row justify-between">
            <Text className="text-[9px] text-muted-foreground">MAX 4 BOTS PER ROUND</Text>
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
        <View style={{ backgroundColor: colors.muted,
          borderColor: colors.border,
          borderWidth: 1, maxWidth: '88%', paddingHorizontal: 16, paddingVertical: 12 }}>
          <Text style={{ color: colors.foreground, fontSize: 12, lineHeight: 20, flexWrap: 'wrap' }}>{message.content}</Text>
          <Text style={{ color: colors.mutedForeground, marginTop: 8, textAlign: 'right', fontSize: 9 }}>YOU</Text>
        </View>
      </View>
    );
  }
  if (message.senderType === 'system') return <Text className="border-l-2 border-destructive pl-3 text-xs text-muted-foreground">{message.content}</Text>;
  const bot = bots.find((item) => item.id === message.senderId);
  return (
    <View style={{ width: '100%', flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
      <View className="mt-1 size-8 items-center justify-center" style={{ backgroundColor: bot?.color ?? '#737373' }}><Text className="text-xs text-white">{bot?.name[0] ?? '?'}</Text></View>
      <View style={{ flex: 1, minWidth: 0, flexShrink: 1 }}>
        <View className="mb-1 flex-row items-center gap-2"><Text className="text-xs font-medium">{bot?.name ?? 'Removed bot'}</Text><Text className="text-[9px] text-muted-foreground">@{bot?.handle ?? 'unknown'}</Text></View>
        <Text className={`text-xs leading-6 ${message.status === 'failed' ? 'text-destructive' : ''}`} style={{ width: '100%', flexWrap: 'wrap', flexShrink: 1 }}>{message.content}</Text>
      </View>
    </View>
  );
}
