-- Migration 0011: time a reviewer spent on a card (exit criterion "median < 30 s per card"), measured in the
-- browser from opening the card to the decision. Bulk approvals and API calls leave it NULL.
SET search_path = abcrm, public;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS review_ms int CHECK (review_ms BETWEEN 0 AND 3600000);
