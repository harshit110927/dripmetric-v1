'use client';

import { useEffect, useState } from 'react';

/**
 * The unread badge (brief §9: "an unread badge that updates live").
 *
 * Polls every 30 seconds, and stops while the tab is hidden — a background tab
 * polling forever is how a dashboard ends up as the reason someone's laptop fan is
 * on. It starts from the count the server rendered, so the badge is right before any
 * JavaScript runs and the poll only keeps it right.
 */
export function UnreadBadge({ publicId, initial }: { publicId: string; initial: number }) {
  const [unread, setUnread] = useState(initial);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      if (document.hidden) return;
      try {
        const response = await fetch(`/projects/${publicId}/alerts/unread`, {
          cache: 'no-store',
        });
        if (!response.ok) return;
        const body = (await response.json()) as { unread: number };
        if (!cancelled) setUnread(body.unread);
      } catch {
        // A failed poll is not worth showing: the number simply stays as it was.
      }
    };

    const timer = setInterval(() => void poll(), 30_000);
    document.addEventListener('visibilitychange', () => void poll());

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [publicId]);

  if (unread === 0) return null;

  return (
    <span
      aria-label={`${unread} unread ${unread === 1 ? 'alert' : 'alerts'}`}
      style={{
        display: 'inline-block',
        minWidth: 20,
        padding: '1px 6px',
        borderRadius: 10,
        background: '#d9433f',
        color: '#fff',
        fontSize: 12,
        fontWeight: 600,
        textAlign: 'center',
      }}
    >
      {unread > 99 ? '99+' : unread}
    </span>
  );
}
