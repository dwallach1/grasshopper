-- Desk policies call public.is_ledger_operator(). That helper is STABLE SQL
-- over public.ledger_operators, which has RLS enabled. SECURITY INVOKER sees
-- zero rows for authenticated (no policy, or policy that itself depends on
-- this function), so exists() is always false and the signed-in operator is
-- denied. SECURITY DEFINER + empty search_path lets the check see the
-- allowlist; anon stays revoked. Already applied on xqungxapqicdmboniezz.

CREATE OR REPLACE FUNCTION public.is_ledger_operator()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.ledger_operators
    WHERE user_id = (SELECT auth.uid())
  );
$$;

REVOKE ALL ON FUNCTION public.is_ledger_operator() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_ledger_operator() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_ledger_operator() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_ledger_operator() TO service_role;

DROP POLICY IF EXISTS ledger_operators_self_select ON public.ledger_operators;
CREATE POLICY ledger_operators_self_select
  ON public.ledger_operators
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));
