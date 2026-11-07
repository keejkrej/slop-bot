"use client";

import { TriangleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

export function AuthScreen() {
  return (
    <main className="grid min-h-dvh place-items-center p-5">
      <section className="w-full max-w-sm">
        <div className="mb-10 flex items-center gap-3"><LogoMark /><span className="font-medium tracking-[-0.06em]">SLOP BOT</span></div>
        <p className="mb-2 text-muted-foreground text-xs uppercase tracking-widest">Your personal bot club</p>
        <h1 className="mb-4 text-3xl leading-tight tracking-[-0.06em]">Sign in with Vercel.</h1>
        <p className="mb-8 text-muted-foreground text-xs leading-relaxed">Single-tenant access. Only the Vercel account approved by this deployment can continue.</p>
        <Button className="w-full" onClick={() => window.location.assign("/api/auth/vercel?platform=web")} type="button" variant="outline">
          <TriangleIcon weight="fill" /> Continue with Vercel
        </Button>
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
