-- Baseline: extensions the whole schema relies on. citext gives case-insensitive handles and
-- slugs (docs/kit/05 section 5). Tables arrive with the stage that owns them.
create extension if not exists citext;
