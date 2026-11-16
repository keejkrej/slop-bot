"use client";

import { useEffect, useState } from "react";
import { ArrowSquareOutIcon, GithubLogoIcon, LockSimpleIcon, PlugsConnectedIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { ConnectResponse, Integration, IntegrationToolsResponse } from "@slopbot/contracts";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export function ConnectionsView({ integrations, onAdd, onRefresh }: { integrations: Integration[]; onAdd: () => void; onRefresh: () => Promise<void> }) {
  const [notice, setNotice] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [confirmId, setConfirmId] = useState<string>();
  const [policyId, setPolicyId] = useState<string>();
  const [policy, setPolicy] = useState<IntegrationToolsResponse>();
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyError, setPolicyError] = useState<string>();
  const [draftAllowed, setDraftAllowed] = useState<string[]>([]);

  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get("status");
    if (status) setNotice(status === "connected" ? "Connector authorized. Its read-only tools are ready." : `OAuth returned with status: ${status}. Try reconnecting if needed.`);
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
    setBusyId(integration.id);
    try { await api(`/api/integrations/${integration.id}`, { method: "DELETE" }); setConfirmId(undefined); await onRefresh(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not remove connector."); }
    finally { setBusyId(undefined); }
  }

  async function desktopSetup() {
    try {
      const pairing = await api<{ token: string }>("/api/desktop/pairing");
      await navigator.clipboard.writeText(pairing.token);
      setNotice("Desktop pairing token copied. Paste it into Slop Bot Desktop → Pairing. Never share it publicly.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Desktop pairing isn't configured."); }
  }

  async function openPolicy(integration: Integration) {
    if (policyId === integration.id) { setPolicyId(undefined); return; }
    setPolicyId(integration.id);
    setPolicy(undefined);
    setPolicyError(undefined);
    setPolicyBusy(true);
    try {
      const result = await api<IntegrationToolsResponse>(`/api/integrations/${integration.id}/policy`);
      setPolicy(result);
      setDraftAllowed(result.tools.filter((tool) => tool.allowed && tool.risk !== "read").map((tool) => tool.name));
    } catch (error) {
      setPolicyError(error instanceof Error ? error.message : "Could not load tool permissions.");
    } finally { setPolicyBusy(false); }
  }

  async function savePolicy(integration: Integration) {
    setPolicyBusy(true);
    setPolicyError(undefined);
    try {
      const result = await api<IntegrationToolsResponse>(`/api/integrations/${integration.id}/policy`, {
        method: "PATCH",
        body: JSON.stringify({ allowedWriteTools: draftAllowed }),
      });
      setPolicy(result);
      setNotice(`Saved ${draftAllowed.length} explicit write tool${draftAllowed.length === 1 ? "" : "s"} for ${integration.name}.`);
      await onRefresh();
    } catch (error) {
      setPolicyError(error instanceof Error ? error.message : "Could not save tool permissions.");
    } finally { setPolicyBusy(false); }
  }

  function toggleAllowed(name: string) {
    setDraftAllowed((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name]);
  }

  return (
    <main className="mx-auto max-w-4xl px-5 py-8 sm:px-8 lg:py-10">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4 pr-10">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl tracking-[-0.05em]">Connectors</h1>
          <p className="mt-1.5 max-w-xl text-[13px] text-muted-foreground leading-6">Connect MCP tools. OAuth and credentials stay on the server.</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 self-start">
          <Button onClick={() => void desktopSetup()} variant="ghost">Desktop setup</Button>
          <Button onClick={onAdd}><PlusIcon /> Add connector</Button>
        </div>
      </header>

      {notice ? <p className="mb-5 border-l-2 border-foreground bg-muted px-4 py-3 text-xs leading-5" role="status">{notice}</p> : null}

      <div className="mb-6 flex items-start gap-3 bg-muted/30 p-4 text-muted-foreground text-xs leading-5">
        <LockSimpleIcon className="mt-0.5 size-4 shrink-0 text-foreground" />
        <p><span className="font-medium text-foreground">Read-only by default.</span> Read tools are always available. Write tools stay blocked unless you grant each one explicitly on its connection; there is no blanket write toggle.</p>
      </div>

      {integrations.length === 0 ? (
        <div className="grid min-h-64 place-items-center bg-muted/20">
          <div className="max-w-sm px-6 text-center">
            <div className="mx-auto mb-4 grid size-11 place-items-center bg-muted"><PlugsConnectedIcon className="size-5" /></div>
            <p className="text-sm font-medium">No connectors yet</p>
            <p className="mt-2 text-muted-foreground text-xs leading-5">Start with GitHub, a custom MCP server, or a Composio hosted endpoint.</p>
            <Button className="mt-5" onClick={onAdd}><PlusIcon /> Add your first connector</Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {integrations.map((integration) => (
            <section className="flex flex-col bg-muted/30 p-5" key={integration.id}>
              <div className="flex items-start gap-3">
                <div className="grid size-10 shrink-0 place-items-center bg-muted">{integration.kind === "github" ? <GithubLogoIcon className="size-5" /> : <PlugsConnectedIcon className="size-5" />}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><h2 className="truncate text-[13px] font-medium">{integration.name}</h2><Status status={integration.status} /></div>
                  <p className="mt-1 truncate text-[10px] text-muted-foreground">{new URL(integration.url).host}</p>
                </div>
              </div>
              <p className="mt-4 min-h-10 text-muted-foreground text-xs leading-5">{integration.description}</p>
              {integration.lastError ? <p className="mt-3 text-destructive text-xs leading-5" role="alert">{integration.lastError}</p> : null}
              <div className="mt-4 flex items-center gap-3 pt-1">
                <Button disabled={busyId === integration.id} onClick={() => void reconnect(integration)} size="sm">
                  {busyId === integration.id ? <Spinner /> : null}{integration.status === "connected" ? "Refresh tools" : "Connect"}{busyId === integration.id ? null : <ArrowSquareOutIcon />}
                </Button>
                <Button disabled={integration.status !== "connected"} onClick={() => void openPolicy(integration)} size="sm" variant="ghost">Permissions</Button>
                <span className="text-[10px] text-muted-foreground">{integration.toolCount} tools</span>
                {confirmId === integration.id ? (
                  <div className="ml-auto flex items-center gap-1">
                    <Button onClick={() => setConfirmId(undefined)} size="sm" variant="ghost">Cancel</Button>
                    <Button disabled={busyId === integration.id} onClick={() => void remove(integration)} size="sm" variant="destructive">Remove</Button>
                  </div>
                ) : (
                  <Button aria-label={`Remove ${integration.name}`} className="ml-auto" onClick={() => setConfirmId(integration.id)} size="icon-sm" variant="ghost"><TrashIcon /></Button>
                )}
              </div>
              {policyId === integration.id ? (
                <div className="mt-4 border-t border-border/70 pt-4">
                  <p className="text-[11px] font-medium uppercase tracking-[0.12em]">Tool permissions</p>
                  {policyBusy && !policy ? <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Spinner /> Loading tools…</div> : null}
                  {policyError ? <p className="mt-3 text-destructive text-xs leading-5" role="alert">{policyError}</p> : null}
                  {policy && !policy.listingAvailable ? (
                    <p className="mt-3 text-muted-foreground text-xs leading-5">The provider's tool list is unavailable, so no tools are marked permitted. Reconnect and try again.</p>
                  ) : null}
                  {policy?.listingAvailable ? (
                    <>
                      <p className="mt-2 text-muted-foreground text-[11px] leading-5">Read tools are always allowed. Grant write tools individually.</p>
                      <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto">
                        {policy.tools.map((tool) => (
                          <li className="flex items-start gap-2 bg-background/60 px-2 py-1.5" key={tool.name}>
                            {tool.risk === "read" ? (
                              <span className="mt-0.5 size-3 shrink-0 border border-current/30" aria-hidden="true" />
                            ) : (
                              <input
                                aria-label={`Allow ${tool.name}`}
                                checked={draftAllowed.includes(tool.name)}
                                className="mt-0.5 size-3 shrink-0"
                                disabled={policyBusy}
                                onChange={() => toggleAllowed(tool.name)}
                                type="checkbox"
                              />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[11px] font-medium">{tool.name}</span>
                              <span className="block truncate text-[10px] text-muted-foreground">{tool.description}</span>
                            </span>
                            <span className={`shrink-0 text-[9px] uppercase tracking-[0.08em] ${tool.risk === "destructive" ? "text-destructive" : "text-muted-foreground"}`}>{tool.risk}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="mt-3 flex items-center gap-2">
                        <Button disabled={policyBusy} onClick={() => void savePolicy(integration)} size="sm">Save permissions</Button>
                        <span className="text-[10px] text-muted-foreground">{draftAllowed.length} write tool{draftAllowed.length === 1 ? "" : "s"} allowed</span>
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function Status({ status }: { status: Integration["status"] }) {
  return <span className="flex shrink-0 items-center gap-1.5 text-[9px] text-muted-foreground uppercase tracking-[0.08em]"><span className={`size-1.5 ${status === "connected" ? "bg-foreground" : status === "error" ? "bg-destructive" : "border border-current"}`} />{status === "connected" ? "Ready" : status === "error" ? "Error" : "Sign in"}</span>;
}
