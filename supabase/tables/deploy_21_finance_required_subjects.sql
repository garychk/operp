-- Required subjects for depreciation and AR/AP settlement.
-- Safe to run repeatedly: account codes are unique and existing rows are updated.

INSERT INTO public.erp_account_subjects_s_539dcf81_b (
  corp_id,
  emp_id,
  is_deleted,
  code,
  name,
  level,
  category,
  direction,
  is_cash_account,
  is_bank_account,
  status
)
VALUES
  (NULL, NULL, 'n', '1001', '库存现金', 1, 'asset', 'debit', TRUE, FALSE, 'active'),
  (NULL, NULL, 'n', '1002', '银行存款', 1, 'asset', 'debit', TRUE, TRUE, 'active'),
  (NULL, NULL, 'n', '1122', '应收账款', 1, 'asset', 'debit', FALSE, FALSE, 'active'),
  (NULL, NULL, 'n', '1602', '累计折旧', 1, 'asset', 'credit', FALSE, FALSE, 'active'),
  (NULL, NULL, 'n', '2202', '应付账款', 1, 'liability', 'credit', FALSE, FALSE, 'active'),
  (NULL, NULL, 'n', '6601', '销售费用', 1, 'expense', 'debit', FALSE, FALSE, 'active'),
  (NULL, NULL, 'n', '6602', '管理费用', 1, 'expense', 'debit', FALSE, FALSE, 'active')
ON CONFLICT (code) DO UPDATE SET
  is_deleted = 'n',
  category = EXCLUDED.category,
  direction = EXCLUDED.direction,
  is_cash_account = EXCLUDED.is_cash_account,
  is_bank_account = EXCLUDED.is_bank_account,
  status = 'active',
  updated_at = NOW();
