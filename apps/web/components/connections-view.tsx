"use client";

import { useEffect, useState } from "react";
import { ArrowSquareOutIcon, GithubLogoIcon, PlugsConnectedIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { ConnectResponse, Integration } from "@slopbot/contracts";
import { api } from "@/lib/client/api";
import { PageHeader } from "./bots-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ConnectionsView({ integrations, onAdd, onRefresh }: { integrations: Integration[]; onAdd: () => void; onRefresh: () => Promise<void> }) {
  const [notice, setNotice] = useState<string>();
  const [busyId, setBusyId] = useState<string>();

  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get("status");
    if (status) setNotice(status === "connected" ? "Connection authorized. Its read-only tools are ready." : `OAuth returned with status: ${status}. Try reconnecting if needed.`);
  }, []);

  async function reconnect(integration: Integration) {
    setBusyId(integration.id);
    setNotice(undefined);
    try {
      const result = await api<ConnectResponse>(`/api/integrations/${integration.id}/connect`, { method: "POST", body: JSON.stringify({ platform: "web" }) });
      if (result.authorizationUrl) window.location.assign(result.authorizationUrl);
      else { await onRefresh(); setNotice(result.integration.status === "connected" ? `${result.integration.name} is connected.` : result.integration.lastError ?? undefined); }
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not connect."); }
    finally { setBusyId(undefined); }
  }

  async function remove(integration: Integration) {
    if (!window.confirm(`Remove ${integration.name}? Bots will no longer see its tools.`)) return;
    setBusyId(integration.id);
    try { await api(`/api/integrations/${integration.id}`, { method: "DELETE" }); await onRefresh(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not remove connection."); }
    finally { setBusyId(undefined); }
  }

  async function desktopSetup() {
    try {
      const pairing = await api<{ token: string }>("/api/desktop/pairing");
      await navigator.clipboard.writeText(pairing.token);
      setNotice("Desktop pairing token copied. Paste it into Slop Bot Desktop → Pairing. Never share it publicly.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Desktop pairing isn't configured."); }
  }

  return <main className="mx-auto max-w-6xl p-5 py-8 sm:p-8 lg:py-12">
    <PageHeader eyebrow="TOOL SHED" title="Connections." description="Bring remote MCP tools into any bot. OAuth happens on the provider's site and tokens stay encrypted on the server." action={<div className="flex flex-wrap gap-2"><Button onClick={() => void desktopSetup()} variant="outline">Desktop setup</Button><Button onClick={onAdd} variant="outline"><PlusIcon /> Add connection</Button></div>} />
    {notice ? <p className="mb-5 border-l-2 border-foreground bg-muted px-4 py-3 text-xs" role="status">{notice}</p> : null}
    <div className="mb-5 flex items-start gap-3 border p-4 text-muted-foreground text-xs leading-relaxed"><span className="mt-0.5 text-foreground">READ ONLY</span><p>Only MCP tools explicitly annotated as read-only are exposed in this MVP. Write tools stay blocked until the durable per-call approval screen ships.</p></div>
    {integrations.length === 0 ? <div className="grid min-h-72 place-items-center border border-dashed"><div className="max-w-xs text-center"><PlugsConnectedIcon className="mx-auto mb-4 size-7 text-muted-foreground" /><p className="text-sm">No tools connected.</p><p className="mt-2 text-muted-foreground text-xs leading-relaxed">Start with GitHub, a custom MCP URL, or a Composio hosted session.</p><Button className="mt-5" onClick={onAdd} variant="outline">Add a connection</Button></div></div> : <div className="space-y-3">{integrations.map((integration) => <Card key={integration.id} size="sm">
      <CardHeader><div className="flex items-start gap-3"><div className="grid size-9 shrink-0 place-items-center bg-muted">{integration.kind === "github" ? <GithubLogoIcon /> : <PlugsConnectedIcon />}</div><div className="min-w-0"><CardTitle>{integration.name}</CardTitle><CardDescription className="mt-1 break-all">{new URL(integration.url).host}</CardDescription></div></div><div className="ml-auto"><StatusBadge status={integration.status} /></div></CardHeader>
      <CardContent><p className="text-muted-foreground text-xs leading-relaxed">{integration.description}</p>{integration.lastError ? <p className="mt-3 text-destructive text-xs" role="alert">{integration.lastError}</p> : null}<div className="mt-4 flex flex-wrap items-center gap-2"><Button disabled={busyId === integration.id} onClick={() => void reconnect(integration)} size="sm" variant="outline">{integration.status === "connected" ? "Refresh tools" : "Connect"}<ArrowSquareOutIcon /></Button><span className="text-[10px] text-muted-foreground">{integration.toolCount} tools discovered</span><Button aria-label={`Remove ${integration.name}`} className="ml-auto" disabled={busyId === integration.id} onClick={() => void remove(integration)} size="icon-sm" variant="ghost"><TrashIcon /></Button></div></CardContent>
    </Card>)}</div>}
  </main>;
}

function StatusBadge({ status }: { status: Integration["status"] }) {
  return <Badge variant={status === "connected" ? "default" : status === "error" ? "destructive" : "secondary"}>{status === "connected" ? "CONNECTED" : status === "error" ? "ERROR" : "NEEDS LOGIN"}</Badge>;
}
