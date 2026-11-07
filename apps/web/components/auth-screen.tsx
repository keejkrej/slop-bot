"use client";

import { useState } from "react";
import { GoogleLogoIcon, ArrowRightIcon } from "@phosphor-icons/react";
import { getSupabase } from "@/lib/client/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AuthScreen() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function magicLink(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(undefined);
    const { error } = await getSupabase().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setMessage(error?.message ?? "Check your inbox for a sign-in link.");
    setBusy(false);
  }

  async function google() {
    setBusy(true);
    const { error } = await getSupabase().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) setMessage(error.message);
    setBusy(false);
  }

  return (
    <main className="grid min-h-dvh place-items-center p-5">
      <section className="w-full max-w-sm">
        <div className="mb-10 flex items-center gap-3">
          <LogoMark />
          <span className="font-medium tracking-[-0.06em]">SLOP BOT</span>
        </div>
        <p className="mb-2 text-muted-foreground text-xs uppercase tracking-widest">Your bots are waiting</p>
        <h1 className="mb-8 text-3xl leading-tight tracking-[-0.06em]">Sign in to the club.</h1>
        <Button className="w-full" disabled={busy} onClick={google} type="button" variant="outline">
          <GoogleLogoIcon /> Continue with Google
        </Button>
        <div className="my-5 flex items-center gap-3 text-muted-foreground text-[10px] uppercase tracking-widest">
          <span className="h-px flex-1 bg-border" /> or use email <span className="h-px flex-1 bg-border" />
        </div>
        <form className="flex gap-2" onSubmit={magicLink}>
          <Input
            aria-label="Email address"
            autoComplete="email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            required
            type="email"
            value={email}
          />
          <Button aria-label="Send magic link" disabled={busy} size="icon" type="submit"><ArrowRightIcon /></Button>
        </form>
        {message ? <p className="mt-4 text-muted-foreground text-xs leading-relaxed" role="status">{message}</p> : null}
      </section>
    </main>
  );
}

export function LogoMark() {
  return (
    <span aria-hidden="true" className="grid size-7 grid-cols-2 gap-0.5 bg-foreground p-1">
      <span className="bg-background" /><span className="bg-background/40" />
      <span className="bg-background/40" /><span className="bg-background" />
    </span>
  );
}
