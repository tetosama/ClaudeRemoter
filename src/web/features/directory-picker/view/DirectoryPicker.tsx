// Modal dialog for browsing the Mac filesystem and adding a project directory.
import { useEffect, useState } from "react";
import { api, messageOf } from "@/shared/api/client";
import type { ProjectDto } from "@shared/protocol";

// Present the modal dialog that browses directories and adds one as a project.
export function DirectoryPicker({ onClose, onAdded }: { onClose: () => void; onAdded: (project: ProjectDto) => void }) {
  const [path, setPath] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<Array<{ name: string; path: string }>>([]);
  const [error, setError] = useState("");
  // Fetch the directory listing for the given path, or the root when omitted.
  const browse = async (target?: string) => {
    try {
      const result = await api<{ path: string; parent: string | null; entries: Array<{ name: string; path: string }> }>(`/api/fs${target ? `?path=${encodeURIComponent(target)}` : ""}`);
      setPath(result.path); setParent(result.parent); setEntries(result.entries); setError("");
    } catch (cause) { setError(messageOf(cause)); }
  };
  useEffect(() => { browse(); }, []);
  // Register the currently selected directory as a new project.
  const add = async () => {
    try { onAdded(await api<ProjectDto>("/api/projects", { method: "POST", body: JSON.stringify({ path }) })); }
    catch (cause) { setError(messageOf(cause)); }
  };
  return <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-label="Select project directory">
    <header><div><p className="eyebrow">PROJECT DIRECTORY</p><h2>Select project directory</h2></div><button className="icon-button" onClick={onClose}>×</button></header>
    <div className="path-input"><input value={path} onChange={(event) => setPath(event.target.value)} /><button onClick={() => browse(path)}>Go</button></div>
    <div className="directory-list">{parent && <button onClick={() => browse(parent)}><span>↰</span><strong>Up one level</strong></button>}
      {entries.map((entry) => <button key={entry.path} onDoubleClick={() => browse(entry.path)} onClick={() => setPath(entry.path)} className={path === entry.path ? "selected" : ""}><span>⌁</span><strong>{entry.name}</strong><small>Double-click to open</small></button>)}</div>
    {error && <p className="form-error">{error}</p>}<footer><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" onClick={add}>Use this directory</button></footer>
  </section></div>;
}
