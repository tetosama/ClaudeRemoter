// Workspace shell: project and session navigation, session creation and the chat pane.
import { useCallback, useEffect, useState } from "react";
import { DirectoryPicker } from "@/features/directory-picker";
import { ChatPanel } from "@/widgets/chat";
import { Welcome } from "./Welcome";
import { api, messageOf } from "@/shared/api/client";
import { relativeTime } from "@/shared/lib/format";
import type { AppConfigDto, ProjectDto, SessionDto } from "@shared/protocol";

// Own the workspace state: projects, sessions, selection, polling and the chat pane.
export function Workspace({ onLogout }: { onLogout: () => void }) {
  const [config, setConfig] = useState<AppConfigDto | null>(null);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [sessionsHaveMore, setSessionsHaveMore] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);

  // Reload the project list and keep the current selection when it still exists.
  const refreshProjects = useCallback(async () => {
    const values = await api<ProjectDto[]>("/api/projects");
    setProjects(values);
    setProjectId((current) => current && values.some((project) => project.id === current) ? current : values[0]?.id || null);
  }, []);

  // Load the chosen project's sessions, reconcile counters and keep a valid selection.
  const refreshSessions = useCallback(async (targetProject = projectId) => {
    if (!targetProject) { setSessions([]); setSessionsHaveMore(false); return; }
    const values = await api<SessionDto[]>(`/api/projects/${encodeURIComponent(targetProject)}/sessions?limit=60&offset=0`);
    setSessions(values);
    setSessionsHaveMore(values.length === 60);
    setProjects((current) => current.map((project) => project.id === targetProject
      ? { ...project, sessionCount: values.length < 60 ? values.length : Math.max(project.sessionCount, values.length) }
      : project));
    setSessionId((current) => current && values.some((session) => session.id === current) ? current : values[0]?.id || null);
  }, [projectId]);

  // Append the next page of sessions, skipping duplicates, when more exist.
  const loadMoreSessions = async () => {
    if (!projectId) return;
    try {
      const values = await api<SessionDto[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions?limit=60&offset=${sessions.length}`);
      setSessions((current) => [...current, ...values.filter((value) => !current.some((item) => item.id === value.id))]);
      setSessionsHaveMore(values.length === 60);
    } catch (cause) { setError(messageOf(cause)); }
  };

  useEffect(() => {
    Promise.all([api<AppConfigDto>("/api/config"), refreshProjects()])
      .then(([value]) => setConfig(value)).catch((cause) => setError(messageOf(cause)));
  }, [refreshProjects]);
  useEffect(() => {
    const timer = window.setInterval(() => refreshProjects().catch(() => undefined), 15_000);
    return () => window.clearInterval(timer);
  }, [refreshProjects]);
  useEffect(() => { refreshSessions(projectId).catch((cause) => setError(messageOf(cause))); }, [projectId]);
  useEffect(() => {
    if (!projectId) return;
    const timer = window.setInterval(() => refreshSessions(projectId).catch(() => undefined), 15_000);
    return () => window.clearInterval(timer);
  }, [projectId, refreshSessions]);

  const selectedProject = projects.find((project) => project.id === projectId) || null;
  const selectedSession = sessions.find((session) => session.id === sessionId) || null;

  // Create a session in the selected project with the default model settings.
  const createSession = async () => {
    if (!config || !projectId || !config.models[0]) return;
    try {
      const created = await api<SessionDto>("/api/sessions", {
        method: "POST", body: JSON.stringify({
          projectId, model: config.models[0], permissionMode: "default", effortLevel: "default",
        }),
      });
      setSessions((current) => [created, ...current]);
      setProjects((current) => current.map((project) => project.id === projectId
        ? { ...project, sessionCount: project.sessionCount + 1 }
        : project));
      setSessionId(created.id);
      setMobileNav(false);
    } catch (cause) { setError(messageOf(cause)); }
  };

  // Replace one session in the list with its updated version.
  const updateSession = (value: SessionDto) => {
    setSessions((current) => current.map((session) => session.id === value.id ? value : session));
  };

  // Switch the selected project and clear the previous session selection.
  const selectProject = (id: string) => { setProjectId(id); setSessionId(null); };

  // End the authenticated session on the backend and return to the login screen.
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    onLogout();
  };

  return (
    <main className="app-shell">
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <div className="sidebar-head">
          <div className="brand-row"><div className="brand-mark small">C</div><span>REMOTER</span></div>
          <button className="icon-button mobile-only" onClick={() => setMobileNav(false)} aria-label="Close navigation">×</button>
        </div>
        <button className="new-session" onClick={createSession} disabled={!projectId}>＋ New session</button>
        <nav className="project-nav" aria-label="Projects and sessions">
          <div className="section-label"><span>Projects</span><button onClick={() => setDirectoryOpen(true)} aria-label="Add project">＋</button></div>
          {projects.map((project) => (
            <div key={project.id} className="project-group">
              <button className={`project-button ${project.id === projectId ? "active" : ""}`} onClick={() => selectProject(project.id)}>
                <span className="folder-icon">⌁</span><span className="project-name">{project.name}</span>
                <span className="count">{project.sessionCount}</span>
              </button>
              {project.id === projectId && <div className="session-list">
                {sessions.map((session) => (
                  <button key={session.id} className={`session-row ${session.id === sessionId ? "active" : ""}`}
                    onClick={() => { setSessionId(session.id); setMobileNav(false); }}>
                    <span className={`session-state ${session.state}`} />
                    <span><strong>{session.title}</strong><small>{relativeTime(session.updatedAt)}</small></span>
                  </button>
                ))}
                {!sessions.length && <p className="empty-small">No sessions in this project yet</p>}
                {sessionsHaveMore && <button className="load-more-sessions" onClick={loadMoreSessions}>Load more sessions</button>}
              </div>}
            </div>
          ))}
          {!projects.length && <p className="empty-small">Add a project directory to get started.</p>}
        </nav>
        <div className="sidebar-footer">
          <button onClick={logout}>Sign out</button><span>{config?.localHostname || "Local Mac"}</span>
        </div>
      </aside>
      {mobileNav && <button className="nav-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}

      <section className="main-pane">
        <header className="mobile-bar"><button className="icon-button" onClick={() => setMobileNav(true)} aria-label="Open navigation">☰</button>
          <span>{selectedSession?.title || "Claude Remoter"}</span></header>
        {error && <div className="global-error"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
        {selectedSession && config && selectedProject ? (
          <ChatPanel key={selectedSession.id} session={selectedSession} project={selectedProject} config={config}
            onSessionUpdate={updateSession} onRefreshSessions={() => refreshSessions(projectId)}
            onFork={(fork) => {
              setSessions((current) => [fork, ...current]); setSessionId(fork.id);
              setProjects((current) => current.map((item) => item.id === projectId
                ? { ...item, sessionCount: item.sessionCount + 1 }
                : item));
            }} />
        ) : <Welcome project={selectedProject} onCreate={createSession} onAddProject={() => setDirectoryOpen(true)} />}
      </section>
      {directoryOpen && <DirectoryPicker onClose={() => setDirectoryOpen(false)} onAdded={async (project) => {
        setDirectoryOpen(false); await refreshProjects(); setProjectId(project.id);
      }} />}
    </main>
  );
}
