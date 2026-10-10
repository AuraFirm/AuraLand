import type { OrgRole } from "@aura/contracts/identity";

// What each organization role may do with tasks. Only decides which controls to show; the API and
// PostgreSQL decide for real.
export const canWriteTasks = (role: OrgRole): boolean =>
    role === "owner" || role === "admin" || role === "setter";
export const canReviewTasks = (role: OrgRole): boolean =>
    role === "owner" || role === "admin" || role === "reviewer";
