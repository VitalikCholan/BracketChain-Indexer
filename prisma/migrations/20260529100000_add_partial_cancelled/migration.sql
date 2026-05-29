-- Stage E (E-1): mid-tournament cancellation status. Appended enum value
-- (disc 5 on-chain) — additive, no existing row uses it.
ALTER TYPE "TournamentStatus" ADD VALUE 'PartialCancelled';
