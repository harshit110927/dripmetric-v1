-- 0006_intent.sql — M7. The intent engine's stored state (brief §8.2).
--
-- "Store the facts the score needs so it can be recomputed." The score itself is not
-- stored: it is computed from these facts and `now`, because it decays (CLAUDE.md
-- rules 9 and 10). What IS stored is the peak, which cannot be recovered from facts
-- alone — it is the highest the score ever reached, and nothing in the present says
-- when that was.

-- ---------------------------------------------------------------------------
-- Per-project configuration (brief §4 `intent_config`).
--
-- "Per project: points table, thresholds, versions. Editable; calibration suggests
-- changes." A project with no row uses the engine's defaults, so the common case
-- costs nothing and a founder who never touches the weights has no row at all.
-- ---------------------------------------------------------------------------
CREATE TABLE intent_config (
  project_id  integer PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  -- Overrides, as {signalKey: points}. Empty means "the engine's table".
  points      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Band cuts and the pricing attention bar, same shape as the engine's defaults.
  thresholds  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Bumped on every change, so a stored score can say which weights produced it.
  version     integer NOT NULL DEFAULT 1,
  -- The last calibration run: what it found and what it suggested. Never applied
  -- automatically (brief §8.2).
  calibration jsonb,
  calibrated_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Per-user intent state (brief §4 `intent_state`).
--
-- "Per user: the facts the score needs, base points, peak score, `peak_at`,
-- `first_high_at`, `last_event_at`, price-objection flag."
--
-- Explicit columns rather than one JSONB blob, because every one of these is
-- something a sweep has to filter or count on: "how many warm users does this project
-- have" must be an index scan, not a scan of a million documents.
-- ---------------------------------------------------------------------------
CREATE TABLE intent_state (
  project_id  integer NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_key    integer NOT NULL,

  -- The decay term's input: `d` in S_now = min(100, Σ p_i) × 2^(−d/7).
  last_event_at timestamptz,

  -- The points table's rows, one column each. A shared row is one column, which is
  -- what makes "counted once (shared)" impossible to get wrong (brief §8.2).
  checkout_started      boolean NOT NULL DEFAULT false,
  activated             boolean NOT NULL DEFAULT false,
  plan_limit_or_paywall boolean NOT NULL DEFAULT false,
  pricing_viewed        boolean NOT NULL DEFAULT false,
  pricing_deliberation  boolean NOT NULL DEFAULT false,
  invite_sent           boolean NOT NULL DEFAULT false,
  integration_or_import boolean NOT NULL DEFAULT false,
  core_action_early     boolean NOT NULL DEFAULT false,
  active_three_of_seven boolean NOT NULL DEFAULT false,
  fast_activation       boolean NOT NULL DEFAULT false,
  payment_method_before_trial_end boolean NOT NULL DEFAULT false,
  sales_contact_requested boolean NOT NULL DEFAULT false,
  disposable_email      boolean NOT NULL DEFAULT false,

  -- The fit points that are true, as {workEmail: true, …}. Capped at 10 by the
  -- engine, not here: the cap is a rule, and rules live in the engine.
  fit         jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Three or more upgrade-prompt dismissals. "A different problem, not lower
  -- intent", so it is carried beside the score and never inside it.
  price_objection boolean NOT NULL DEFAULT false,

  -- min(100, Σ p_i) at the last refresh, before decay. Stored so a sweep can find
  -- "everyone who could still be high" without rescoring every user.
  base_points integer NOT NULL DEFAULT 0,

  -- The peak, which drives "intent but didn't pay" (brief §8.2). It never decays:
  -- someone who reached 85 and went quiet has not become uninterested, they have
  -- become a leak.
  peak_score  integer NOT NULL DEFAULT 0,
  peak_at     timestamptz,
  -- The first crossing of 60. The clock "intent but didn't pay" counts from, so it
  -- is the FIRST one and is never moved by a later, higher peak.
  first_high_at timestamptz,

  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_key),
  FOREIGN KEY (project_id, user_key) REFERENCES end_users (project_id, user_key) ON DELETE CASCADE
);

-- "How many high-intent users didn't pay" is the headline number of the whole
-- product, and it is a filter on these two columns.
CREATE INDEX intent_state_high_idx ON intent_state (project_id, first_high_at)
  WHERE first_high_at IS NOT NULL;
CREATE INDEX intent_state_peak_idx ON intent_state (project_id, peak_score DESC);

-- ---------------------------------------------------------------------------
-- Row-level security, same rules as everywhere else.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intent_config', 'intent_state'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (project_id = app_current_project_id()) WITH CHECK (project_id = app_current_project_id())',
      t || '_scoped', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app_rls_bypassed()) WITH CHECK (app_rls_bypassed())',
      t || '_bypass', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dripmetric_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dripmetric_app;
