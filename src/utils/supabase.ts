import { createClient } from '@supabase/supabase-js';
import type { 
  ErpCompaniesS539Dcf81BRow,
  ErpDepartmentsS539Dcf81BRow,
  ErpEmployeesS539Dcf81BRow,
  ErpCustomersS539Dcf81BRow,
  ErpSuppliersS539Dcf81BRow,
  ErpProductCategoriesS539Dcf81BRow,
  ErpProductsS539Dcf81BRow,
  ErpWarehousesS539Dcf81BRow,
  ErpBinsS539Dcf81BRow,
  ErpUomGroupsS539Dcf81BRow,
  ErpUomsS539Dcf81BRow,
  ErpProductUomsS539Dcf81BRow,
  ErpInventoryS539Dcf81BRow,
  ErpInventoryTransactionsS539Dcf81BRow,
  ErpPurchaseOrdersS539Dcf81BRow,
  ErpPurchaseOrderDetailsS539Dcf81BRow,
  ErpPurchaseReceiptsS539Dcf81BRow,
  ErpPurchaseReceiptDetailsS539Dcf81BRow,
  ErpSalesOrdersS539Dcf81BRow,
  ErpSalesOrderDetailsS539Dcf81BRow,
  ErpSalesDeliveriesS539Dcf81BRow,
  ErpSalesDeliveryDetailsS539Dcf81BRow,
  ErpAccountSubjectsS539Dcf81BRow,
  ErpAccountingPeriodsS539Dcf81BRow,
  ErpVouchersS539Dcf81BRow,
  ErpVoucherDetailsS539Dcf81BRow,
  ErpGeneralLedgerBalancesS539Dcf81BRow,
  ErpGlEntriesRow,
  ErpReceivablesS539Dcf81BRow,
  ErpPayablesS539Dcf81BRow,
  ErpAssetCategoriesS539Dcf81BRow,
  ErpFixedAssetsS539Dcf81BRow,
  ErpDepreciationRecordsS539Dcf81BRow,
  ErpCostCalculationsS539Dcf81BRow,
  ErpWorkCentersS539Dcf81BRow,
  ErpOperationsS539Dcf81BRow,
  ErpBomsS539Dcf81BRow,
  ErpBomDetailsS539Dcf81BRow,
  ErpRoutingOperationsS539Dcf81BRow,
  ErpRoutingOperationDetailsS539Dcf81BRow,
  ErpMrpPlansS539Dcf81BRow,
  ErpMrpRequirementsS539Dcf81BRow,
  ErpProductionOrdersS539Dcf81BRow,
  ErpProductionOrderDetailsS539Dcf81BRow,
  ErpMaterialIssuesS539Dcf81BRow,
  ErpMaterialIssueDetailsS539Dcf81BRow,
  ErpProductionReportsS539Dcf81BRow,
  ErpProductionReceiptsS539Dcf81BRow,
  SysFormsRow,
  SysConfigRow,
  SysInventoryTransactionTypesRow,
  SysDocumentTransactionTypesRow,
} from '../types/database';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Missing Supabase env vars: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set.',
  );
}

const REQUEST_TIMEOUT_MS = 15_000;
const WAKE_CHECK_DEBOUNCE_MS = 3_000;
const SESSION_REFRESH_THRESHOLD_MS = 60_000;

const fetchWithTimeout: typeof fetch = async (input, init) => {
  const controller = new AbortController();
  const sourceSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const abortFromSource = () => controller.abort(sourceSignal?.reason);

  if (sourceSignal?.aborted) {
    abortFromSource();
  } else {
    sourceSignal?.addEventListener('abort', abortFromSource, { once: true });
  }

  const timeoutId = window.setTimeout(() => {
    controller.abort(new DOMException(
      `Supabase request timed out after ${REQUEST_TIMEOUT_MS}ms`,
      'TimeoutError',
    ));
  }, REQUEST_TIMEOUT_MS);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
    sourceSignal?.removeEventListener('abort', abortFromSource);
  }
};

export const supabase = createClient(supabaseUrl, supabaseKey, {
  global: { fetch: fetchWithTimeout },
});

if (typeof window !== 'undefined') {
  (window as any).supabase = supabase;

  let lastWakeCheck = 0;
  let wakeCheckPromise: Promise<void> | null = null;

  const checkSessionAfterWake = () => {
    if (document.visibilityState !== 'visible') return;

    const now = Date.now();
    if (wakeCheckPromise || now - lastWakeCheck < WAKE_CHECK_DEBOUNCE_MS) return;
    lastWakeCheck = now;

    wakeCheckPromise = (async () => {
      const { data: { session }, error } = await supabase.auth.getSession();
      if (error) throw error;

      const expiresAt = session?.expires_at ? session.expires_at * 1_000 : 0;
      if (session && expiresAt - Date.now() <= SESSION_REFRESH_THRESHOLD_MS) {
        const { error: refreshError } = await supabase.auth.refreshSession();
        if (refreshError) throw refreshError;
      }
    })()
      .catch((error) => {
        console.error('Failed to restore Supabase session after page wake:', error);
      })
      .finally(() => {
        wakeCheckPromise = null;
      });
  };

  document.addEventListener('visibilitychange', checkSessionAfterWake);
  window.addEventListener('focus', checkSessionAfterWake);
}

export type Tables = {
  erp_companies_s_539dcf81_b: { Row: ErpCompaniesS539Dcf81BRow };
  erp_departments_s_539dcf81_b: { Row: ErpDepartmentsS539Dcf81BRow };
  erp_employees_s_539dcf81_b: { Row: ErpEmployeesS539Dcf81BRow };
  erp_customers_s_539dcf81_b: { Row: ErpCustomersS539Dcf81BRow };
  erp_suppliers_s_539dcf81_b: { Row: ErpSuppliersS539Dcf81BRow };
  erp_product_categories_s_539dcf81_b: { Row: ErpProductCategoriesS539Dcf81BRow };
  erp_products_s_539dcf81_b: { Row: ErpProductsS539Dcf81BRow };
  erp_warehouses_s_539dcf81_b: { Row: ErpWarehousesS539Dcf81BRow };
  erp_bins_s_539dcf81_b: { Row: ErpBinsS539Dcf81BRow };
  erp_uom_groups_s_539dcf81_b: { Row: ErpUomGroupsS539Dcf81BRow };
  erp_uoms_s_539dcf81_b: { Row: ErpUomsS539Dcf81BRow };
  erp_product_uoms_s_539dcf81_b: { Row: ErpProductUomsS539Dcf81BRow };
  erp_inventory_s_539dcf81_b: { Row: ErpInventoryS539Dcf81BRow };
  erp_inventory_transactions_s_539dcf81_b: { Row: ErpInventoryTransactionsS539Dcf81BRow };
  erp_purchase_orders_s_539dcf81_b: { Row: ErpPurchaseOrdersS539Dcf81BRow };
  erp_purchase_order_details_s_539dcf81_b: { Row: ErpPurchaseOrderDetailsS539Dcf81BRow };
  erp_purchase_receipts_s_539dcf81_b: { Row: ErpPurchaseReceiptsS539Dcf81BRow };
  erp_purchase_receipt_details_s_539dcf81_b: { Row: ErpPurchaseReceiptDetailsS539Dcf81BRow };
  erp_sales_orders_s_539dcf81_b: { Row: ErpSalesOrdersS539Dcf81BRow };
  erp_sales_order_details_s_539dcf81_b: { Row: ErpSalesOrderDetailsS539Dcf81BRow };
  erp_sales_deliveries_s_539dcf81_b: { Row: ErpSalesDeliveriesS539Dcf81BRow };
  erp_sales_delivery_details_s_539dcf81_b: { Row: ErpSalesDeliveryDetailsS539Dcf81BRow };
  erp_account_subjects_s_539dcf81_b: { Row: ErpAccountSubjectsS539Dcf81BRow };
  erp_accounting_periods_s_539dcf81_b: { Row: ErpAccountingPeriodsS539Dcf81BRow };
  erp_vouchers_s_539dcf81_b: { Row: ErpVouchersS539Dcf81BRow };
  erp_voucher_details_s_539dcf81_b: { Row: ErpVoucherDetailsS539Dcf81BRow };
  erp_general_ledger_balances_s_539dcf81_b: { Row: ErpGeneralLedgerBalancesS539Dcf81BRow };
  erp_gl_entries: { Row: ErpGlEntriesRow };
  erp_receivables_s_539dcf81_b: { Row: ErpReceivablesS539Dcf81BRow };
  erp_payables_s_539dcf81_b: { Row: ErpPayablesS539Dcf81BRow };
  erp_asset_categories_s_539dcf81_b: { Row: ErpAssetCategoriesS539Dcf81BRow };
  erp_fixed_assets_s_539dcf81_b: { Row: ErpFixedAssetsS539Dcf81BRow };
  erp_depreciation_records_s_539dcf81_b: { Row: ErpDepreciationRecordsS539Dcf81BRow };
  erp_cost_calculations_s_539dcf81_b: { Row: ErpCostCalculationsS539Dcf81BRow };
  erp_work_centers_s_539dcf81_b: { Row: ErpWorkCentersS539Dcf81BRow };
  erp_operations_s_539dcf81_b: { Row: ErpOperationsS539Dcf81BRow };
  erp_boms_s_539dcf81_b: { Row: ErpBomsS539Dcf81BRow };
  erp_bom_details_s_539dcf81_b: { Row: ErpBomDetailsS539Dcf81BRow };
  erp_routing_operations_s_539dcf81_b: { Row: ErpRoutingOperationsS539Dcf81BRow };
  erp_routing_operation_details_s_539dcf81_b: { Row: ErpRoutingOperationDetailsS539Dcf81BRow };
  erp_mrp_plans_s_539dcf81_b: { Row: ErpMrpPlansS539Dcf81BRow };
  erp_mrp_requirements_s_539dcf81_b: { Row: ErpMrpRequirementsS539Dcf81BRow };
  erp_production_orders_s_539dcf81_b: { Row: ErpProductionOrdersS539Dcf81BRow };
  erp_production_order_details_s_539dcf81_b: { Row: ErpProductionOrderDetailsS539Dcf81BRow };
  erp_material_issues_s_539dcf81_b: { Row: ErpMaterialIssuesS539Dcf81BRow };
  erp_material_issue_details_s_539dcf81_b: { Row: ErpMaterialIssueDetailsS539Dcf81BRow };
  erp_production_reports_s_539dcf81_b: { Row: ErpProductionReportsS539Dcf81BRow };
  erp_production_receipts_s_539dcf81_b: { Row: ErpProductionReceiptsS539Dcf81BRow };
  sys_forms: { Row: SysFormsRow };
  sys_config: { Row: SysConfigRow };
  sys_inventory_transaction_types: { Row: SysInventoryTransactionTypesRow };
  sys_document_transaction_types: { Row: SysDocumentTransactionTypesRow };
};

