import { useId } from 'react';

// The Nimbus mark: a cloud (nimbus) with a node beneath it, the record an agent works on, connected to the cloud.
// Plain geometry, no sparkle. Same shape as brand/nimbus-mark.svg and the favicon; keep them in step.
export const MARK_PATH = 'M8.33 23.94a6 6 0 0 1-1.1-11.9 8 8 0 0 1 15.3-2.1 6.6 6.6 0 0 1 .4 13.9Z';

export function LogoMark({ size = 14 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="2 2 28 28" fill="none" aria-hidden="true">
      <mask id={`nm${id}`}><rect x="0" y="0" width="32" height="32" fill="#fff" /><circle cx="16" cy="24.44" r="4.4" fill="#000" /></mask>
      <path d={MARK_PATH} fill="currentColor" mask={`url(#nm${id})`} />
      <circle cx="16" cy="24.44" r="2.5" fill="currentColor" />
    </svg>
  );
}
