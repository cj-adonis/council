# Error Relay, Choice Selection, and UX Improvements Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the chat response/error relay pipeline so that assistant error messages and interactive choices are clearly communicated and actionable, prevent automatic escalation from bypassing user choices, eliminate model desynchronization bugs, and resolve key UX papercuts.

**Architecture:**
- **Server Adapters & Engine:** Retain `child.stderr()` on non-zero CLI exit when stdout result lacks error detail; inspect `o.error` in Gemini streaming result; prevent `autoEscalate` from preempting user choice when an assistant output includes questions/options; handle recovering from failed votes in `engine.send()`.
- **Client Presentation & Interaction:** Introduce an option-extractor (`lib/options.ts`) to detect choices in assistant text and `ask_user` tool calls; render clickable quick-action buttons above the composer; stop duplicate `<pre>` text rendering in `ResultLine`; reset models on provider switch in `VoteCard`, `TabView`, and `Composer`; enable full-auto elevation on active tabs; replace disabled composer on closed tabs with a clean banner.

**Tech Stack:** TypeScript, React, Node.js child_process, Vitest.

---

### Task 1: Server — Stderr & Error Preservation in CLI Adapters

**Files:**
- Modify: `server/src/adapters/run.ts:30-45`
- Modify: `server/src/adapters/gemini.ts:85-105`
- Test: `server/test/run.test.ts`
- Test: `server/test/gemini.test.ts`

**Interfaces:**
- Consumes: `child.stderr()`, `AdapterEvent`, `ResultEvent`
- Produces: `runCli()` and `createGeminiParser()` yielding complete error messages when CLI exits with non-zero or error status.

- [ ] **Step 1: Write failing tests for error preservation**
Add tests in `server/test/run.test.ts` verifying that if `result` has no text and `exitCode !== 0`, `child.stderr()` is attached to `result.text`.
Add a test in `server/test/gemini.test.ts` verifying that `createGeminiParser()` extracts `o.error.message` on error status if `lastText` was empty.

- [ ] **Step 2: Run tests to verify failure**
Run: `npm -w server test -- test/run.test.ts test/gemini.test.ts`

- [ ] **Step 3: Implement stderr & error preservation**
In `server/src/adapters/run.ts`:
If `exitCode !== 0` and `result`, set `result.text = result.text || child.stderr().trim() || undefined`.
In `server/src/adapters/gemini.ts`:
In `createGeminiParser()` under `case 'result'`, if `o.status !== 'success'`, set `text = lastText || (o.error && typeof o.error === 'object' && typeof (o.error as any).message === 'string' ? (o.error as any).message : typeof o.message === 'string' ? o.message : undefined)`.

- [ ] **Step 4: Run tests to verify pass**
Run: `npm -w server test -- test/run.test.ts test/gemini.test.ts`

---

### Task 2: Server — Respect User Choice & Recover from Failed Status in TaskEngine

**Files:**
- Modify: `server/src/tasks/engine.ts`
- Test: `server/test/engine.test.ts`

**Interfaces:**
- Consumes: `tab.status`, `tab.transcript`, `autoEscalate`
- Produces: `hasChoicePrompt(text)` helper; conditional auto-escalation check; fallback worker assignment on `engine.send()` if `tab.worker` is null.

- [ ] **Step 1: Write failing tests in `server/test/engine.test.ts`**
1. Test that `runWorker` does NOT auto-escalate when the failed turn's assistant message asks the user to choose (e.g. contains numbered choices or questions like "Would you like to 1. ... or 2. ...?").
2. Test that `engine.send()` on a failed tab without a worker (e.g. failed council vote) assigns the first available seat rather than throwing "no worker assigned".
3. Test that `clearContext` transitions tab to `'drafting'` (or clears prior context so that drafting can occur anew).

- [ ] **Step 2: Run tests to verify failure**
Run: `npm -w server test -- test/engine.test.ts`

- [ ] **Step 3: Implement choice detection and failed recovery in `engine.ts`**
1. Add `hasChoicePrompt(text?: string): boolean` in `engine.ts` (matching patterns like `/\b(choose|option|which|would you like|1\.\s+.+2\.\s+)/i`).
2. In `engine.ts` post-worker logic, only auto-escalate if `!hasChoicePrompt(result?.text ?? lastAssistantText)`.
3. In `engine.send(tabId, text)`: if `!tab.worker`, pick `this.cheapestSeat(eff.seats)` or the first seat so the tab can run.

- [ ] **Step 4: Run tests to verify pass**
Run: `npm -w server test -- test/engine.test.ts`

---

### Task 3: Client — Model Reset on Provider Switch & Tool Classification

**Files:**
- Modify: `client/src/components/VoteCard.tsx`
- Modify: `client/src/components/TabView.tsx`
- Modify: `client/src/components/Composer.tsx`
- Modify: `client/src/lib/tools.ts`
- Test: `client/src/lib/tools.test.ts`

**Interfaces:**
- Consumes: `ProviderSelect`, `classifyTool`
- Produces: `ask_user` tool classified as interactive `choice`; provider change handlers safely resetting model.

- [ ] **Step 1: Write test for `ask_user` classification in `client/src/lib/tools.test.ts`**
Add test that `classifyTool({ name: 'ask_user', input: { questions: [{ question: 'Pick one?' }] } })` yields `kind: 'choice'` with subject and glyph.

- [ ] **Step 2: Run test to verify failure**
Run: `npm -w client test -- src/lib/tools.test.ts`

- [ ] **Step 3: Implement tool classification & model resets**
1. In `client/src/lib/tools.ts`, add `CHOICE = new Set(['ask_user', 'question', 'confirm', 'choice'])`. Return `kind: 'choice'`, `verb: 'Asked'`, `glyph: '?'`.
2. In `client/src/components/VoteCard.tsx`, update `setProvider` handler: when `provider` changes, reset `setModel('')`.
3. In `client/src/components/TabView.tsx`, update `setSwitchProvider` handler: reset `setSwitchModel('')`.
4. In `client/src/components/Composer.tsx`, update provider click: reset `setModel('')`.

- [ ] **Step 4: Run client tests to verify pass**
Run: `npm -w client test -- src/lib/tools.test.ts`

---

### Task 4: Client — Option Extractor, Interactive Quick Replies, and Transcript De-duplication

**Files:**
- Create: `client/src/lib/options.ts`
- Create: `client/src/lib/options.test.ts`
- Modify: `client/src/components/Transcript.tsx`
- Modify: `client/src/components/Composer.tsx`

**Interfaces:**
- Consumes: `TranscriptItem`
- Produces: `extractOptions(text?: string, tool?: unknown): string[]` returning list of detected choices.

- [ ] **Step 1: Write test for `extractOptions` in `client/src/lib/options.test.ts`**
Test extraction of:
1. Numbered lists (e.g. `1. Run migrate\n2. Skip`).
2. Bullet options after choice prompts.
3. `ask_user` parameters containing questions and options array.

- [ ] **Step 2: Run test to verify failure**
Run: `npm -w client test -- src/lib/options.test.ts`

- [ ] **Step 3: Implement `client/src/lib/options.ts`**
Implement `extractOptions(text?: string, tool?: unknown): string[]`.

- [ ] **Step 4: De-duplicate error text in `Transcript.tsx`**
In `ResultLine`, do NOT render `<pre className="small">{stripAnsi(item.text)}</pre>` if `item.text` matches an immediately preceding `assistant` message.
If it does not match (it is a unique error), render it cleanly.

- [ ] **Step 5: Wire interactive Quick Options & Failure Recovery in `Composer.tsx`**
1. Extract options from the last assistant or tool item using `extractOptions`.
2. Render option chips above the composer: clicking a chip populates the input and sends or sets text.
3. If `tab.status === 'failed'`, render a recovery bar: "Worker failed. [Retry] [Escalate] [⚡ Full Auto]".

- [ ] **Step 6: Run tests to verify pass**
Run: `npm -w client test`

---

### Task 5: Client — Closed Tab UX & Auto-Scroll Reliability

**Files:**
- Modify: `client/src/components/TabView.tsx`
- Modify: `client/src/hooks/useStickToBottom.ts`
- Test: `client/src/lib/nav.test.ts`

**Interfaces:**
- Consumes: `tab.status`, `tab.transcript`
- Produces: Clean closed-tab banner in `TabView.tsx`; reliable stick-to-bottom scroll tracking.

- [ ] **Step 1: Update `TabView.tsx` closed state**
When `tab.status === 'closed'`, replace `<Composer />` with a banner:
`"This tab is closed. [Delete tab]"`.

- [ ] **Step 2: Improve `useStickToBottom.ts`**
Enhance `signal` calculation in `TabView.tsx` to include total transcript length and timestamps, or observe element resize via `ResizeObserver`.

- [ ] **Step 3: Run full workspace test suite**
Run: `npm test`
Confirm 100% test pass across server and client.
