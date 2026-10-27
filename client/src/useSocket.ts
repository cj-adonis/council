import { useEffect, useRef, useState } from 'react';
import type { BudgetState, Provider, Tab, TranscriptItem } from './types';

export interface SocketHandlers {
  onHello: (tabs: Tab[], budgets: Record<Provider, BudgetState> | null) => void;
  onTab: (tab: Tab) => void;
  onDeleted: (tabId: string) => void;
  onItem: (tabId: string, item: TranscriptItem) => void;
  onStall?: (tabId: string) => void;
  onBudgets: (budgets: Record<Provider, BudgetState>) => void;
}

type Incoming =
  | { type: 'hello'; tabs: Tab[]; budgets: Record<Provider, BudgetState> | null }
  | { type: 'tab'; tab: Tab }
  | { type: 'deleted'; tabId: string }
  | { type: 'item'; tabId: string; item: TranscriptItem }
  | { type: 'stall'; tabId: string }
  | { type: 'budgets'; budgets: Record<Provider, BudgetState> };

/** Keeps a WebSocket to /ws open with reconnects; returns whether it is connected. */
export function useSocket(handlers: SocketHandlers): boolean {
  const [connected, setConnected] = useState(false);
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    let stopped = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/ws`);
      socket.onopen = () => {
        delay = 1000;
        setConnected(true);
      };
      socket.onmessage = (ev) => {
        let msg: Incoming;
        try {
          msg = JSON.parse(String(ev.data)) as Incoming;
        } catch {
          return;
        }
        const h = ref.current;
        if (msg.type === 'hello') h.onHello(msg.tabs, msg.budgets);
        else if (msg.type === 'tab') h.onTab(msg.tab);
        else if (msg.type === 'deleted') h.onDeleted(msg.tabId);
        else if (msg.type === 'item') h.onItem(msg.tabId, msg.item);
        else if (msg.type === 'stall') h.onStall?.(msg.tabId);
        else if (msg.type === 'budgets') h.onBudgets(msg.budgets);
      };
      socket.onclose = () => {
        setConnected(false);
        if (stopped) return;
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10_000);
      };
      socket.onerror = () => socket?.close();
    };
    connect();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return connected;
}
