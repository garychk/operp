import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { ProLayout } from './components/ProLayout';
import { Login } from './pages/Login';
import Terms from './pages/legal/Terms';
import Privacy from './pages/legal/Privacy';
import { DocsSite } from './pages/docs/DocsSite';
import { Dashboard } from './pages/Dashboard';
import { Workbench } from './pages/Workbench';
import { AccountSubjects } from './pages/finance/AccountSubjects';
import { Vouchers } from './pages/finance/Vouchers';
import { GeneralLedgerBalance } from './pages/finance/GeneralLedgerBalance';
import { TrialBalance } from './pages/finance/TrialBalance';
import { SubjectLedger } from './pages/finance/SubjectLedger';
import { AccountingPeriods } from './pages/finance/AccountingPeriods';
import { Receivables } from './pages/finance/Receivables';
import { Payables } from './pages/finance/Payables';
import { FixedAssets } from './pages/finance/FixedAssets';
import { AssetCategories } from './pages/finance/AssetCategories';
import { Customers } from './pages/inventory/Customers';
import { Suppliers } from './pages/inventory/Suppliers';
import { Products } from './pages/inventory/Products';
import { Warehouses } from './pages/inventory/Warehouses';
import { Uoms } from './pages/system/Uoms';
import { Currencies } from './pages/system/Currencies';
import { Inventory } from './pages/inventory/Inventory';
import { PurchaseOrders } from './pages/inventory/PurchaseOrders';
import { SalesOrders } from './pages/inventory/SalesOrders';
import { PurchaseReceipts } from './pages/inventory/PurchaseReceipts';
import { PurchaseReturns } from './pages/inventory/PurchaseReturns';
import { SalesDeliveries } from './pages/inventory/SalesDeliveries';
import { SalesReturns } from './pages/inventory/SalesReturns';
import { InventoryTransfers } from './pages/inventory/InventoryTransfers';
import { StockCounts } from './pages/inventory/StockCounts';
import { StockAdjustments } from './pages/inventory/StockAdjustments';
import { OtherStockDocuments } from './pages/inventory/OtherStockDocuments';
import { OpeningBalances } from './pages/inventory/OpeningBalances';
import { Batches } from './pages/inventory/Batches';
import { BatchTrace } from './pages/inventory/BatchTrace';
import { InventoryTransactions } from './pages/inventory/InventoryTransactions';
import { InventoryReports } from './pages/inventory/InventoryReports';
import { InventoryReconciliation } from './pages/inventory/InventoryReconciliation';
import { InventorySubjectMap } from './pages/inventory/InventorySubjectMap';
import { Boms } from './pages/mrp/Boms';
import { Departments } from './pages/mrp/Departments';
import { Employees } from './pages/mrp/Employees';
import { RoutingOperations } from './pages/mrp/RoutingOperations';
import { WorkCenters } from './pages/mrp/WorkCenters';
import { Operations } from './pages/mrp/Operations';
import { ProductionOrders } from './pages/mrp/ProductionOrders';
import { MaterialIssues } from './pages/mrp/MaterialIssues';
import { MaterialReturns } from './pages/mrp/MaterialReturns';
import { ProductionReceipts } from './pages/mrp/ProductionReceipts';
import { ProductionReports } from './pages/mrp/ProductionReports';
import { CostCalculations } from './pages/mrp/CostCalculations';
import { MrpPlans } from './pages/mrp/MrpPlans';
import { MpsPlans } from './pages/mrp/MpsPlans';
import { QualityInspections } from './pages/mrp/QualityInspections';
import { SubcontractOrders } from './pages/mrp/SubcontractOrders';
import { SubcontractIssues } from './pages/mrp/SubcontractIssues';
import { SubcontractReceipts } from './pages/mrp/SubcontractReceipts';
import { SubcontractSettlements } from './pages/mrp/SubcontractSettlements';
import { ProductionAnalytics } from './pages/mrp/ProductionAnalytics';
// P0-4（deploy_114）MRP 计划参数与工作日历
import { PlanningParams } from './pages/mrp/PlanningParams';
import { WorkCalendars } from './pages/mrp/WorkCalendars';
// 排班地基 Step 1（deploy_119）班次主档
import { Shifts } from './pages/mrp/Shifts';
import { Users } from './pages/system/Users';
import { Tenants } from './pages/system/Tenants';
import { Roles } from './pages/system/Roles';
import { Menus } from './pages/system/Menus';
import { Logs } from './pages/system/Logs';
import { Settings } from './pages/system/Settings';
import { Dictionaries } from './pages/system/Dictionaries';
import { WorkflowConfig } from './pages/system/WorkflowConfig';
import { DocFlowConfig } from './pages/system/DocFlowConfig';
import { DocumentTypeBuilder } from './pages/system/DocumentTypeBuilder';
import { KnowledgeBase } from './pages/system/KnowledgeBase';
import { PageDesigner } from './features/page-builder/PageDesigner';
import { CustomPageRenderer } from './features/page-builder/PageRenderer';
import { BaqDesigner } from './features/baq/BaqDesigner';
import { ConfigProvider } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/en';
import 'dayjs/locale/zh-cn';
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

function LocaleProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  const isEnglish = i18n.resolvedLanguage === 'en-US';

  useEffect(() => {
    dayjs.locale(isEnglish ? 'en' : 'zh-cn');
  }, [isEnglish]);

  return <ConfigProvider locale={isEnglish ? enUS : zhCN}>{children}</ConfigProvider>;
}

function AppContent() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* 法务静态页：与登录页同级，不套 ProtectedRoute，未登录可直接访问 */}
      <Route path="/terms" element={<Terms />} />
      <Route path="/privacy" element={<Privacy />} />
      {/* 产品使用手册（公开静态文档页，无需登录；支持 /docs#锚点 直达章节） */}
      <Route path="/docs" element={<DocsSite />} />
      
      <Route 
        path="/" 
        element={
          <ProtectedRoute>
            <ProLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />

        {/* 个人工作台：不挂在业务菜单下，任何登录用户都可访问（见 MenuPermissionGuard） */}
        <Route path="workbench" element={<Workbench />} />
        
        <Route path="finance">
          <Route index element={<Navigate to="subjects" replace />} />
          <Route path="subjects" element={<AccountSubjects />} />
          <Route path="vouchers" element={<Vouchers />} />
          <Route path="gl-balance" element={<GeneralLedgerBalance />} />
          <Route path="trial-balance" element={<TrialBalance />} />
          <Route path="ledger" element={<SubjectLedger />} />
          <Route path="periods" element={<AccountingPeriods />} />
          <Route path="receivables" element={<Receivables />} />
          <Route path="payables" element={<Payables />} />
          <Route path="assets" element={<FixedAssets />} />
          <Route path="asset-categories" element={<AssetCategories />} />
        </Route>
        
        <Route path="inventory" >
          <Route index element={<Navigate to="customers" replace />} />
          <Route path="customers" element={<Customers />} />
          <Route path="suppliers" element={<Suppliers />} />
          <Route path="products" element={<Products />} />
          <Route path="warehouses" element={<Warehouses />} />
          <Route path="stock" element={<Inventory />} />
          <Route path="purchase" element={<PurchaseOrders />} />
          <Route path="purchase-receipts" element={<PurchaseReceipts />} />
          <Route path="purchase-returns" element={<PurchaseReturns />} />
          <Route path="sales" element={<SalesOrders />} />
          <Route path="sales-deliveries" element={<SalesDeliveries />} />
          <Route path="sales-returns" element={<SalesReturns />} />
          <Route path="transactions" element={<InventoryTransactions />} />
          <Route path="transfers" element={<InventoryTransfers />} />
          <Route path="stock-counts" element={<StockCounts />} />
          <Route path="stock-adjustments" element={<StockAdjustments />} />
          <Route path="other-stock" element={<OtherStockDocuments />} />
          <Route path="opening-balances" element={<OpeningBalances />} />
          <Route path="batches" element={<Batches />} />
          <Route path="batch-trace" element={<BatchTrace />} />
          <Route path="reports" element={<InventoryReports />} />
          <Route path="reconciliation" element={<InventoryReconciliation />} />
          <Route path="subject-map" element={<InventorySubjectMap />} />
        </Route>
        
        <Route path="mrp">
          <Route index element={<Navigate to="departments" replace />} />
          <Route path="departments" element={<Departments />} />
          <Route path="employees" element={<Employees />} />
          <Route path="boms" element={<Boms />} />
          <Route path="routings" element={<RoutingOperations />} />
          <Route path="workcenters" element={<WorkCenters />} />
          <Route path="operations" element={<Operations />} />
          <Route path="production" element={<ProductionOrders />} />
          <Route path="material-issues" element={<MaterialIssues />} />
          <Route path="material-returns" element={<MaterialReturns />} />
          <Route path="production-receipts" element={<ProductionReceipts />} />
          <Route path="production-reports" element={<ProductionReports />} />
          <Route path="cost-calculations" element={<CostCalculations />} />
          <Route path="plans" element={<MrpPlans />} />
          <Route path="mps" element={<MpsPlans />} />
          <Route path="quality" element={<QualityInspections />} />
          {/* P2-10 委外/外协闭环（deploy_102 / deploy_103） */}
          <Route path="subcontract-orders" element={<SubcontractOrders />} />
          <Route path="subcontract-issues" element={<SubcontractIssues />} />
          <Route path="subcontract-receipts" element={<SubcontractReceipts />} />
          <Route
            path="subcontract-settlements"
            element={<SubcontractSettlements />}
          />
          {/* P0-5 生产报表（deploy_108 视图 + deploy_109 菜单） */}
          <Route path="production-analytics" element={<ProductionAnalytics />} />
          {/* P0-4 计划基础参数（deploy_114 菜单） */}
          <Route path="planning-params" element={<PlanningParams />} />
          <Route path="work-calendars" element={<WorkCalendars />} />
          {/* 排班地基 Step 1（deploy_119 菜单） */}
          <Route path="shifts" element={<Shifts />} />
        </Route>
        
        <Route path="system">
          <Route index element={<Navigate to="users" replace />} />
          <Route path="users" element={<Users />} />
          <Route path="tenants" element={<Tenants />} />
          <Route path="roles" element={<Roles />} />
          <Route path="menus" element={<Menus />} />
          <Route path="settings" element={<Settings />} />
          <Route path="dictionaries" element={<Dictionaries />} />
          <Route path="uoms" element={<Uoms />} />
          <Route path="currencies" element={<Currencies />} />
          <Route path="workflow" element={<WorkflowConfig />} />
          <Route path="doc-flow" element={<DocFlowConfig />} />
          <Route path="document-types" element={<DocumentTypeBuilder />} />
          <Route path="logs" element={<Logs />} />
          <Route path="page-designer" element={<PageDesigner />} />
          <Route path="baq" element={<BaqDesigner />} />
          <Route path="knowledge-base" element={<KnowledgeBase />} />
        </Route>
        <Route path="custom/:slug" element={<CustomPageRenderer />} />
      </Route>
      
      <Route path="*" element={<Navigate to={user ? "/" : "/login"} />} />
    </Routes>
  );
}

function App() {
  return (
    <LocaleProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppContent />
        </BrowserRouter>
      </AuthProvider>
    </LocaleProvider>
  );
}

export default App;









