-- 0008_reveals.sql — M9. The reveal allowance (brief §2, §9).
--
-- "How many individual names a free project may reveal. Default 0." It is the switch
-- for a later offer of 100 free names, and it is also how a founder on the free plan
-- can be given a handful of names by hand without changing their plan.
--
-- Each reveal is a row, so the allowance is a count of rows rather than a counter
-- that could drift, and "every reveal" lands in the audit log as the brief requires
-- (brief §10: "Audit log: settings changes, key events, reveals and deletions").

CREATE TABLE reveals (
  project_id  integer NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_key    integer NOT NULL,
  /*
   * Who spent it, and when. Null for a reveal made by an admin script rather than by
   * a founder in the app.
   */
  revealed_by uuid REFERENCES founder_users (id) ON DELETE SET NULL,
  revealed_at timestamptz NOT NULL DEFAULT now(),
  -- A reveal is permanent: the name has been seen, and pretending otherwise would
  -- let the allowance be spent twice on the same person.
  PRIMARY KEY (project_id, user_key),
  FOREIGN KEY (project_id, user_key) REFERENCES end_users (project_id, user_key) ON DELETE CASCADE
);

CREATE INDEX reveals_project_idx ON reveals (project_id, revealed_at DESC);

ALTER TABLE reveals ENABLE ROW LEVEL SECURITY;
ALTER TABLE reveals FORCE ROW LEVEL SECURITY;
CREATE POLICY reveals_scoped ON reveals
  USING (project_id = app_current_project_id())
  WITH CHECK (project_id = app_current_project_id());
CREATE POLICY reveals_bypass ON reveals
  USING (app_rls_bypassed()) WITH CHECK (app_rls_bypassed());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dripmetric_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dripmetric_app;
