/**
 * A quiet aside. One style only — no traffic-light variants — because these
 * docs use asides sparingly, for the thing a reader would otherwise learn
 * the hard way.
 */
export function Note({ children }: { children: React.ReactNode }) {
  return (
    <aside className="my-5 rounded-md border border-l-4 border-l-foreground/30 bg-muted/40 px-4 py-3 text-[14px] leading-relaxed text-muted-foreground [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-foreground">
      {children}
    </aside>
  );
}
