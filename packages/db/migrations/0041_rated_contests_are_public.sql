-- A rated contest is public (Stage 5, slice 10). A rating history names its contests and ranks, and a
-- public profile shows that history to anyone; a private or unlisted contest would leak through it.
alter table contests add constraint contests_rated_public check (not rated or visibility = 'public');
