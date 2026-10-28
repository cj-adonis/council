import { useProjectPicker } from '../hooks/useProjectPicker';
import type { ProjectInfo } from '../types';
import { FolderBrowser } from './FolderBrowser';

interface Props {
  project: ProjectInfo | null;
  onOpenProject: (path: string) => Promise<void>;
}

/** Browse for a workspace. */
export function ProjectPicker({ project, onOpenProject }: Props) {
  const { opening, browsing, setBrowsing, browse, open } =
    useProjectPicker({ exclude: project, onOpenProject });

  const openAndClose = async (target: string) => {
    await open(target);
  };

  return (
    <>
      <div className="workspace-picker">
        <div className="workspace-picker-heading">
          <span className="section-label">Workspaces</span>
          <button type="button" className="quiet sm" onClick={() => void browse()} disabled={opening} aria-label="Add workspace" title="Add workspace">
            {opening ? 'Opening…' : '+ Add workspace'}
          </button>
        </div>
      </div>

      {browsing && (
        <FolderBrowser
          initialDir={project?.root}
          onSelect={(selected) => void openAndClose(selected)}
          onClose={() => setBrowsing(false)}
        />
      )}
    </>
  );
}
