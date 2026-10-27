# Council

Council is a small local app that puts **Claude Code**, **Codex CLI** and **Gemini CLI** to work on the same project at the same time, and spends the expensive one only when it has to.

You open a project, create a tab and describe a task. A *council* of models rates its confidence and the task's complexity. Council selects the cheapest available seat with sufficient confidence, or the strongest seat that returned a usable vote. The worker edits your checkout directly, follows the project's own `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`, and leaves changes uncommitted by default; you review the result in your editor or git. Spend per provider is tallied against your monthly credit and shown on screen.

Everything runs on your machine and talks to the CLIs you already have installed and signed in. Nothing leaves your machine except what those CLIs send to their vendors.

## How a tab works

1. **Describe** the task in a new tab. Pick *Auto* to let the council route it, or pick a specific provider and model yourself.
2. **Vote.** Each council seat (by default Gemini Flash Lite, Codex's configured CLI default and Claude Haiku) is asked to rate confidence from 0 to 1 and complexity from 1 to 5. The vote card shows every seat's answer, reason and cost. Failed and incomplete votes cannot win.
3. **Start.** The cheapest available seat meeting the confidence threshold wins. If none meets it, Council uses the strongest available seat with a usable vote. Exhausted budgets and unavailable providers are skipped. You can override the pick or turn on *auto-start* in Settings. If no usable route exists, auto-start pauses and you must explicitly choose a worker.
4. **Work.** The worker runs in your project checkout. Choose its permission mode in the composer; the default is *Accept edits*. Its output, tool calls and cost stream into the tab. Follow-up messages resume the same CLI session. Nothing is committed; the changes sit in your working copy like edits you made yourself. Two tabs editing the same files at the same time can collide, so give parallel tabs separate areas of the code.
5. **Escalate or switch.** If the worker fails, the task is handed to the next stronger council seat with a short summary of what was tried and the uncommitted diff so far (once, automatically; after that it is your call). Permission-blocked runs stay failed for review instead of escalating automatically. *Switch worker* does the same to any provider you choose; switching back resumes the earlier session.
6. **Review and close.** Look at the changes in your editor or `git diff`, keep or discard them, and close the tab. Closing stops a running worker and leaves the checkout as it is.

## Live approvals and questions

The composer's **Permissions** selector controls the native CLI mode, before submission or on an existing tab. Choices are remembered separately for each provider/model within that tab. Claude offers **Auto review**, which applies immediately to future tool requests while existing approvals and user questions still wait for your response. Existing Claude Full auto choices become Auto review; Council never requests Claude's bypass-permissions mode. Gemini's **Full auto** applies immediately and allows pending tool approvals. Other changes stage the next turn. Gemini approval prompts also show its native session and persistent allow choices when offered by the CLI.

| Mode | Claude | Codex | Gemini |
| --- | --- | --- | --- |
| Default | Native approval rules | Workspace sandbox with user review of escalations | Native approval rules |
| Plan | Native Plan mode | Plan collaboration mode and read-only sandbox | Native Plan mode |
| Accept edits | `acceptEdits` | Workspace sandbox; edits and sandboxed commands can run | `auto_edit` |
| Auto review | Native action classifier, when supported | `auto_review` inside the workspace sandbox, when supported | Unavailable |
| Full auto | Legacy alias for Auto review (`auto`) | No approvals and `danger-full-access` | `yolo` |

Auto review depends on CLI, model, account, and managed-policy support. It keeps native action review enabled. Unsupported native settings report an error. Plan mode keeps execution requests blocked; to implement a plan, select another mode and send a follow-up. Switching to a new model starts with Accept edits (or preserves Plan); returning to a previous model restores its saved choice. The old browser-local Always full auto preference is no longer applied to new tasks.

Live Plan-to-Accept-edits transitions and the repeated choices tests passed on all three provider defaults. See the [permission mode test results](docs/permission-modes-results-2026-10-26.json) for the exact coverage.

When a CLI requests permission, the tab moves to **Needs you** and shows the requested action with **Allow once** and **Deny** buttons. The running CLI waits for that decision. Denying a request does not enable full auto or automatically escalate to another worker. CLI sandbox and managed permission rules still apply.

Claude approvals also offer **Always allow for this project**, **Always allow for all projects**, or **Allow for this session** when the CLI suggests a rule with that scope. Each button shows the exact rule it saves. Persistent project approvals go through Claude's native permission updates so matching commands remain allowed in future sessions. Requests for which Claude suppresses remembered approval keep only the one-time choice.

Structured questions appear as forms with single-choice options, multiple-selection checkboxes, and custom text fields. Submit the form to answer the paused worker. No answer is preselected. Ordinary questions in assistant text still offer suggested replies in the composer.

Pending prompts survive a browser refresh or reconnect. Closing a tab cancels them; restarting the server invalidates old requests so an obsolete approval cannot affect a new run. Time waiting for an answer does not count as a worker stall. Proposed file diffs are shown when the CLI supplies them with an approval request.

Use **Stop** in the tab header while a worker, vote, or handoff is running. It cancels the current work and pending prompts, keeps the transcript and existing checkout changes, and enables the composer so you can send another message on the same tab. A stalled worker's notice also offers **Stop and send another message**.

Workers use [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude's SDK approval callbacks](https://code.claude.com/docs/en/agent-sdk/user-input) with your installed Claude CLI, and [Gemini ACP](https://geminicli.com/docs/cli/acp-mode/). A private loopback MCP question tool provides structured answers where needed. Votes and summaries keep their non-interactive CLI interfaces.

Type `/` at the start of a task or follow-up, or after a space or newline, to browse and filter skills. Use the arrow keys to select, and press Tab or Enter to insert `/skill-name`; press Enter again to send your message. Escape dismisses the suggestions. Council sends the worker an explicit skill instruction and its file path. Skills are discovered in the existing user skill directories and the project's `.gemini/skills`, `.claude/skills`, `.agents/skills`, `.codex/skills`, and `tools/skills` directories.

## Requirements

- Node 24 or newer.
- git.
- The CLIs you want to use, installed and signed in on this machine:
  - Claude Code: `npm install -g @anthropic-ai/claude-code`, then set `ANTHROPIC_API_KEY` or run `claude` once and sign in.
  - Codex CLI: `npm install -g @openai/codex`, then set `CODEX_API_KEY` (or `OPENAI_API_KEY`) or run `codex login`.
  - Gemini CLI: `npm install -g @google/gemini-cli`, then set `GEMINI_API_KEY` or run `gemini` once and sign in. Google Workspace accounts also need `GOOGLE_CLOUD_PROJECT`.

The Settings page has a health panel that shows what Council can see of each CLI.

## Install and run

```bash
npm install
npm run build
npm start
```

Then open <http://localhost:4317>. Set `PORT` to use another port. During development `npm run dev` runs the server with reload and the client with Vite on <http://localhost:5173>.

Council keeps its data in `~/.council` (`settings.json`, `pricing.json`, `ledger.jsonl`, and one folder per project with its tabs). Set `COUNCIL_HOME` to put it elsewhere.

## One, two or three CLIs

Council works with whatever is installed and signed in. With multiple providers, the available configured seats form the council. With one provider, its configured model ladder forms the council. The vote card explains substitutions, and pickers only offer providers that are set up. For a Codex ChatGPT login, automatic routing substitutes the CLI default when a configured model is absent from the detected account model list; explicit manual picks remain yours. With no provider, the app shows the setup panel.

Version probes are bounded. An executable found on disk remains available if its version check times out; Settings shows the warning. Later health requests use the last snapshot while a shared refresh runs in the background.

## Budgets and prices

Each provider has a monthly limit (defaults: Claude $40, Codex $30, Gemini $30, reset on the 1st). Every CLI run, including votes and hand-off summaries, is appended to `ledger.jsonl` and summed for the current period. At 80% a budget bar turns amber; at 100% the provider counts as exhausted and auto routing avoids it. Picking it by hand still works.

Plan usage is detected automatically where the CLI reports it: Claude Code streams the account's five-hour and seven-day windows during every run, and Codex attaches rate-limit snapshots to its events. Those windows appear under the provider's budget bar with the time to reset, straight from the CLI, no setup needed. Plain API keys expose no remaining-credit figure, so the dollar limits above stay a one-time entry; the spend against them is always tracked automatically.

Claude Code reports its own cost per run and that number is used as is. If you run Claude on a subscription rather than an API key, it is the list-price equivalent, not money leaving your account. Codex and Gemini report tokens only, so Council multiplies them by the price table in `~/.council/pricing.json`. The seeded prices come from public price pages and are meant to be checked and edited there; prices are per million tokens and a row can be an exact model name, a prefix, or `<provider>:default`.

## Settings worth knowing

- **Council seats** – any number of seats from 1 to 5, each any provider and model. Keep them cheap: every task pays for every seat.
- **Confidence threshold** – the minimum confidence for lowest-cost routing (80% by default). Failed seats are excluded from fallback selection too.
- **Allowed commands** – the `--allowedTools` patterns a restricted Claude worker may run. Edited in the composer, next to the permission buttons, and saved for every project.
- **Auto-start / auto-escalate / stall minutes** – whether to skip the pause after a vote, whether a failed worker escalates once by itself, and how long silence counts as a stall.

## Known limits

- Council seats are tool-less only on Claude. Codex and Gemini seats are *asked* not to read files. New settings allow 180 seconds per seat; existing saved timeout choices are preserved. A chatty seat can still spend more than the per-vote ceiling; the vote card flags it.
- Sign-in detection is a heuristic (API key in the environment, or a stored login file). A provider can look signed in and still fail; the failure shows in the transcript and escalation takes over.
- Interactive workers require CLIs supporting app-server, SDK control, or ACP as appropriate. Gemini workers resume explicit ACP session IDs; an older CLI without session loading reports an error rather than silently starting a different conversation.
- CLI stream formats can change between releases. A stream that ends without a recognized completion event now reports a failure with a bounded diagnostic tail instead of silently reporting success. Fixtures live in `server/test/fixtures`.
- One developer, one machine. There is no team server.

## Development

```bash
npm test          # server and client unit tests
npm run e2e       # real run through every installed, signed-in CLI (costs a few cents)
npm run e2e -- --providers=claude
npm run capability -- --providers=codex  # skill fixture and 21 independent code checks
npm run capability -- --routing-only    # real votes on simple and complex tasks
npm run choices:e2e                     # real questions and session-resume checks on all providers
npm run choices:e2e -- --providers=gemini
npm run permissions:e2e                 # real Plan -> Accept edits, same session, isolated file check
npm run permissions:e2e -- --providers=codex
```

The live choices harness checks both Yes and No, single choice, multiple selections, custom text, and a follow-up in the same session. It uses each provider's configured CLI default and reports unavailable providers as incomplete coverage. See the [2026-10-26 reliability results](docs/reliability-results-2026-10-26.json) for the recorded run.

Design: [docs/superpowers/specs/2026-10-20-council-design.md](docs/superpowers/specs/2026-10-20-council-design.md). Implementation plan: [docs/superpowers/plans/2026-10-20-council-implementation.md](docs/superpowers/plans/2026-10-20-council-implementation.md).
