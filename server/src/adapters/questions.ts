import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { object } from './rpc.js';
import type { InputQuestion, RunOptions } from './types.js';

/** A per-run, loopback MCP tool for agents whose protocol lacks structured answers. */
export async function questionServer(
  opts: RunOptions,
  provider = 'Gemini',
): Promise<{ url: string; activity: () => number; close: () => Promise<void> }> {
  const route = `/mcp/${randomBytes(24).toString('hex')}`;
  const ac = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, ac.signal]) : ac.signal;
  let activity = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== route) {
      res.writeHead(404);
      res.end();
      return;
    }
    activity++;
    if (req.method !== 'POST') {
      res.writeHead(req.method === 'DELETE' ? 204 : 405);
      res.end();
      return;
    }
    void (async () => {
      let raw = '';
      for await (const chunk of req) {
        raw += String(chunk);
        if (raw.length > 256_000) throw new Error('MCP request is too large');
      }
      const message = object(JSON.parse(raw));
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const params = object(message.params);
      let result: unknown;
      if (message.method === 'initialize')
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'council-questions', version: '0.1.0' },
        };
      else if (message.method === 'ping') result = {};
      else if (message.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'ask_council_user',
              annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
              description:
                'Pause and ask the Council user questions. Use this for all clarification, yes/no, and multiple-choice questions. The user may select choices or enter custom answers. Wait for the tool result before proceeding.',
              inputSchema: {
                type: 'object',
                required: ['questions'],
                properties: {
                  questions: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 10,
                    items: {
                      type: 'object',
                      required: ['id', 'question'],
                      properties: {
                        id: { type: 'string' },
                        question: { type: 'string' },
                        multiSelect: { type: 'boolean' },
                        options: {
                          type: 'array',
                          items: {
                            type: 'object',
                            required: ['label'],
                            properties: { label: { type: 'string' }, description: { type: 'string' } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        };
      else if (message.method === 'tools/call' && params.name === 'ask_council_user') {
        const input = object(params.arguments);
        if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 10)
          throw new Error('Supply 1 to 10 questions');
        const ids = new Set<string>();
        const questions: InputQuestion[] = input.questions.map((value) => {
          const q = object(value);
          if (
            typeof q.id !== 'string' ||
            !q.id ||
            ids.has(q.id) ||
            typeof q.question !== 'string' ||
            !q.question.trim()
          )
            throw new Error('Questions need unique ids and nonempty text');
          ids.add(q.id);
          return {
            id: q.id,
            question: q.question,
            multiSelect: q.multiSelect === true,
            options: (Array.isArray(q.options) ? q.options : []).map((value) => {
              const o = object(value);
              if (typeof o.label !== 'string') throw new Error('Choice labels must be strings');
              return { label: o.label, description: typeof o.description === 'string' ? o.description : undefined };
            }),
          };
        });
        const disconnected = new AbortController();
        const onClose = () => {
          if (!res.writableEnded) disconnected.abort();
        };
        res.once('close', onClose);
        let reply;
        try {
          reply = await opts.requestInput!(
            { kind: 'question', title: `${provider} needs your answer`, questions },
            AbortSignal.any([signal, disconnected.signal]),
          );
        } finally {
          res.removeListener('close', onClose);
        }
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                reply.decision === 'answer'
                  ? { answers: reply.answers }
                  : { declined: true, message: 'The user dismissed the questions. Do not assume an answer.' },
              ),
            },
          ],
        };
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Unsupported MCP method' },
          }),
        );
        return;
      }
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    })().catch((error: unknown) => {
      if (res.destroyed) return;
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot start Council question server');
  return {
    url: `http://127.0.0.1:${address.port}${route}`,
    activity: () => activity,
    close: () => {
      ac.abort();
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
