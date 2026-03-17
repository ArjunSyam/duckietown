-- 002_rls_policies.sql
-- Run this second in Supabase SQL Editor

-- ENABLE RLS ON ALL TABLES --

ALTER TABLE profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE files           ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_embeddings ENABLE ROW LEVEL SECURITY;

-- PROFILE POLICIES --

-- Users can read their own profile
CREATE POLICY "profiles: select own"
    ON profiles FOR SELECT
    USING (id = auth.uid());

-- Users can insert their own profile (used by trigger)
CREATE POLICY "profiles: insert own"
    ON profiles FOR INSERT
    WITH CHECK (id = auth.uid());

-- Users can update their own profile
CREATE POLICY "profiles: update own"
    ON profiles FOR UPDATE
    USING (id = auth.uid());

-- Users can delete their own profile
CREATE POLICY "profiles: delete own"
    ON profiles FOR DELETE
    USING (id = auth.uid());

-- FILE POLICIES --

-- Users can only see their own file records
CREATE POLICY "files: select own"
  ON files FOR SELECT
  USING (user_id = auth.uid());

-- Users can only insert file records for themselves
CREATE POLICY "files: insert own"
  ON files FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Users can only update their own file records
CREATE POLICY "files: update own"
  ON files FOR UPDATE
  USING (user_id = auth.uid());

-- Users can only delete their own file records
CREATE POLICY "files: delete own"
  ON files FOR DELETE
  USING (user_id = auth.uid());

-- FILE EMBEDDINGS POLICIES --

-- Users can only see their own embeddings
CREATE POLICY "embeddings: select own"
    ON file_embeddings FOR SELECT
    USING (user_id = auth.uid());

-- Users can only insert embeddings for themselves
CREATE POLICY "embeddings: insert own"
    ON file_embeddings FOR INSERT
    WITH CHECK (user_id = auth.uid());

-- Users can only delete their own embeddings
CREATE POLICY "embeddings: delete own"
    ON file_embeddings FOR DELETE
    USING (user_id = auth.uid());
