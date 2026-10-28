import { useState } from 'react';
import { api } from '../api';
import type { ProjectInfo } from '../types';

interface Options {
  /** The currently open project, used as the initial folder. */
  exclude?: ProjectInfo | null;
  onOpenProject: (path: string) => Promise<void>;
}

/**
 * The shared browse and open behavior of the two project pickers.
 */
export function useProjectPicker({ exclude = null, onOpenProject }: Options) {
  const [opening, setOpening] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const open = async (target: string) => {
    if (!target.trim()) return;
    setOpening(true);
    try {
      await onOpenProject(target.trim());
    } finally {
      setOpening(false);
    }
  };

  const browse = async () => {
    setOpening(true);
    try {
      const result = await api.pickNativeFolder(exclude?.root);
      if (result.path) await open(result.path);
      else if (!result.available) setBrowsing(true);
    } catch {
      setBrowsing(true);
    } finally {
      setOpening(false);
    }
  };

  return {
    opening,
    browsing,
    setBrowsing,
    browse,
    open,
  };
}
