-- The setter and reviewer roles (migration 0012) become usable. Owners can invite people into them
-- and give them to existing members; admins can remove them, since they hold no organization power.
-- Only owners change roles (unchanged), and admins still invite plain members only.

alter table org_invitations drop constraint org_invitations_role;
alter table org_invitations add constraint org_invitations_role
    check (role in ('admin', 'setter', 'reviewer', 'member'));

drop policy org_invitations_manage_insert on org_invitations;
create policy org_invitations_manage_insert on org_invitations for insert to aura_app
    with check (invited_by = nullif(current_setting('app.user_id', true), '')::uuid
                and ((role = 'member' and app_org_role(org_id) in ('owner', 'admin'))
                     or (role in ('admin', 'setter', 'reviewer') and app_org_role(org_id) = 'owner')));

drop policy memberships_remove on memberships;
create policy memberships_remove on memberships for delete to aura_app
    using (user_id = nullif(current_setting('app.user_id', true), '')::uuid
           or app_org_role(org_id) = 'owner'
           or (app_org_role(org_id) = 'admin' and role in ('member', 'setter', 'reviewer')));
