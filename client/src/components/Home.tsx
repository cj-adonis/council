import { basename } from '../lib/format';
import { useProjectPicker } from '../hooks/useProjectPicker';
import { noneSetUp, type Availability } from '../lib/routing';
import type { CliHealth, ProjectInfo, Provider } from '../types';
import { FolderBrowser } from './FolderBrowser';
import { Health } from './Health';

interface Props {
  project: ProjectInfo | null;
  openTabs: number;
  available: Availability;
  /** Plain-language notes on the routing in force (which CLIs are set up, how tiers are filled). */
  notes: string[];
  health: Record<Provider, CliHealth> | null;
  checking?: boolean;
  onRefresh?: () => void;
  onOpenProject: (path: string) => Promise<void>;
  onNewTab: () => void;
  onSettings: () => void;
  confidenceThreshold?: number;
}

export function Steps({ confidenceThreshold = 0.8 }: { confidenceThreshold?: number }) {
  return (
    <div className="steps" aria-label="How a tab works">
      <div className="step">
        <b>1 · Evaluate</b>
        <span>Council seats analyze task complexity (1–5) and self-score their confidence.</span>
      </div>
      <div className="step">
        <b>2 · Route</b>
        <span>The lowest-cost seat meeting the confidence threshold (≥{Math.round(confidenceThreshold * 100)}%) executes the task, with fallback to the strongest available seat.</span>
      </div>
      <div className="step">
        <b>3 · Review</b>
        <span>Review the work and any changes in your workspace.</span>
      </div>
    </div>
  );
}

function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="notes" aria-label="Routing notes">
      {notes.map((n) => (
        <div key={n} className="note-row">
          {n}
        </div>
      ))}
    </div>
  );
}

/** What the main pane shows with no tab selected: set up a CLI, get started, or jump back in. */
export function Home({ project, openTabs, available, notes, health, checking, onRefresh, onOpenProject, onNewTab, onSettings, confidenceThreshold }: Props) {
  const { opening, browsing, setBrowsing, browse, open } =
    useProjectPicker({ onOpenProject });

  if (noneSetUp(available)) {
    return (
      <main className="home">
        <div className="home-inner home-setup">
          <h2>Connect your first AI provider</h2>
          <p className="lead">
            Install a coding CLI and sign in through its terminal prompt. Council will use that CLI to evaluate tasks and run your chosen worker.
          </p>
          <Health health={health} checking={checking} onRefresh={onRefresh} />
          <p className="muted sm">
            You can manage providers anytime in{' '}
            <button className="link sm" onClick={onSettings}>
              Settings › AI Models &amp; Workers
            </button>
            .
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="home">
      <div className={project ? 'home-inner' : 'home-inner home-setup'}>
        {project ? (
          <>
            <h2>{openTabs > 0 ? 'Pick a tab, or start another' : 'Start the first task'}</h2>
            <p className="lead">
              {openTabs > 0
                ? `${basename(project.root)} has ${openTabs} open tab${openTabs === 1 ? '' : 's'} in the sidebar. Each one is a task with its own worker in this workspace.`
                : `Create a tab, describe the task, and the council routes it to the cheapest agent that can handle it. Workers follow the project's CLAUDE.md, AGENTS.md or GEMINI.md.`}
            </p>
            <div className="row">
              <button className="primary" onClick={onNewTab}>
                + New tab
              </button>
              <span className="muted sm">
                or press <kbd>Alt</kbd> <kbd>N</kbd>
              </span>
            </div>
            <Steps confidenceThreshold={confidenceThreshold} />
            <Notes notes={notes} />
          </>
        ) : (
          <>
            <h2>Your local AI workspace</h2>
            <p className="lead">
              Open a folder as a workspace. Each tab puts an agent to work in it, following any CLAUDE.md, AGENTS.md or GEMINI.md instructions it finds.
            </p>

            <Health health={health} checking={checking} onRefresh={onRefresh} />

            <div className="card">
              <h3>Open a project</h3>
              <div className="row">
                <button
                  type="button"
                  className="quiet"
                  onClick={() => void browse()}
                  disabled={opening}
                  title="Browse folders"
                >
                  📁 Browse Folders
                </button>
              </div>

            </div>

            <Steps confidenceThreshold={confidenceThreshold} />
            <Notes notes={notes} />
          </>
        )}
      </div>

      {browsing && (
        <FolderBrowser
          initialDir={project?.root}
          onSelect={(selected) => void open(selected)}
          onClose={() => setBrowsing(false)}
        />
      )}
    </main>
  );
}
