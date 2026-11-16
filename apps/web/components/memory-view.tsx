"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DownloadSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import type { Bot, Conversation, MemoryDirectoryEntry, MemoryInstructions } from "@slopbot/contracts";
import {
  exportMemory,
  forgetMemory,
  getMemory,
  getMemoryFile,
  saveMemoryInstructions,
} from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

export function MemoryView({ bots, conversations }: { bots: Bot[]; conversations: Conversation[] }) {
  const [botId, setBotId] = useState("");
  const [files, setFiles] = useState<MemoryDirectoryEntry[]>([]);
  const [instructions, setInstructions] = useState<MemoryInstructions | null>(null);
  const [draft, setDraft] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [selectedContent, setSelectedContent] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmPath, setConfirmPath] = useState<string>();

  const conversation = useMemo(
    () => conversations.find((item) => item.botIds.includes(botId)),
    [conversations, botId],
  );

  useEffect(() => {
    setBotId((current) => (current && bots.some((bot) => bot.id === current) ? current : bots[0]?.id ?? ""));
  }, [bots]);

  const load = useCallback(async () => {
    if (!conversation || !botId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await getMemory(conversation.id, botId);
      setFiles(result.files);
      setInstructions(result.instructions);
      setDraft(result.instructions?.content ?? "");
      setSelectedPath(undefined);
      setSelectedContent(undefined);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load memory.");
    } finally {
      setLoading(false);
    }
  }, [botId, conversation]);

  useEffect(() => { void load(); }, [load]);

  async function saveInstructions() {
    if (!conversation) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await saveMemoryInstructions(draft, instructions?.version ?? null);
      setInstructions(result.instructions);
      setDraft(result.instructions.content);
      setNotice("Instructions saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save instructions.");
    } finally {
      setBusy(false);
    }
  }

  async function openFile(path: string) {
    if (!conversation) return;
    setSelectedPath(path);
    setSelectedContent(undefined);
    try {
      const result = await getMemoryFile(conversation.id, botId, path);
      setSelectedContent(result.file?.content ?? "(file not found)");
    } catch (cause) {
      setSelectedContent(cause instanceof Error ? cause.message : "Could not read the file.");
    }
  }

  async function downloadExport() {
    if (!conversation) return;
    setBusy(true);
    setError(undefined);
    try {
      const snapshot = await exportMemory(conversation.id, botId);
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `memory-${botId}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not export memory.");
    } finally {
      setBusy(false);
    }
  }

  async function forget(path: string) {
    if (!conversation) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await forgetMemory(conversation.id, botId, [path]);
      setNotice(`Forgot ${result.deleted} file${result.deleted === 1 ? "" : "s"}.`);
      setConfirmPath(undefined);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not forget that file.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6 sm:p-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl tracking-[-0.05em]">Memory</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            User-confirmed instructions are global. Notes, progress, and the index belong to one bot conversation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Bot"
            className="h-9 bg-muted/40 px-3 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
            onChange={(event) => setBotId(event.target.value)}
            value={botId}
          >
            {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select>
          <Button disabled={busy || !conversation} onClick={() => void downloadExport()} size="sm" variant="soft">
            <DownloadSimpleIcon /> Export
          </Button>
        </div>
      </header>

      {error ? <p className="mt-4 text-destructive text-xs" role="alert">{error}</p> : null}
      {notice ? <p className="mt-4 text-xs text-muted-foreground" role="status">{notice}</p> : null}

      {loading ? <div className="mt-8 grid place-items-center"><Spinner /></div> : (
        <>
          <section className="mt-8">
            <h2 className="mb-3 text-[10px] font-medium text-muted-foreground uppercase tracking-[0.16em]">User instructions</h2>
            <Textarea
              className="min-h-40 font-mono text-xs"
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Tell every bot how to work with you."
              value={draft}
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">
                {instructions ? `Revision ${instructions.version}` : "Not set"}
              </span>
              <Button disabled={busy || draft === (instructions?.content ?? "")} onClick={() => void saveInstructions()} size="sm">
                Save instructions
              </Button>
            </div>
          </section>

          <section className="mt-8">
            <h2 className="mb-3 text-[10px] font-medium text-muted-foreground uppercase tracking-[0.16em]">Conversation files</h2>
            {files.length === 0 ? <p className="text-xs text-muted-foreground">No memory files yet.</p> : (
              <ul className="divide-y divide-border bg-muted/20">
                {files.map((file) => (
                  <li className="flex items-center gap-3 px-4 py-3" key={file.path}>
                    <button className="min-w-0 flex-1 text-left" onClick={() => void openFile(file.path)} type="button">
                      <span className="block truncate font-mono text-xs">{file.path}</span>
                      <span className="mt-1 block text-[11px] text-muted-foreground">{file.kind} · {file.chars} chars · v{file.version}</span>
                    </button>
                    {confirmPath === file.path ? (
                      <span className="flex items-center gap-2">
                        <Button disabled={busy} onClick={() => void forget(file.path)} size="sm" variant="destructive">Confirm</Button>
                        <Button onClick={() => setConfirmPath(undefined)} size="sm" variant="ghost">Cancel</Button>
                      </span>
                    ) : (
                      <Button aria-label={`Forget ${file.path}`} onClick={() => setConfirmPath(file.path)} size="icon" variant="ghost">
                        <TrashIcon />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {selectedPath ? (
            <section className="mt-8">
              <h2 className="mb-3 font-mono text-[11px] text-muted-foreground">{selectedPath}</h2>
              <pre className="max-h-80 overflow-auto bg-muted/30 p-4 font-mono text-xs whitespace-pre-wrap">
                {selectedContent ?? "Loading…"}
              </pre>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
