// Empty-state prompt that invites the user to create a session or add a project.
import type { ProjectDto } from "@shared/protocol";

// Invite the user to create a session or, without a project, to add one first.
export function Welcome({ project, onCreate, onAddProject }: { project: ProjectDto | null; onCreate: () => void; onAddProject: () => void }) {
  return <div className="welcome"><div className="welcome-symbol">⌘</div><p className="eyebrow">LOCAL CLAUDE CODE</p><h1>{project ? `Start in ${project.name}` : "Bring Claude Code to any screen"}</h1>
    <p>{project ? "Create a session, or continue an existing conversation from the sidebar." : "Pick a project directory on this Mac first; past sessions are grouped automatically."}</p>
    <button className="primary" onClick={project ? onCreate : onAddProject}>{project ? "New session" : "Add project directory"}</button></div>;
}
