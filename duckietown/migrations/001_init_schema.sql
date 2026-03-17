--001_init_schema.sql
--Run this first in Supabase SQL Editor

--Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- PROFILES --
-- Extends Supabase auth.users with extra fields.
-- A row is auto-created here when a user signs up via trigger.


CREATE TABLE IF NOT EXISTS profiles (
    id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username        TEXT,
    email           TEXT UNIQUE NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- FILES --
-- Metadata for every file stored in the bucket.
-- storage_path = "{user_id}/{filename}" matching the bucket folder structure.

CREATE TABLE IF NOT EXISTS files (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    size            BIGINT DEFAULT 0,
    mime_type       TEXT DEFAULT 'application/octet-stream',
    storage_path    TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, name)
);

-- Trigger to Auto-update updated_at on row channge
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE TRIGGER files_updated_at
    BEFORE UPDATE ON files
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- FILE EMBEDDINGS --

-- Vector embeddings for AI semantic search.
-- One file can have multiple rows (one per chunk).

CREATE TABLE IF NOT EXISTS file_embeddings (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id      UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    embedding    vector(1536),
    chunk_text   TEXT,
    chunk_index  INTEGER DEFAULT 0,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS file_embeddings_vector_idx
    ON file_embeddings
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Index for fast lookup by file
CREATE INDEX IF NOT EXISTS file_embeddings_file_idx
    ON file_embeddings (file_id);

-- Index for fast lookup by user
CREATE INDEX IF NOT EXISTS file_embeddings_user_idx
    ON file_embeddings (user_id);

-- AUTO-CREATE PROFILE ON SIGNUP --

-- When a user signs up via Supabase Auth, automatically
-- insert a row into profiles so foreign keys work.

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO profiles (id, email)
    VALUES (NEW.id, NEW.email)
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();
