-- ═══════════════════════════════════════════════════════════════════════════
-- Messaging realtime: broadcast message INSERTs so threads update live.
--
-- PROPOSED — pause for approval before applying. Additive + idempotent.
--
-- public.messages was never added to the supabase_realtime publication, so the
-- postgres_changes subscriptions in messaging.js connect but receive nothing —
-- a sent message only surfaces on an incidental re-fetch (the ~1-minute felt
-- lag). This adds the table to the publication so INSERTs are broadcast live.
--
-- We deliberately do NOT set REPLICA IDENTITY FULL: INSERT payloads carry the
-- full NEW row by default, which is all the messaging client consumes. REPLICA
-- IDENTITY FULL only adds OLD-row data for UPDATE/DELETE, which we don't use.
--
-- PAIRED CLIENT CHANGE — MUST SHIP TOGETHER: _subscribeGlobal() in
-- src/panels/messaging.js is now scoped server-side to
-- conversation_id=in.(the user's own conversations). RLS is OFF on messages
-- (client-gated, per project policy), so WITHOUT that filter this publication
-- change would stream every parish's message bodies to every connected client
-- over the realtime socket. Do NOT apply this migration unless that scoped
-- subscription is in place (see commit shipping this file).
--
-- No RLS-disable / REVOKE step: messages already has RLS off and this only
-- alters a publication — it does not create a table.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname    = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename  = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;
END $$;
