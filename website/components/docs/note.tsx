/**
 * A quiet aside: a rule down the left and slightly lighter ink. One style
 * only — no traffic-light variants — because these docs use asides
 * sparingly, for the thing a reader would otherwise learn the hard way.
 */
export function Note({ children }: { children: React.ReactNode }) {
  return (
    <aside className="my-5 border-l-2 pl-4 text-muted-foreground [&_code]:text-foreground">
      {children}
    </aside>
  );
}
