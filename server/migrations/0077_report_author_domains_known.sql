-- ============================================================================
-- §20 — a report's author_domains is the domains its queries were written
-- under, or null when that is not known (the app's own reports). An empty
-- set never meant anything: no query is kept without a domain to run as. It
-- was what 0072 filled the column with for a report whose maker had no
-- access row then, and what a save wrote for a maker it found none for;
-- read as a bound, it stopped every section of the report for every
-- recipient and every scheduled delivery. The code now reads an empty set
-- as not known and never writes one; the rows are put right the same way.
-- ============================================================================

UPDATE ai_reports SET author_domains = NULL WHERE author_domains = '{}';
