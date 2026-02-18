export function TableLink({ href, children, mono }: { href: string; children: any; mono?: boolean }) {
  return (
    <a href={href} class={`text-ink font-medium hover:text-accent-olive transition-colors no-underline ${mono ? "font-mono text-xs" : ""}`}>{children}</a>
  );
}
