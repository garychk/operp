-- Add source document fields to payables for traceability and reversal safety.
ALTER TABLE public.erp_payables_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS source_id INTEGER,
  ADD COLUMN IF NOT EXISTS source_no VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_erp_payables_source
  ON public.erp_payables_s_539dcf81_b(source_type, source_id)
  WHERE is_deleted = 'n';
