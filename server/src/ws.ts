import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { isAllowedHost, isAllowedOrigin } from './origin.js';
import type { TaskEngine } from './tasks/engine.js';

export type WsMessage =
  | { type: 'hello'; tabs: unknown[]; budgets: unknown }
  | { type: 'tab'; tab: unknown }
  | { type: 'deleted'; tabId: string }
  | { type: 'item'; tabId: string; item: unknown }
  | { type: 'stall'; tabId: string }
  | { type: 'budgets'; budgets: unknown };

/**
 * Streams engine events to every browser. A new socket first receives `hello`
 * with all tabs and budgets; anything that happens meanwhile is queued behind it.
 */
export function attachWebSocket(server: http.Server, engine: TaskEngine): WebSocketServer {
  // WebSockets ignore the same-origin policy; refuse upgrades from non-loopback pages.
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info: { origin: string | undefined; req: http.IncomingMessage }) =>
      isAllowedOrigin(info.origin || undefined) && isAllowedHost(info.req.headers.host),
  });
  const pending = new Map<WebSocket, string[]>();

  const deliver = (socket: WebSocket, data: string) => {
    const queue = pending.get(socket);
    if (queue) queue.push(data);
    else if (socket.readyState === WebSocket.OPEN) socket.send(data);
  };
  const broadcast = (msg: WsMessage) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) deliver(client, data);
  };

  wss.on('connection', (socket) => {
    pending.set(socket, []);
    void (async () => {
      let hello: string;
      try {
        hello = JSON.stringify({ type: 'hello', tabs: engine.listTabs(), budgets: await engine.budgets() } satisfies WsMessage);
      } catch (err) {
        hello = JSON.stringify({ type: 'hello', tabs: engine.listTabs(), budgets: null, error: String(err) });
      }
      const queue = pending.get(socket) ?? [];
      pending.delete(socket);
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(hello);
      for (const data of queue) socket.send(data);
    })();
    socket.on('close', () => pending.delete(socket));
  });

  engine.on('tab', (tab) => broadcast({ type: 'tab', tab }));
  engine.on('deleted', ({ tabId }: { tabId: string }) => broadcast({ type: 'deleted', tabId }));
  engine.on('item', ({ tabId, item }: { tabId: string; item: unknown }) => broadcast({ type: 'item', tabId, item }));
  engine.on('stall', ({ tabId }: { tabId: string }) => broadcast({ type: 'stall', tabId }));

  let budgetTimer: NodeJS.Timeout | undefined;
  const budgetsSoon = () => {
    if (budgetTimer) clearTimeout(budgetTimer);
    budgetTimer = setTimeout(() => {
      engine
        .budgets()
        .then((budgets) => broadcast({ type: 'budgets', budgets }))
        .catch(() => {});
    }, 300);
  };
  engine.on('ledger', budgetsSoon);
  engine.on('quota', budgetsSoon);

  return wss;
}
