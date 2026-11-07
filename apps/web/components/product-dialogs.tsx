"use client";

import { useEffect, useState } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import { DEFAULT_MODEL, type Bot, type ConnectResponse, type Conversation, type Integration } from "@slopbot/contracts";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void };

export function BotDialog({ open, onOpenChange, integrations, onCreated }: DialogProps & { integrations: Integration[]; onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleEdited, setHandleEdited] = useState(false);
  const [persona, setPersona] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [integrationIds, setIntegrationIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => { if (open) { setName(""); setHandle(""); setHandleEdited(false); setPersona(""); setModel(DEFAULT_MODEL); setIntegrationIds([]); setError(undefined); } }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined);
    try { await api("/api/bots", { method: "POST", body: JSON.stringify({ name, handle, persona, model, integrationIds }) }); await onCreated(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create bot."); }
    finally { setBusy(false); }
  }

  return <Dialog onOpenChange={onOpenChange} open={open}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>CREATE A BOT</DialogTitle><DialogDescription>Give it a point of view. Personality comes from instructions, not a hidden template.</DialogDescription></DialogHeader><form className="grid gap-4" onSubmit={submit}>
    <div className="grid grid-cols-2 gap-3"><Field label="NAME"><Input autoFocus maxLength={40} onChange={(event) => { setName(event.target.value); if (!handleEdited) setHandle(slugify(event.target.value)); }} placeholder="Nova" required value={name} /></Field><Field label="HANDLE"><Input maxLength={24} onChange={(event) => { setHandle(event.target.value.toLowerCase()); setHandleEdited(true); }} pattern="[a-z][a-z0-9_]{1,23}" placeholder="nova" required value={handle} /></Field></div>
    <Field label="PERSONALITY / INSTRUCTIONS"><Textarea className="min-h-28" maxLength={4000} onChange={(event) => setPersona(event.target.value)} placeholder="You are a direct product strategist. Challenge fuzzy thinking and propose concrete next steps…" required value={persona} /></Field>
    <Field label="AI GATEWAY MODEL"><Input onChange={(event) => setModel(event.target.value)} required value={model} /></Field>
    {integrations.length > 0 ? <fieldset><legend className="mb-2 text-[10px] text-muted-foreground">AVAILABLE CONNECTIONS</legend><div className="max-h-32 space-y-2 overflow-y-auto border p-3">{integrations.map((integration) => <label className="flex cursor-pointer items-center gap-2 text-xs" key={integration.id}><Checkbox checked={integrationIds.includes(integration.id)} onCheckedChange={(checked) => setIntegrationIds((current) => checked ? [...current, integration.id] : current.filter((id) => id !== integration.id))} /><span>{integration.name}</span><span className="ml-auto text-[9px] text-muted-foreground">{integration.status === "connected" ? "READY" : "LOGIN NEEDED"}</span></label>)}</div></fieldset> : null}
    {error ? <FormError message={error} /> : null}<DialogFooter><Button disabled={busy} type="submit" variant="outline">{busy ? <Spinner /> : <PlusIcon />} Create bot</Button></DialogFooter>
  </form></DialogContent></Dialog>;
}

export function ConversationDialog({ open, onOpenChange, bots, onCreated }: DialogProps & { bots: Bot[]; onCreated: (id: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [botIds, setBotIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { if (open) { setTitle(""); setBotIds(bots.length === 1 && bots[0] ? [bots[0].id] : []); setError(undefined); } }, [open, bots]);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined);
    try { const result = await api<{ conversation: Conversation }>("/api/conversations", { method: "POST", body: JSON.stringify({ title, botIds }) }); await onCreated(result.conversation.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create group."); }
    finally { setBusy(false); }
  }

  return <Dialog onOpenChange={onOpenChange} open={open}><DialogContent><DialogHeader><DialogTitle>NEW BOT ROOM</DialogTitle><DialogDescription>Choose up to four bots. Each responds once per round and can read earlier replies.</DialogDescription></DialogHeader><form className="grid gap-4" onSubmit={submit}><Field label="ROOM NAME"><Input autoFocus maxLength={80} onChange={(event) => setTitle(event.target.value)} placeholder="Weekend project council" required value={title} /></Field><fieldset><legend className="mb-2 text-[10px] text-muted-foreground">PARTICIPANTS</legend>{bots.length === 0 ? <p className="border border-dashed p-4 text-muted-foreground text-xs">Create a bot first, then come back here.</p> : <div className="max-h-56 space-y-1 overflow-y-auto border p-2">{bots.map((bot) => { const checked = botIds.includes(bot.id); const disabled = !checked && botIds.length >= 4; return <label className={`flex items-center gap-3 p-2 text-xs ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-muted"}`} key={bot.id}><Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => setBotIds((current) => value ? [...current, bot.id] : current.filter((id) => id !== bot.id))} /><span className="grid size-6 place-items-center text-white text-[10px]" style={{ backgroundColor: bot.color }}>{bot.name[0]}</span><span>{bot.name}</span><span className="ml-auto text-muted-foreground">@{bot.handle}</span></label>; })}</div>}</fieldset>{error ? <FormError message={error} /> : null}<DialogFooter><Button disabled={busy || botIds.length === 0} type="submit" variant="outline">{busy ? <Spinner /> : <PlusIcon />} Create room</Button></DialogFooter></form></DialogContent></Dialog>;
}

export function ConnectionDialog({ open, onOpenChange, onCreated }: DialogProps & { onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { if (open) { setName(""); setUrl(""); setDescription(""); setHeaderName(""); setHeaderValue(""); setError(undefined); } }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined);
    try {
      const result = await api<ConnectResponse>("/api/integrations", { method: "POST", body: JSON.stringify({ kind: "mcp", name, url, description, headerName: headerName || undefined, headerValue: headerValue || undefined, platform: "web" }) });
      if (result.authorizationUrl) { window.location.assign(result.authorizationUrl); return; }
      await onCreated();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add connection."); }
    finally { setBusy(false); }
  }

  return <Dialog onOpenChange={onOpenChange} open={open}><DialogContent><DialogHeader><DialogTitle>ADD CUSTOM MCP</DialogTitle><DialogDescription>Connect any Streamable HTTP MCP server. OAuth discovery and PKCE start automatically when required.</DialogDescription></DialogHeader><form className="grid gap-4" onSubmit={submit}>
    <Field label="DISPLAY NAME"><Input autoFocus onChange={(event) => setName(event.target.value)} placeholder="GitHub, Composio, or your own server" required value={name} /></Field>
    <Field label="STREAMABLE HTTP / SSE URL"><Input onChange={(event) => setUrl(event.target.value)} placeholder="https://api.githubcopilot.com/mcp/" required type="url" value={url} /></Field>
    <Field label="MODEL-FACING DESCRIPTION"><Textarea className="min-h-20" onChange={(event) => setDescription(event.target.value)} placeholder="What can this connection help your bots do?" value={description} /></Field>
    <div className="grid grid-cols-2 gap-3"><Field label="HEADER NAME (OPTIONAL)"><Input autoComplete="off" onChange={(event) => setHeaderName(event.target.value)} placeholder="x-api-key" value={headerName} /></Field><Field label="HEADER VALUE (OPTIONAL)"><Input autoComplete="off" onChange={(event) => setHeaderValue(event.target.value)} placeholder="Encrypted on the server" type="password" value={headerValue} /></Field></div>
    {error ? <FormError message={error} /> : null}<DialogFooter><Button disabled={busy} type="submit" variant="outline">{busy ? <Spinner /> : <PlusIcon />} Add & test</Button></DialogFooter>
  </form></DialogContent></Dialog>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-2 text-[10px] text-muted-foreground"><span>{label}</span>{children}</label>;
}
function FormError({ message }: { message: string }) { return <p className="border-l-2 border-destructive pl-3 text-destructive text-xs" role="alert">{message}</p>; }
function slugify(value: string): string { return value.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+/, "").slice(0, 24); }
