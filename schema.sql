-- ══════════════════════════════════════════════
-- PixelShot — Supabase Database Schema
-- Run this in: Supabase Dashboard → SQL Editor
-- ══════════════════════════════════════════════

-- Jobs table: tracks every headshot order
CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  plan            TEXT NOT NULL CHECK (plan IN ('starter', 'value', 'pro')),
  style           TEXT NOT NULL DEFAULT 'professional',
  status          TEXT NOT NULL DEFAULT 'pending_payment'
                  CHECK (status IN ('pending_payment', 'paid', 'processing', 'complete', 'failed', 'refunded')),

  -- Stripe
  stripe_session_id TEXT,

  -- Astria AI
  astria_tune_id  TEXT,
  astria_prompt_id TEXT,

  -- File references
  photo_urls      TEXT[],       -- temp S3 URLs of uploaded selfies
  result_urls     TEXT[],       -- final generated headshot URLs

  -- Error info
  error           TEXT,

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_at     TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

-- Index for fast lookups by email (for support queries)
CREATE INDEX idx_jobs_email ON jobs (email);
CREATE INDEX idx_jobs_status ON jobs (status);

-- Optional: Row Level Security (disable public access)
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

-- Only the service role (backend) can read/write
CREATE POLICY "Service role only" ON jobs
  USING (auth.role() = 'service_role');

-- ── Useful queries ───────────────────────────────────────────

-- Check all jobs today
-- SELECT id, email, plan, status, created_at FROM jobs WHERE created_at > NOW() - INTERVAL '1 day' ORDER BY created_at DESC;

-- Revenue summary
-- SELECT plan, COUNT(*) as orders, COUNT(*) * CASE plan WHEN 'starter' THEN 9.99 WHEN 'value' THEN 12.98 WHEN 'pro' THEN 15.96 END as revenue FROM jobs WHERE status IN ('complete','processing') GROUP BY plan;

-- Failed jobs needing attention
-- SELECT id, email, error, created_at FROM jobs WHERE status = 'failed' ORDER BY created_at DESC;
