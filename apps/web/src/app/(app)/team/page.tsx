import { PageHeading } from "@/components/PageHeading";
import { api, me } from "@/lib/api";
import type { TeamMember } from "@/lib/types";
import { Action } from "@/components/Action";
import { InviteForm } from "@/components/InviteForm";
import { ProfileForm } from "@/components/ProfileForm";
import { RoleSelect } from "@/components/RoleSelect";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = { active: "", invited: "warn", disabled: "bad" };

export default async function Team() {
  const user = await me();
  const canManage = ["owner", "admin"].includes(user.role);
  const team = await api<{ data: TeamMember[] }>(canManage ? "/users?all=true" : "/users");
  const isOwner = user.role === "owner";
  return (
    <>
      <PageHeading title="Team" eyebrow="PEOPLE & ACCESS" description="Manage your profile, teammates and workspace permissions." />
      {user.user && (
        <section className="card" aria-label="Your profile">
          <h2 style={{ marginTop: 0 }}>Your profile</h2>
          <p className="small muted">Card due times and the morning digest follow your timezone and working hours.</p>
          <ProfileForm user={user.user} />
        </section>
      )}
      {canManage && (
        <section className="card" aria-label="Invite">
          <h2 style={{ marginTop: 0 }}>Create internal account</h2>
          <InviteForm canInviteOwner={isOwner} />
        </section>
      )}
      <section className="card" aria-label="Members">
        <div className="table-scroll" role="region" aria-label="Team members" tabIndex={0}><table>
          <thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Timezone</th>{canManage && <th></th>}</tr></thead>
          <tbody>{team.data.map((m) => {
            const self = m.id === user.actor.id;
            const label = m.name ?? m.email;
            const editable = canManage && !self && (isOwner || m.role !== "owner");
            return (
              <tr key={m.id}>
                <td>{m.name ?? "—"}{self && <span className="muted small"> (you)</span>}<div className="muted small">{m.email}</div></td>
                <td>{editable && m.status !== "disabled" ? <RoleSelect userId={m.id} role={m.role} label={label} allowOwner={isOwner} /> : m.role.replace(/_/g, " ")}</td>
                <td><span className={`badge ${STATUS_BADGE[m.status] ?? ""}`}>{m.status}</span></td>
                <td className="small">{m.timezone}</td>
                {canManage && (
                  <td>{editable && (
                    <span className="row">
                      {m.status === "invited" && <span className="small muted">Ask the server administrator to set a password.</span>}
                      {m.status === "disabled"
                        ? <Action path={`/users/${m.id}`} method="PATCH" body={{ status: "active" }}>Enable</Action>
                        : <Action className="danger" path={`/users/${m.id}`} method="DELETE"
                          confirm={`Disable ${label}? They are signed out at once and their pending cards go to other reviewers.`}>
                          {m.status === "invited" ? "Revoke invite" : "Disable"}</Action>}
                    </span>
                  )}</td>
                )}
              </tr>
            );
          })}</tbody>
        </table></div>
      </section>
    </>
  );
}
