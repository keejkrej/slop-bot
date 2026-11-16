"use client";

import { cloneElement, isValidElement, useEffect, useId, useState } from "react";
import { GithubLogoIcon, PlugsConnectedIcon, PlusIcon, RobotIcon } from "@phosphor-icons/react";
import { DEFAULT_MODEL, type Bot, type ConnectResponse, type Integration } from "@slopbot/contracts";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void };

export function BotDialog({ open, onOpenChange, integrations, onCreated }: DialogProps & { integrations: Integration[]; onCreated: (botId: string) => Promise<void> }) {
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
    try { const result = await api<{ bot: Bot }>("/api/bots", { method: "POST", body: JSON.stringify({ name, handle, persona, model, integrationIds }) }); await onCreated(result.bot.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create bot."); }
    finally { setBusy(false); }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader className="gap-2 pr-8">
          <div className="mb-2 grid size-10 place-items-center bg-muted"><RobotIcon className="size-5" /></div>
          <DialogTitle className="text-base">Create a bot</DialogTitle>
          <DialogDescription className="text-xs leading-5">Give it a point of view. Instructions shape its personality; connectors give it useful tools.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field hint="A short name people will recognize." label="Name"><Input autoFocus className="h-10 text-[13px]" maxLength={40} onChange={(event) => { setName(event.target.value); if (!handleEdited) setHandle(slugify(event.target.value)); }} placeholder="Nova" required value={name} /></Field>
            <Field hint="2–24 lowercase letters, numbers, or underscores; must start with a letter." label="Handle"><Input className="h-10 text-[13px]" maxLength={24} onChange={(event) => { setHandle(event.target.value.toLowerCase()); setHandleEdited(true); }} pattern="[a-z][a-z0-9_]{1,23}" placeholder="nova" required title="Use 2–24 lowercase letters, numbers, or underscores; start with a letter." value={handle} /></Field>
          </div>
          <Field hint="Tell it how to think, what to prioritize, and how it should respond." label="Instructions"><Textarea className="min-h-32 resize-y py-3 text-[13px] leading-6" maxLength={4000} onChange={(event) => setPersona(event.target.value)} placeholder="You are a direct product strategist. Challenge fuzzy thinking and propose concrete next steps…" required value={persona} /></Field>
          <Field hint="An AI Gateway model ID. The default works well for most bots." label="Model"><Input className="h-10 text-[13px]" onChange={(event) => setModel(event.target.value)} required value={model} /></Field>
          {integrations.length > 0 ? (
            <fieldset>
              <legend className="mb-2 text-[11px] font-medium">Connectors</legend>
              <div className="max-h-40 overflow-y-auto border p-1.5">
                {integrations.map((integration) => (
                  <label className="flex cursor-pointer items-center gap-3 px-2.5 py-2.5 text-xs hover:bg-muted" key={integration.id}>
                    <Checkbox checked={integrationIds.includes(integration.id)} onCheckedChange={(checked) => setIntegrationIds((current) => checked ? [...current, integration.id] : current.filter((id) => id !== integration.id))} />
                    <span className="min-w-0 flex-1 truncate">{integration.name}</span>
                    <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><span className={`size-1.5 ${integration.status === "connected" ? "bg-foreground" : "border border-current"}`} />{integration.status === "connected" ? "Ready" : "Sign in needed"}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          {error ? <FormError message={error} /> : null}
          <DialogFooter className="border-t pt-4">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">Cancel</Button>
            <Button disabled={busy} type="submit">{busy ? <Spinner /> : <PlusIcon />} Create bot</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
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

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader className="gap-2 pr-8">
          <div className="mb-2 grid size-10 place-items-center bg-muted"><PlusIcon className="size-5" /></div>
          <DialogTitle className="text-base">Add a connector</DialogTitle>
          <DialogDescription className="text-xs leading-5">Connect a Streamable HTTP MCP server. OAuth discovery and PKCE start automatically when the server requires it.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={submit}>
          <div>
            <p className="mb-2 text-[10px] text-muted-foreground uppercase tracking-[0.12em]">Quick add</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <button className="flex items-center gap-3 border border-border p-3 text-left transition-colors hover:bg-muted" onClick={() => { setName("GitHub"); setUrl("https://api.githubcopilot.com/mcp/"); setDescription("Search repositories, issues, and pull requests."); }} type="button">
                <GithubLogoIcon className="size-5 shrink-0" />
                <span><span className="block text-xs font-medium">GitHub</span><span className="mt-0.5 block text-[10px] text-muted-foreground">Repos, issues, and pull requests</span></span>
              </button>
              <button className="flex items-center gap-3 border border-border p-3 text-left transition-colors hover:bg-muted" onClick={() => { setName("Composio"); setUrl("https://connect.composio.dev/mcp"); setDescription("Use connected apps and toolkits through Composio."); }} type="button">
                <PlugsConnectedIcon className="size-5 shrink-0" />
                <span><span className="block text-xs font-medium">Composio</span><span className="mt-0.5 block text-[10px] text-muted-foreground">Connected apps · OAuth</span></span>
              </button>
            </div>
          </div>
          <Field hint="How this connector appears when you attach it to a bot." label="Name"><Input autoFocus onChange={(event) => setName(event.target.value)} placeholder="GitHub" required value={name} /></Field>
          <Field hint="Use the server's MCP endpoint, not its documentation page." label="Server URL"><Input onChange={(event) => setUrl(event.target.value)} placeholder="https://api.githubcopilot.com/mcp/" required type="url" value={url} /></Field>
          <Field hint="Optional. Tell your bots when this connector is useful." label="Description"><Textarea className="min-h-20" onChange={(event) => setDescription(event.target.value)} placeholder="Search repositories, issues, and pull requests." value={description} /></Field>
          <details className="group border-t pt-4">
            <summary className="flex cursor-pointer list-none items-center justify-between text-[11px] font-medium text-muted-foreground hover:text-foreground"><span>Advanced authentication</span><span aria-hidden="true" className="text-sm transition-transform group-open:rotate-45">+</span></summary>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Field label="Header name"><Input autoComplete="off" onChange={(event) => setHeaderName(event.target.value)} placeholder="x-api-key" value={headerName} /></Field>
              <Field label="Header value"><Input autoComplete="off" onChange={(event) => setHeaderValue(event.target.value)} placeholder="Encrypted on the server" type="password" value={headerValue} /></Field>
            </div>
          </details>
          {error ? <FormError message={error} /> : null}
          <DialogFooter className="border-t pt-4">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">Cancel</Button>
            <Button disabled={busy} type="submit">{busy ? <Spinner /> : <PlusIcon />} Add connector</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const control = isValidElement<{ id?: string; "aria-describedby"?: string }>(children)
    ? cloneElement(children, {
        id: children.props.id ?? id,
        "aria-describedby": hint ? [children.props["aria-describedby"], hintId].filter(Boolean).join(" ") : children.props["aria-describedby"],
      })
    : children;
  return (
    <div className="grid gap-1.5">
      <label className="text-[11px] font-medium" htmlFor={id}>{label}</label>
      {control}
      {hint ? <span className="text-[10px] text-muted-foreground leading-4" id={hintId}>{hint}</span> : null}
    </div>
  );
}
function FormError({ message }: { message: string }) { return <p className="border-l-2 border-destructive pl-3 text-destructive text-xs" role="alert">{message}</p>; }
function slugify(value: string): string {
  const slug = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
  if (!/^[a-z]/.test(slug)) return `bot_${slug}`.replace(/_+$/g, "").slice(0, 24);
  return slug.length >= 2 ? slug : "bot";
}
