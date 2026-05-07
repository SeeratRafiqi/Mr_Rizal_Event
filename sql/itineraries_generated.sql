-- Optional storage for Trip Planner generations (run once in Supabase SQL editor).
-- Does not modify existing tables.

CREATE TABLE IF NOT EXISTS public.itineraries_generated (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_id TEXT,
  arrival_date DATE NOT NULL,
  departure_date DATE NOT NULL,
  city TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS itineraries_generated_created_at
  ON public.itineraries_generated (created_at DESC);

COMMENT ON TABLE public.itineraries_generated IS 'Trip Planner saves from POST /api/itinerary/save; listed by GET /api/itinerary/history';
