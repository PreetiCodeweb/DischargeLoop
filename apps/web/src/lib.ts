import { useCallback, useEffect, useRef, useState } from 'react';

export function usePolling<T>(load: () => Promise<T>, intervalMs = 5000): {
  data: T | null;
  error: string | null;
  refresh: () => void;
  loading: boolean;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const result = await loadRef.current();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Request failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    const timer = window.setInterval(run, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [intervalMs, tick]);

  return { data, error, refresh, loading };
}

export function timeAgo(value: string | null | undefined): string {
  if (!value) return '—';
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function clock(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function label(state: string): string {
  return state.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function stateTone(state: string): string {
  switch (state) {
    case 'AVAILABLE': return 'tone-good';
    case 'OCCUPIED': return 'tone-info';
    case 'RESERVED': return 'tone-warn';
    case 'CLEANING': return 'tone-warn';
    case 'BLOCKED':
    case 'MAINTENANCE': return 'tone-bad';
    case 'INITIATED': return 'tone-neutral';
    case 'MEDICALLY_CLEARED': return 'tone-info';
    case 'TASKS_PENDING': return 'tone-warn';
    case 'READY_TO_DEPART': return 'tone-good';
    case 'DEPARTED': return 'tone-neutral';
    default: return 'tone-neutral';
  }
}
