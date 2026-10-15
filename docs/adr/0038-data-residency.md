# 0038 — Data residency (Stage 9, slice 11)
Status: accepted (design; one region exists)
Date: 2026-10-15   Deciders: engineer under the owner's delegation

## Context
`orgs.data_region` (`eu`, `us`, `ap`) has existed since Stage 1. Kit 05 wants it to route storage buckets now and a database split
later. There is one deployment region (none yet, in fact: no cloud account, F1), so nothing can be proven about residency.

## Decision
1. **Object storage**: `RegionalStorage` (`apps/api/src/platform/regional-storage.ts`) maps a region to its own `ObjectStorage`. A region
   with no storage is an error (`RegionNotConfiguredError`); there is **no fall-back** to another region, because a residency promise
   that quietly degrades is worse than an error.
2. **No call site is switched.** Every module still uses the one configured storage. Switching them is a change per module
   (bundles, uploads, Passport documents) that is worth doing with a second region to test against, not before.
3. **Database**: not split. Design for later: one database per region holding that region's organizations; identity (users, sessions)
   is the hard part because a person can belong to organizations in several regions, so identity stays in the home region and other
   regions hold references. This needs its own ADR when a customer requires it.
4. Judge nodes and Tier-2 environments run where the control plane sends them; residency of **compute** is not addressed.

## Alternatives considered
Falling back to the default region (rejected: silent violation). Routing in each module now (rejected: untestable with one region).

## Consequences
The primitive and its failure mode are tested; the promise itself is not yet made to anyone. Do not say "EU data residency" to a
customer until storage is switched and a second region exists.

## Verification
`regional-storage.test.ts`: routing, no fall-back, regions kept apart.

## Revisit trigger
A cloud account with two regions, or a customer contract that names a region.
