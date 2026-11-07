import { cn } from "cn";

export function Spinner({ className }: { className?: string }) {
  return <span aria-label="Loading" className={cn("inline-block size-3 animate-spin border border-current border-r-transparent", className)} role="status" />;
}
