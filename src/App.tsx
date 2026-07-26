import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { ProLayout } from './components/ProLayout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { AccountSubjects } from './pages/finance/AccountSubjects';
import { Vouchers } from './pages/finance/Vouchers';
import { Receivables } from './pages/finance/Receivables';
import { Payables } from './pages/finance/Payables';
import { FixedAssets } from './pages/finance/FixedAssets';
import { AssetCategories } from './pages/finance/AssetCategories';
import { Customers } from './pages/inventory/Customers';
import { Suppliers } from './pages/inventory/Suppliers';
import { Products } from './pages/inventory/Products';
import { Warehouses } from './pages/inventory/Warehouses';
import { Inventory } from './pages/inventory/Inventory';
import { PurchaseOrders } from './pages/inventory/PurchaseOrders';
import { SalesOrders } from './pages/inventory/SalesOrders';
import { PurchaseReceipts } from './pages/inventory/PurchaseReceipts';
import { SalesDeliveries } from './pages/inventory/SalesDeliveries';
import { Boms } from './pages/mrp/Boms';
import { Departments } from './pages/mrp/Departments';
import { RoutingOperations } from './pages/mrp/RoutingOperations';
import { WorkCenters } from './pages/mrp/WorkCenters';
import { Operations } from './pages/mrp/Operations';
import { ProductionOrders } from './pages/mrp/ProductionOrders';
import { MrpPlans } from './pages/mrp/MrpPlans';
import { QualityInspections } from './pages/mrp/QualityInspections';
import { Users } from './pages/system/Users';
import { Roles } from './pages/system/Roles';
import { Menus } from './pages/system/Menus';
import { Logs } from './pages/system/Logs';
import { Settings } from './pages/system/Settings';
import { Dictionaries } from './pages/system/Dictionaries';
import { WorkflowConfig } from './pages/system/WorkflowConfig';
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
      
      <Route 
        path="/" 
        element={
          <ProtectedRoute>
            <ProLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        
        <Route path="finance">
          <Route index element={<Navigate to="subjects" replace />} />
          <Route path="subjects" element={<AccountSubjects />} />
          <Route path="vouchers" element={<Vouchers />} />
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
          <Route path="sales" element={<SalesOrders />} />
          <Route path="sales-deliveries" element={<SalesDeliveries />} />
        </Route>
        
        <Route path="mrp">
          <Route index element={<Navigate to="departments" replace />} />
          <Route path="departments" element={<Departments />} />
          <Route path="boms" element={<Boms />} />
          <Route path="routings" element={<RoutingOperations />} />
          <Route path="workcenters" element={<WorkCenters />} />
          <Route path="operations" element={<Operations />} />
          <Route path="production" element={<ProductionOrders />} />
          <Route path="plans" element={<MrpPlans />} />
          <Route path="quality" element={<QualityInspections />} />
        </Route>
        
        <Route path="system">
          <Route index element={<Navigate to="users" replace />} />
          <Route path="users" element={<Users />} />
          <Route path="roles" element={<Roles />} />
          <Route path="menus" element={<Menus />} />
          <Route path="settings" element={<Settings />} />
          <Route path="dictionaries" element={<Dictionaries />} />
          <Route path="workflow" element={<WorkflowConfig />} />
          <Route path="logs" element={<Logs />} />
          <Route path="page-designer" element={<PageDesigner />} />
          <Route path="baq" element={<BaqDesigner />} />
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





