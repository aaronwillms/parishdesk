-- Add visible_to column to announcements
-- null = visible to all; uuid[] = visible only to those teams
ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS visible_to uuid[] DEFAULT NULL;
