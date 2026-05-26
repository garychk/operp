import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { ProLayout } from './components/ProLayout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { FinanceModule } from './pages/finance/FinanceModule';
import { InventoryModule } from './pages/inventory/InventoryModule';
import { MrpModule } from './pages/mrp/MrpModule';
import { SystemModule } from './pages/system/SystemModule';
import { AccountSubjects } from './pages/finance/AccountSubjects';
import { Vouchers } from './pages/finance/Vouchers';
import { Receivables } from './pages/finance/Receivables';
import { Payables } from './pages/finance/Payables';
import { FixedAssets } from './pages/finance/FixedAssets';
import { Customers } from './pages/inventory/Customers';
import { Suppliers } from './pages/inventory/Suppliers';
import { Products } from './pages/inventory/Products';
import { Warehouses } from './pages/inventory/Warehouses';
import { Inventory } from './pages/inventory/Inventory';
import { PurchaseOrders } from './pages/inventory/PurchaseOrders';
import { SalesOrders } from './pages/inventory/SalesOrders';
import { Boms } from './pages/mrp/Boms';
import { RoutingOperations } from './pages/mrp/RoutingOperations';
import { WorkCenters } from './pages/mrp/WorkCenters';
import { Operations } from './pages/mrp/Operations';
import { ProductionOrders } from './pages/mrp/ProductionOrders';
import { MrpPlans } from './pages/mrp/MrpPlans';
import { Users } from './pages/system/Users';
import { Roles } from './pages/system/Roles';
import { Menus } from './pages/system/Menus';
import { Logs } from './pages/system/Logs';

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
        </Route>
        
        <Route path="inventory" >
          <Route index element={<Navigate to="customers" replace />} />
          <Route path="customers" element={<Customers />} />
          <Route path="suppliers" element={<Suppliers />} />
          <Route path="products" element={<Products />} />
          <Route path="warehouses" element={<Warehouses />} />
          <Route path="stock" element={<Inventory />} />
          <Route path="purchase" element={<PurchaseOrders />} />
          <Route path="sales" element={<SalesOrders />} />
        </Route>
        
        <Route path="mrp">
          <Route index element={<Navigate to="boms" replace />} />
          <Route path="boms" element={<Boms />} />
          <Route path="routings" element={<RoutingOperations />} />
          <Route path="workcenters" element={<WorkCenters />} />
          <Route path="operations" element={<Operations />} />
          <Route path="production" element={<ProductionOrders />} />
          <Route path="plans" element={<MrpPlans />} />
        </Route>
        
        <Route path="system">
          <Route index element={<Navigate to="users" replace />} />
          <Route path="users" element={<Users />} />
          <Route path="roles" element={<Roles />} />
          <Route path="menus" element={<Menus />} />
          <Route path="logs" element={<Logs />} />
        </Route>
      </Route>
      
      <Route path="*" element={<Navigate to={user ? "/" : "/login"} />} />
    </Routes>
  );
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
