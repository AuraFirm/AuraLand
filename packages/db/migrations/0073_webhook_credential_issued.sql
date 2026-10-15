-- The event `credential.issued` (Stage 9, cutlist F82): when a credential is issued, the organization that hosted the event hears
-- about it. The payload names the credential, its kind and assurance level and when it was issued, and NOTHING that identifies the
-- holder: a credential names no person (Passport, ADR 0033), and a webhook must not be a way around that.
create function webhook_from_credential() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
begin
    perform enqueue_webhook_event(new.issuer_org_id, 'credential.issued', new.id, jsonb_build_object(
        'credential_id', 'crd_' || new.id::text, 'kind', new.kind, 'assurance_level', new.assurance_level,
        'issued_at', new.issued_at), new.issued_at);
    return new;
end
$$;
create trigger webhook_from_credential after insert on credentials for each row execute function webhook_from_credential();
