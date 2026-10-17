// The CRMagents mark: a "C" that ends in a node (a record, and the step that acts on it). Plain geometry, no sparkle.
export function LogoMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M12.2 4.6A5 5 0 1 0 12.2 11.4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12.4" cy="11.4" r="1.9" fill="currentColor" />
    </svg>
  );
}
