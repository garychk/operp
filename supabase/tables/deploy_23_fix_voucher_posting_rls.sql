-- Allow trusted voucher posting RPCs to write the ledger atomically.
-- The RPCs still validate voucher balance, accounting period, and idempotency.

ALTER FUNCTION public.post_voucher_document(INTEGER, UUID) SECURITY DEFINER;
ALTER FUNCTION public.reverse_voucher_document(INTEGER, UUID) SECURITY DEFINER;

ALTER FUNCTION public.post_voucher_document(INTEGER, UUID)
  SET search_path = public;
ALTER FUNCTION public.reverse_voucher_document(INTEGER, UUID)
  SET search_path = public;

REVOKE ALL ON FUNCTION public.post_voucher_document(INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reverse_voucher_document(INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_voucher_document(INTEGER, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_voucher_document(INTEGER, UUID) TO authenticated;
