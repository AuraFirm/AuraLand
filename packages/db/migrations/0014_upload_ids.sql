-- The API picks an upload's id and creation time itself (from its injected clock), so the storage key (uploads/<org>/<id>) can be derived before
-- the row exists and the storage-side upload can be started first; a row never points at nothing.
grant insert (id, created_at) on bundle_uploads to aura_app;
