import React, { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Cable, Plus, ShieldCheck, Trash } from 'lucide-react-native';
import type { ConnectResponse, Integration } from '@slopbot/contracts';
import { api } from '@/src/lib/api';
import { useApp } from '@/src/lib/app-state';
import { Screen, ScreenTitle } from '@/src/components/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { Textarea } from '@/components/ui/textarea';

export default function ConnectionsScreen() {
  const { data, refresh } = useApp();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string>();
  if (!data) return null;

  async function connect(integration: Integration) {
    setNotice(undefined);
    try {
      const result = await api<ConnectResponse>(`/api/integrations/${integration.id}/connect`, { method: 'POST', body: JSON.stringify({ platform: 'android' }) });
      if (result.authorizationUrl) {
        const auth = await WebBrowser.openAuthSessionAsync(result.authorizationUrl, 'slopbot://integrations');
        if (auth.type === 'success') setNotice('Authorization complete.');
      } else {
        setNotice(result.integration.status === 'connected' ? `${integration.name} is connected.` : result.integration.lastError ?? 'Connection needs attention.');
      }
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not connect.');
    }
  }

  function remove(integration: Integration) {
    Alert.alert('Remove connection?', `${integration.name} will no longer be available to bots.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => { void api(`/api/integrations/${integration.id}`, { method: 'DELETE' }).then(refresh); } },
    ]);
  }

  return (
    <Screen>
      <ScreenTitle
        eyebrow="TOOL SHED"
        title="Connections."
        description="Bring remote MCP tools into any bot."
        action={<Button accessibilityLabel="Add connection" size="icon" variant="outline" onPress={() => setAdding(true)}><Plus size={20} /></Button>}
      />

      {notice ? <Text className="mb-4 border-l-2 border-foreground bg-muted px-4 py-3 text-xs leading-5">{notice}</Text> : null}

      <View className="mb-5 flex-row items-start border border-border p-4" style={{ gap: 12 }}>
        <ShieldCheck className="mt-0.5 text-muted-foreground" size={17} />
        <Text className="flex-1 text-xs leading-5 text-muted-foreground">
          Only read-only MCP tools are exposed in this MVP. Write actions stay blocked.
        </Text>
      </View>

      <View style={{ gap: 12 }}>
        {data.integrations.map((integration) => {
          const connected = integration.status === 'connected';
          const hasError = integration.status === 'error';

          return (
            <Card key={integration.id}>
              <CardHeader>
                <View className="flex-row items-center" style={{ gap: 12 }}>
                  <View className="h-10 w-10 items-center justify-center bg-muted">
                    <Cable size={18} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <CardTitle numberOfLines={1}>{integration.name}</CardTitle>
                    <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={1}>{new URL(integration.url).host}</Text>
                  </View>
                  <Badge variant={connected ? 'default' : hasError ? 'destructive' : 'secondary'}>
                    <Text>{connected ? 'CONNECTED' : hasError ? 'ERROR' : 'NEEDS LOGIN'}</Text>
                  </Badge>
                </View>
              </CardHeader>
              <CardContent>
                <Text className="text-xs leading-5 text-muted-foreground">{integration.description}</Text>
                {integration.lastError ? <Text className="mt-3 text-xs leading-5 text-destructive">{integration.lastError}</Text> : null}
                <View className="mt-4 flex-row items-center justify-between gap-3">
                  <Button size="sm" onPress={() => void connect(integration)} variant="outline">
                    <Text>{connected ? 'Refresh' : 'Connect'}</Text>
                  </Button>
                  <View className="flex-row items-center gap-2">
                    <Text className="text-xs text-muted-foreground">{integration.toolCount} tools</Text>
                    <Button accessibilityLabel={`Remove ${integration.name}`} onPress={() => remove(integration)} size="icon" variant="ghost">
                      <Trash size={16} />
                    </Button>
                  </View>
                </View>
              </CardContent>
            </Card>
          );
        })}
      </View>

      {data.integrations.length === 0 ? (
        <View className="items-center rounded-none border border-dashed border-border px-6 py-14">
          <Cable className="mb-4 text-muted-foreground" size={30} />
          <Text className="text-base font-medium">No tools connected</Text>
          <Text className="mt-2 text-center text-xs leading-5 text-muted-foreground">
            Add an MCP connection to give your bots more context.
          </Text>
          <Button className="mt-6" onPress={() => setAdding(true)} variant="outline"><Text>Add connection</Text></Button>
        </View>
      ) : null}

      <ConnectionDialog onOpenChange={setAdding} open={adding} onNotice={setNotice} />
    </Screen>
  );
}

function ConnectionDialog({ open, onOpenChange, onNotice }: { open: boolean; onOpenChange: (open: boolean) => void; onNotice: (message?: string) => void }) {
  const { refresh } = useApp();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [headerName, setHeaderName] = useState('');
  const [headerValue, setHeaderValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api<ConnectResponse>('/api/integrations', { method: 'POST', body: JSON.stringify({ kind: 'mcp', name, url, description, headerName: headerName || undefined, headerValue: headerValue || undefined, platform: 'android' }) });
      onOpenChange(false);
      await refresh();
      if (result.authorizationUrl) {
        const auth = await WebBrowser.openAuthSessionAsync(result.authorizationUrl, 'slopbot://integrations');
        onNotice(auth.type === 'success' ? 'Authorization complete.' : 'Authorization was cancelled.');
        await refresh();
      } else {
        onNotice(result.integration.status === 'connected' ? 'Connection added.' : result.integration.lastError ?? 'Connection added with an error.');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add connection.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90%]">
        <DialogHeader>
          <DialogTitle>Add custom MCP</DialogTitle>
          <DialogDescription>{"OAuth opens the provider's website and returns to Slop Bot. Optional headers are encrypted on the server."}</DialogDescription>
        </DialogHeader>
        <ScrollView keyboardShouldPersistTaps="handled">
          <View className="gap-4">
            <Field label="Display name"><Input onChangeText={setName} placeholder="GitHub, Composio, or your own server" value={name} /></Field>
            <Field label="MCP endpoint URL"><Input autoCapitalize="none" onChangeText={setUrl} placeholder="https://api.githubcopilot.com/mcp/" value={url} /></Field>
            <Field label="Description"><Textarea onChangeText={setDescription} placeholder="What can bots do with this?" value={description} /></Field>
            <Field label="Header name (optional)"><Input autoCapitalize="none" onChangeText={setHeaderName} placeholder="x-api-key" value={headerName} /></Field>
            <Field label="Header value (optional)"><Input autoCapitalize="none" onChangeText={setHeaderValue} placeholder="Encrypted on the server" secureTextEntry value={headerValue} /></Field>
            {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
            <Button disabled={busy || !name || !url} onPress={() => void submit()}>
              <Text>{busy ? 'Connecting…' : 'Add & test'}</Text>
            </Button>
          </View>
        </ScrollView>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="text-xs font-medium text-muted-foreground">{label}</Text>
      {children}
    </View>
  );
}
