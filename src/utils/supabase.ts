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
} from '../types/database';

// const supabaseUrl = 'https://spb-8vb5nhr43wo8yt73.supabase.opentrust.net';
// const supabaseKey = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiIsInJlZiI6InNwYi04dmI1bmhyNDN3bzh5dDczIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3NzM3NzE4ODgsImV4cCI6MjA4OTM0Nzg4OH0.6P3g6CWOqwg0nZead9La_20uOe_3rXKLj78y7L0p5bU';
// remote
// const supabaseUrl = 'https://fzcjguglarborefokgko.supabase.co';
// const supabaseKey = 'sb_publishable_DHNldTEniWrIO-sqJyUD_A_QToqSrRI';
// local
const supabaseUrl = 'http://localhost:8008';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE';

export let supabase = createClient(supabaseUrl, supabaseKey);
(window as any).supabase = supabase;

const recreateSupabaseClient = () => {
  supabase = createClient(supabaseUrl, supabaseKey);
  (window as any).supabase = supabase;
};

if (typeof window !== 'undefined') {
  let lastVisibilityChange = 0;
  
  const handleVisibilityChange = async () => {
    if (document.visibilityState === 'visible') {
      const now = Date.now();
      const timeSinceLastChange = now - lastVisibilityChange;
      lastVisibilityChange = now;
      
      if (timeSinceLastChange > 3000) {
        recreateSupabaseClient();
      } else {
        await supabase.auth.getSession();
      }
    }
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', handleVisibilityChange);
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
};
