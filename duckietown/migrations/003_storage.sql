-- 003_storage.sql
-- Run this third in Supabase SQL Editor

-- CREATE THE DUCKIETOWN BUCKET --

-- Private bucket — no public access.
-- Files are stored at: duckietown/{user_id}/{filename}

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'duckietown',
    'duckietown',
    false,        -- private bucket
    5368709120,   -- 5GB file limit
    NULL          -- allow all mime types
)
ON CONFLICT (id) DO NOTHING;

-- STORAGE RLS POLICIES --

-- Files are namespaced by user_id as the first folder segment.
-- Path structure: duckietown/{user_id}/{filename}
-- This ensures users can only access their own folder.

-- Users can upload to their own folder
CREATE POLICY "storage: insert own"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'duckietown'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Users can read from their own folder
CREATE POLICY "storage: select own"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'duckietown'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Users can update files in their own folder
CREATE POLICY "storage: update own"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'duckietown'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Users can delete files in their own folder
CREATE POLICY "storage: delete own"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'duckietown'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
