import React, { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { DEFAULT_MODEL, type Bot, type Conversation, type Integration } from '@slopbot/contracts';
import { api } from '@/src/lib/api';
import { useApp } from '@/src/lib/app-state';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { Textarea } from '@/components/ui/textarea';

export function BotDialog({ open, onOpenChange, integrations }: { open: boolean; onOpenChange: (open: boolean) => void; integrations: Integration[] }) {
  const { refresh } = useApp();
  const [name, setName] = useState(''); const [handle, setHandle] = useState('');
  const [persona, setPersona] = useState(''); const [model, setModel] = useState(DEFAULT_MODEL);
  const [integrationIds, setIntegrationIds] = useState<string[]>([]); const [error, setError] = useState<string>(); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(''); setHandle(''); setPersona(''); setModel(DEFAULT_MODEL); setIntegrationIds([]); setError(undefined); } }, [open]);
  async function submit() {
    setBusy(true); setError(undefined);
    try { await api('/api/bots', { method: 'POST', body: JSON.stringify({ name, handle, persona, model, integrationIds }) }); onOpenChange(false); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create bot.'); } finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90%]"><DialogHeader><DialogTitle>CREATE A BOT</DialogTitle><DialogDescription>A distinct point of view, model, and set of tools.</DialogDescription></DialogHeader><ScrollView keyboardShouldPersistTaps="handled"><View className="gap-4"><Field label="NAME"><Input onChangeText={(value) => { setName(value); setHandle(slugify(value)); }} placeholder="Nova" value={name} /></Field><Field label="HANDLE"><Input autoCapitalize="none" onChangeText={setHandle} placeholder="nova" value={handle} /></Field><Field label="PERSONALITY / INSTRUCTIONS"><Textarea className="min-h-28" onChangeText={setPersona} placeholder="Direct, curious, and concrete…" value={persona} /></Field><Field label="AI GATEWAY MODEL"><Input autoCapitalize="none" onChangeText={setModel} value={model} /></Field>{integrations.map((integration) => <View className="flex-row items-center gap-3" key={integration.id}><Checkbox checked={integrationIds.includes(integration.id)} onCheckedChange={(checked) => setIntegrationIds((current) => checked ? [...current, integration.id] : current.filter((id) => id !== integration.id))} /><Text className="flex-1 text-xs">{integration.name}</Text></View>)}{error ? <Text className="text-xs text-destructive">{error}</Text> : null}<Button disabled={busy} onPress={() => void submit()}><Text>{busy ? 'Creating…' : 'Create bot'}</Text></Button></View></ScrollView></DialogContent></Dialog>;
}

export function ConversationDialog({ open, onOpenChange, bots }: { open: boolean; onOpenChange: (open: boolean) => void; bots: Bot[] }) {
  const { refresh } = useApp();
  const [title, setTitle] = useState(''); const [botIds, setBotIds] = useState<string[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  useEffect(() => { if (open) { setTitle(''); setBotIds([]); setError(undefined); } }, [open]);
  async function submit() {
    setBusy(true); setError(undefined);
    try { const result = await api<{ conversation: Conversation }>('/api/conversations', { method: 'POST', body: JSON.stringify({ title, botIds }) }); onOpenChange(false); await refresh(); router.push({ pathname: '/conversation/[id]', params: { id: result.conversation.id } }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create room.'); } finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>NEW BOT ROOM</DialogTitle><DialogDescription>Up to four bots. Each answers once per round.</DialogDescription></DialogHeader><Field label="ROOM NAME"><Input onChangeText={setTitle} placeholder="Weekend project council" value={title} /></Field><View className="max-h-64 gap-1">{bots.map((bot) => { const checked = botIds.includes(bot.id); const disabled = !checked && botIds.length >= 4; return <View className="flex-row items-center gap-3 py-2" key={bot.id}><Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => setBotIds((current) => value ? [...current, bot.id] : current.filter((id) => id !== bot.id))} /><View className="size-6 items-center justify-center" style={{ backgroundColor: bot.color }}><Text className="text-[10px] text-white">{bot.name[0]}</Text></View><Text className="flex-1 text-xs">{bot.name}</Text></View>; })}</View>{bots.length === 0 ? <Text className="text-xs text-muted-foreground">Create a bot first.</Text> : null}{error ? <Text className="text-xs text-destructive">{error}</Text> : null}<Button disabled={busy || botIds.length === 0} onPress={() => void submit()}><Text>{busy ? 'Creating…' : 'Create room'}</Text></Button></DialogContent></Dialog>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <View className="gap-2"><Text className="text-[10px] text-muted-foreground">{label}</Text>{children}</View>;
}
function slugify(value: string) { return value.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '').slice(0, 24); }
