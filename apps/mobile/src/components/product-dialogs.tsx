import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { DEFAULT_MODEL, type Integration } from '@slopbot/contracts';
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
  async function submit() {
    setBusy(true); setError(undefined);
    try { await api('/api/bots', { method: 'POST', body: JSON.stringify({ name, handle, persona, model, integrationIds }) }); onOpenChange(false); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create bot.'); } finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90%]"><DialogHeader><DialogTitle>CREATE A BOT</DialogTitle><DialogDescription>A distinct point of view, model, and set of tools.</DialogDescription></DialogHeader><ScrollView keyboardShouldPersistTaps="handled"><View className="gap-4"><Field label="NAME"><Input onChangeText={(value) => { setName(value); setHandle(slugify(value)); }} placeholder="Nova" value={name} /></Field><Field label="HANDLE"><Input autoCapitalize="none" onChangeText={setHandle} placeholder="nova" value={handle} /></Field><Field label="PERSONALITY / INSTRUCTIONS"><Textarea className="min-h-28" onChangeText={setPersona} placeholder="Direct, curious, and concrete…" value={persona} /></Field><Field label="AI GATEWAY MODEL"><Input autoCapitalize="none" onChangeText={setModel} value={model} /></Field>{integrations.map((integration) => <View className="flex-row items-center" style={{ gap: 12 }} key={integration.id}><Checkbox checked={integrationIds.includes(integration.id)} onCheckedChange={(checked) => setIntegrationIds((current) => checked ? [...current, integration.id] : current.filter((id) => id !== integration.id))} /><Text className="flex-1 text-xs">{integration.name}</Text></View>)}{error ? <Text className="text-xs text-destructive">{error}</Text> : null}<Button disabled={busy} variant="outline" onPress={() => void submit()}><Text>{busy ? 'Creating…' : 'Create bot'}</Text></Button></View></ScrollView></DialogContent></Dialog>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <View className="gap-2"><Text className="text-[10px] text-muted-foreground">{label}</Text>{children}</View>;
}
function slugify(value: string) { return value.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '').slice(0, 24); }
