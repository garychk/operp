import { useState, useEffect, useCallback, useMemo } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useLocation, useNavigate, Outlet } from "react-router-dom";
import {
  ProLayout as AntProLayout,
  PageContainer,
  ProCard,
} from "@ant-design/pro-components";
import {
  Tabs,
  Button,
  Dropdown,
  Tag,
  ConfigProvider,
  theme,
  Modal,
  Typography,
} from "antd";
import {
  DashboardOutlined,
  BookOutlined,
  ShoppingOutlined,
  ToolOutlined,
  TeamOutlined,
  ApartmentOutlined,
  ShopOutlined,
  InboxOutlined,
  ImportOutlined,
  AppstoreOutlined,
  ShoppingCartOutlined,
  RiseOutlined,
  FallOutlined,
  SettingOutlined,
  BuildOutlined,
  BranchesOutlined,
  ProfileOutlined,
  CalendarOutlined,
  ContainerOutlined,
  SafetyOutlined,
  MenuOutlined,
  FileTextOutlined,
  LogoutOutlined,
  TruckOutlined,
  SwapOutlined,
  CheckCircleOutlined,
  CalculatorOutlined,
  SunFilled,
  MoonOutlined,
  ApiOutlined,
  BgColorsOutlined,
  CheckOutlined,
  InfoCircleFilled,
  GithubFilled,
  PicLeftOutlined,
  PicCenterOutlined,
  OpenAIOutlined,
  ExperimentOutlined,
  TranslationOutlined,
  UnorderedListOutlined,
  DollarOutlined,
  LineChartOutlined,
  BarChartOutlined,
  TableOutlined,
  IdcardOutlined,
  PayCircleOutlined,
} from "@ant-design/icons";
import { useAuth } from "../contexts/AuthContext";
import { MenuPermissionGuard } from "./ProtectedRoute";
import { AIChatDrawer } from "./AIChatDrawer";
import { McpGuideDrawer } from "./McpGuideDrawer";
import { NotificationBell } from "./NotificationBell";
import { SubscriptionDrawer } from "./SubscriptionDrawer";
import { MenuSearch } from "./MenuSearch";
import heroLogo from "../assets/opelix.svg";
import defaultAvatar from "../assets/avatar.png";
import { supabase } from "../utils/supabase";
import { loadCurrencyRegistry } from "../utils/money";
import { useTranslation } from "react-i18next";
import type { SupportedLanguage } from "../i18n";

interface TabItem {
  key: string;
  label: string;
  closable: boolean;
  path: string;
}

interface MenuRoute {
  path: string;
  name: string;
  icon: ReactNode;
  routes?: MenuRoute[];
}

interface DatabaseMenu {
  id: number;
  parent_id: number | null;
  menu_name: string;
  menu_code: string | null;
  menu_type: string | null;
  path: string | null;
  icon?: string | null;
}

const menuIconMap: Record<string, ReactNode> = {
  DashboardOutlined: <DashboardOutlined />,
  BookOutlined: <BookOutlined />,
  ShoppingOutlined: <ShoppingOutlined />,
  ShoppingCartOutlined: <ShoppingCartOutlined />,
  ToolOutlined: <ToolOutlined />,
  TeamOutlined: <TeamOutlined />,
  ShopOutlined: <ShopOutlined />,
  InboxOutlined: <InboxOutlined />,
  ImportOutlined: <ImportOutlined />,
  CheckCircleOutlined: <CheckCircleOutlined />,
  CalculatorOutlined: <CalculatorOutlined />,
  AppstoreOutlined: <AppstoreOutlined />,
  SettingOutlined: <SettingOutlined />,
  BuildOutlined: <BuildOutlined />,
  BranchesOutlined: <BranchesOutlined />,
  ProfileOutlined: <ProfileOutlined />,
  CalendarOutlined: <CalendarOutlined />,
  ContainerOutlined: <ContainerOutlined />,
  FileTextOutlined: <FileTextOutlined />,
  MenuOutlined: <MenuOutlined />,
  SafetyOutlined: <SafetyOutlined />,
  TruckOutlined: <TruckOutlined />,
  RiseOutlined: <RiseOutlined />,
  FallOutlined: <FallOutlined />,
  TableOutlined: <TableOutlined />,
  UnorderedListOutlined: <UnorderedListOutlined />,
  DollarOutlined: <DollarOutlined />,
  SwapOutlined: <SwapOutlined />,
  ExperimentOutlined: <ExperimentOutlined />,
  LineChartOutlined: <LineChartOutlined />,
  BarChartOutlined: <BarChartOutlined />,
};

const fixedMenuPathByCode: Record<string, string> = {
  finance: "/finance",
  inventory: "/inventory",
  mrp: "/mrp",
  system: "/system",
};

function buildDatabaseMenuTree(records: DatabaseMenu[]): MenuRoute[] {
  const nodes = new Map<number, MenuRoute>();
  const roots: MenuRoute[] = [];
  records.forEach((record) => {
    const normalizedPath =
      record.path?.trim() ||
      (record.menu_code ? fixedMenuPathByCode[record.menu_code] : undefined) ||
      `/menu-group/${record.id}`;
    nodes.set(record.id, {
      path: normalizedPath,
      name: record.menu_name,
      icon: (record.icon && menuIconMap[record.icon]) || <DashboardOutlined />,
      routes: [],
    });
  });
  records.forEach((record) => {
    const node = nodes.get(record.id)!;
    const parent = record.parent_id ? nodes.get(record.parent_id) : undefined;
    if (parent && parent !== node) parent.routes!.push(node);
    else roots.push(node);
  });
  return roots;
}

function mergeMenuTrees(base: MenuRoute[], database: MenuRoute[]): MenuRoute[] {
  const databasePathOrder = new Map<string, number>();
  database.forEach((route, index) => databasePathOrder.set(route.path, index));

  const result: MenuRoute[] = base.map((route) => ({
    ...route,
    routes: route.routes ? mergeMenuTrees(route.routes, []) : undefined,
  }));
  database.forEach((route) => {
    const existing = result.find((item) => item.path === route.path);
    if (!existing) {
      result.push(route);
      return;
    }
    existing.name = route.name;
    existing.routes = mergeMenuTrees(existing.routes || [], route.routes || []);
  });

  // 按数据库排序号排列，首页始终第一，仅静态菜单排到末尾
  result.sort((a, b) => {
    if (a.path === "/") return -1;
    if (b.path === "/") return 1;
    const orderA = databasePathOrder.get(a.path);
    const orderB = databasePathOrder.get(b.path);
    if (orderA !== undefined && orderB !== undefined) return orderA - orderB;
    if (orderA !== undefined) return -1;
    if (orderB !== undefined) return 1;
    return 0;
  });

  return result;
}

function findMenuName(routes: MenuRoute[], path: string): string | undefined {
  for (const route of routes) {
    if (route.path === path) return route.name;
    const childName = route.routes
      ? findMenuName(route.routes, path)
      : undefined;
    if (childName) return childName;
  }
  return undefined;
}
type ThemeColorKey =
  | "default"
  | "black"
  | "green"
  | "orange"
  | "purple"
  | "warmPaper";

interface ThemeColor {
  label: string;
  color: string;
  rgb: string;
  secondaryRgb?: string;
  surfaceColor?: string;
  surfaceRgb?: string;
}

const themeColors: Record<ThemeColorKey, ThemeColor> = {
  default: { label: "默认", color: "#1677ff", rgb: "22, 119, 255" },
  black: {
    label: "高级黑",
    color: "#262626",
    rgb: "38, 38, 38",
    secondaryRgb: "113, 113, 122",
    surfaceRgb: "56, 56, 63",
  },
  green: {
    label: "极光绿",
    color: "#10b981",
    rgb: "16, 185, 129",
    secondaryRgb: "6, 182, 212",
    surfaceRgb: "11, 184, 171",
  },
  orange: {
    label: "脉冲橙",
    color: "#f97316",
    rgb: "249, 115, 22",
    secondaryRgb: "225, 29, 72",
    surfaceRgb: "237, 72, 47",
  },
  purple: {
    label: "星云紫",
    color: "#8b5cf6",
    rgb: "139, 92, 246",
    secondaryRgb: "6, 182, 212",
    surfaceRgb: "73, 137, 229",
  },
  warmPaper: {
    label: "暖纸色",
    color: "#9c5f36",
    rgb: "156, 95, 54",
    surfaceColor: "#f0eee6",
    surfaceRgb: "240, 238, 230",
  },
};

const borderRadiusOptions = [0, 2, 6, 8];

const themeSurface = (
  themeColor: ThemeColorKey,
  dark: boolean,
  opacity: number,
  base = false,
) => {
  const selected = themeColors[themeColor];
  if (base && selected.surfaceColor && !dark) return selected.surfaceColor;
  const rgb = base ? (selected.surfaceRgb ?? selected.rgb) : selected.rgb;
  return `rgba(${rgb}, ${dark ? opacity * 1.8 : opacity})`;
};

const themeHeaderBackground = (themeColor: ThemeColorKey, dark: boolean) => {
  const selected = themeColors[themeColor];
  if (selected.surfaceColor && !dark) {
    return "linear-gradient(115deg, #f0eee6 0%, #f5f2eb 55%, #efebe2 100%)";
  }

  const primaryOpacity = dark ? 0.11 : 0.055;
  const secondaryOpacity = dark ? 0.07 : 0.028;
  const secondaryRgb = selected.secondaryRgb ?? selected.rgb;
  return `linear-gradient(115deg, rgba(${selected.rgb}, ${primaryOpacity}) 0%, rgba(${secondaryRgb}, ${secondaryOpacity}) 55%, rgba(${selected.rgb}, ${primaryOpacity * 0.65}) 100%)`;
};

export const menuData: MenuRoute[] = [
  {
    path: "/",
    name: "首页",
    icon: <DashboardOutlined />,
  },
  {
    path: "/finance",
    name: "财务管理",
    icon: <BookOutlined />,
    routes: [
      {
        path: "/finance/subjects",
        name: "会计科目",
        icon: <ContainerOutlined />,
      },
      {
        path: "/finance/vouchers",
        name: "凭证管理",
        icon: <ProfileOutlined />,
      },
      {
        path: "/finance/gl-balance",
        name: "总账余额",
        icon: <LineChartOutlined />,
      },
      {
        path: "/finance/trial-balance",
        name: "试算平衡",
        icon: <BarChartOutlined />,
      },
      {
        path: "/finance/ledger",
        name: "科目/明细账",
        icon: <TableOutlined />,
      },
      {
        path: "/finance/periods",
        name: "会计期间",
        icon: <CalendarOutlined />,
      },
      {
        path: "/finance/receivables",
        name: "应收账款",
        icon: <RiseOutlined />,
      },
      { path: "/finance/payables", name: "应付账款", icon: <FallOutlined /> },
      { path: "/finance/assets", name: "固定资产", icon: <BuildOutlined /> },
      {
        path: "/finance/asset-categories",
        name: "资产类别",
        icon: <ContainerOutlined />,
      },
    ],
  },
  {
    path: "/inventory",
    name: "进销存管理",
    icon: <ShoppingOutlined />,
    routes: [
      {
        path: "/inventory/customers",
        name: "客户管理",
        icon: <TeamOutlined />,
      },
      {
        path: "/inventory/suppliers",
        name: "供应商管理",
        icon: <ShopOutlined />,
      },
      {
        path: "/inventory/products",
        name: "物料管理",
        icon: <InboxOutlined />,
      },
      {
        path: "/inventory/warehouses",
        name: "仓库管理",
        icon: <AppstoreOutlined />,
      },
      {
        path: "/inventory/stock",
        name: "库存查询",
        icon: <ShoppingOutlined />,
      },
      {
        path: "/inventory/transactions",
        name: "库存流水",
        icon: <TableOutlined />,
      },
      {
        path: "/inventory/purchase",
        name: "采购订单",
        icon: <ShoppingCartOutlined />,
      },
      {
        path: "/inventory/purchase-receipts",
        name: "采购入库",
        icon: <InboxOutlined />,
      },
      { path: "/inventory/sales", name: "销售订单", icon: <RiseOutlined /> },
      {
        path: "/inventory/sales-deliveries",
        name: "销售出货",
        icon: <TruckOutlined />,
      },
      {
        path: "/inventory/transfers",
        name: "库存调拨",
        icon: <TruckOutlined />,
      },
      {
        path: "/inventory/stock-counts",
        name: "库存盘点",
        icon: <AppstoreOutlined />,
      },
      {
        path: "/inventory/stock-adjustments",
        name: "库存调整",
        icon: <SettingOutlined />,
      },
    ],
  },
  {
    path: "/mrp",
    name: "生产制造",
    icon: <ToolOutlined />,
    routes: [
      { path: "/mrp/departments", name: "部门管理", icon: <TeamOutlined /> },
      { path: "/mrp/boms", name: "BOM管理", icon: <BranchesOutlined /> },
      { path: "/mrp/routings", name: "工艺路线", icon: <SettingOutlined /> },
      { path: "/mrp/workcenters", name: "工作中心", icon: <ToolOutlined /> },
      { path: "/mrp/operations", name: "工序管理", icon: <SettingOutlined /> },
      { path: "/mrp/production", name: "生产订单", icon: <ProfileOutlined /> },
      { path: "/mrp/material-issues", name: "领料单", icon: <InboxOutlined /> },
      { path: "/mrp/production-receipts", name: "完工入库", icon: <ImportOutlined /> },
      { path: "/mrp/production-reports", name: "生产报工", icon: <CheckCircleOutlined /> },
      { path: "/mrp/cost-calculations", name: "成本核算", icon: <CalculatorOutlined /> },
      { path: "/mrp/plans", name: "MRP计划", icon: <CalendarOutlined /> },
      { path: "/mrp/mps", name: "主生产计划", icon: <CalendarOutlined /> },
      { path: "/mrp/quality", name: "检验管理", icon: <ExperimentOutlined /> },
    ],
  },
  {
    path: "/system",
    name: "系统管理",
    icon: <SettingOutlined />,
    routes: [
      { path: "/system/users", name: "用户管理", icon: <TeamOutlined /> },
      { path: "/system/tenants", name: "租户管理", icon: <ApartmentOutlined /> },
      { path: "/system/roles", name: "角色管理", icon: <SafetyOutlined /> },
      { path: "/system/menus", name: "菜单管理", icon: <MenuOutlined /> },
      { path: "/system/settings", name: "系统设置", icon: <SettingOutlined /> },
      { path: "/system/workflow", name: "流程配置", icon: <BranchesOutlined /> },
      { path: "/system/doc-flow", name: "单据转换", icon: <SwapOutlined /> },
      { path: "/system/document-types", name: "DocType构建", icon: <ProfileOutlined /> },
      {
        path: "/system/dictionaries",
        name: "数据字典",
        icon: <BookOutlined />,
      },
      {
        path: "/system/uoms",
        name: "计量单位",
        icon: <UnorderedListOutlined />,
      },
      {
        path: "/system/currencies",
        name: "币别管理",
        icon: <DollarOutlined />,
      },
      { path: "/system/logs", name: "系统日志", icon: <FileTextOutlined /> },
      {
        path: "/system/page-designer",
        name: "页面设计器",
        icon: <AppstoreOutlined />,
      },
      { path: "/system/baq", name: "BAQ管理", icon: <ProfileOutlined /> },
      { path: "/system/knowledge-base", name: "知识库管理", icon: <BookOutlined /> },
    ],
  },
];

const pathToNameMap: Record<string, string> = {
  "/": "首页",
  "/workbench": "个人工作台",
  "/finance/subjects": "会计科目",
  "/finance/vouchers": "凭证管理",
  "/finance/gl-balance": "总账余额",
  "/finance/trial-balance": "试算平衡",
  "/finance/ledger": "科目/明细账",
  "/finance/receivables": "应收账款",
  "/finance/payables": "应付账款",
  "/finance/assets": "固定资产",
  "/finance/asset-categories": "资产类别",
  "/inventory/customers": "客户管理",
  "/inventory/suppliers": "供应商管理",
  "/inventory/products": "物料管理",
  "/inventory/warehouses": "仓库管理",
  "/system/uoms": "计量单位",
  "/system/currencies": "币别管理",
  "/inventory/stock": "库存查询",
  "/inventory/transactions": "库存流水",
  "/inventory/purchase": "采购订单",
  "/inventory/purchase-receipts": "采购入库",
  "/inventory/sales": "销售订单",
  "/inventory/sales-deliveries": "销售出货",
  "/inventory/transfers": "库存调拨",
  "/inventory/stock-counts": "库存盘点",
  "/inventory/stock-adjustments": "库存调整",
  "/inventory/purchase-returns": "采购退货",
  "/inventory/sales-returns": "销售退货",
  "/inventory/reports": "库存报表",
  "/inventory/reconciliation": "存货对账",
  "/inventory/subject-map": "存货科目映射",
  "/mrp/departments": "部门管理",
  "/mrp/boms": "BOM管理",
  "/mrp/routings": "工艺路线",
  "/mrp/workcenters": "工作中心",
  "/mrp/operations": "工序管理",
  "/mrp/production": "生产订单",
  "/mrp/material-issues": "领料单",
  "/mrp/material-returns": "生产退料",
  "/mrp/plans": "MRP计划",
  "/mrp/quality": "检验管理",
  "/system/users": "用户管理",
  "/system/tenants": "租户管理",
  "/system/roles": "角色管理",
  "/system/menus": "菜单管理",
  "/system/settings": "系统设置",
  "/system/workflow": "流程配置",
  "/system/doc-flow": "单据转换",
  "/system/document-types": "DocType构建",
  "/system/dictionaries": "数据字典",
  "/system/logs": "系统日志",
  "/system/page-designer": "页面设计器",
  "/system/baq": "BAQ管理",
  "/system/knowledge-base": "知识库管理",
};

const pathToTranslationKey: Record<string, string> = {
  "/": "menu.home",
  "/workbench": "workbench.title",
  "/finance": "menu.finance",
  "/finance/subjects": "menu.subjects",
  "/finance/vouchers": "menu.vouchers",
  "/finance/gl-balance": "menu.glBalance",
  "/finance/trial-balance": "menu.trialBalance",
  "/finance/ledger": "menu.ledger",
  "/finance/periods": "menu.periods",
  "/finance/receivables": "menu.receivables",
  "/finance/payables": "menu.payables",
  "/finance/assets": "menu.assets",
  "/finance/asset-categories": "menu.assetCategories",
  "/inventory": "menu.inventory",
  "/inventory/customers": "menu.customers",
  "/inventory/suppliers": "menu.suppliers",
  "/inventory/products": "menu.products",
  "/inventory/warehouses": "menu.warehouses",
  "/system/uoms": "menu.uoms",
  "/system/currencies": "menu.currencies",
  "/inventory/stock": "menu.stock",
  "/inventory/transactions": "menu.transactions",
  "/inventory/purchase": "menu.purchase",
  "/inventory/purchase-receipts": "menu.purchaseReceipts",
  "/inventory/sales": "menu.sales",
  "/inventory/sales-deliveries": "menu.salesDeliveries",
  "/mrp": "menu.mrp",
  "/mrp/departments": "menu.departments",
  "/mrp/boms": "menu.boms",
  "/mrp/routings": "menu.routings",
  "/mrp/workcenters": "menu.workcenters",
  "/mrp/operations": "menu.operations",
  "/mrp/production": "menu.production",
  "/mrp/material-issues": "menu.materialIssues",
  "/mrp/production-receipts": "menu.productionReceipts",
  "/mrp/production-reports": "menu.productionReports",
  "/mrp/cost-calculations": "menu.costCalculations",
  "/mrp/plans": "menu.plans",
  "/mrp/mps": "menu.mps",
  "/mrp/quality": "menu.quality",
  "/system": "menu.system",
  "/system/users": "menu.users",
  "/system/tenants": "menu.tenants",
  "/system/roles": "menu.roles",
  "/system/menus": "menu.menus",
  "/system/settings": "menu.settings",
  "/system/workflow": "menu.workflow",
  "/system/doc-flow": "menu.docFlow",
  "/system/document-types": "menu.documentTypes",
  "/system/dictionaries": "menu.dictionaries",
  "/system/logs": "menu.logs",
  "/system/page-designer": "menu.pageDesigner",
  "/system/baq": "menu.baq",
  "/system/knowledge-base": "menu.knowledgeBase",
  "/inventory/transfers": "menu.transfers",
  "/inventory/stock-counts": "menu.stockCounts",
  "/inventory/stock-adjustments": "menu.stockAdjustments",
  "/inventory/purchase-returns": "menu.purchaseReturns",
  "/inventory/sales-returns": "menu.salesReturns",
  "/inventory/reports": "menu.inventoryReports",
  "/inventory/reconciliation": "menu.inventoryReconciliation",
  "/inventory/subject-map": "menu.inventorySubjectMap",
  "/mrp/material-returns": "menu.materialReturns",
};

export const staticComponentByPath: Record<string, string> = {
  "/": "./pages/Dashboard",
  "/finance/subjects": "./pages/finance/AccountSubjects",
  "/finance/vouchers": "./pages/finance/Vouchers",
  "/finance/gl-balance": "./pages/finance/GeneralLedgerBalance",
  "/finance/trial-balance": "./pages/finance/TrialBalance",
  "/finance/ledger": "./pages/finance/SubjectLedger",
  "/finance/periods": "./pages/finance/AccountingPeriods",
  "/finance/receivables": "./pages/finance/Receivables",
  "/finance/payables": "./pages/finance/Payables",
  "/finance/assets": "./pages/finance/FixedAssets",
  "/finance/asset-categories": "./pages/finance/AssetCategories",
  "/inventory/customers": "./pages/inventory/Customers",
  "/inventory/suppliers": "./pages/inventory/Suppliers",
  "/inventory/products": "./pages/inventory/Products",
  "/inventory/warehouses": "./pages/inventory/Warehouses",
  "/inventory/stock": "./pages/inventory/Inventory",
  "/inventory/transactions": "./pages/inventory/InventoryTransactions",
  "/inventory/purchase": "./pages/inventory/PurchaseOrders",
  "/inventory/purchase-receipts": "./pages/inventory/PurchaseReceipts",
  "/inventory/sales": "./pages/inventory/SalesOrders",
  "/inventory/sales-deliveries": "./pages/inventory/SalesDeliveries",
  "/inventory/transfers": "./pages/inventory/InventoryTransfers",
  "/inventory/stock-counts": "./pages/inventory/StockCounts",
  "/inventory/stock-adjustments": "./pages/inventory/StockAdjustments",
  "/inventory/purchase-returns": "./pages/inventory/PurchaseReturns",
  "/inventory/sales-returns": "./pages/inventory/SalesReturns",
  "/inventory/reports": "./pages/inventory/InventoryReports",
  "/inventory/reconciliation": "./pages/inventory/InventoryReconciliation",
  "/inventory/subject-map": "./pages/inventory/InventorySubjectMap",
  "/mrp/departments": "./pages/mrp/Departments",
  "/mrp/boms": "./pages/mrp/Boms",
  "/mrp/routings": "./pages/mrp/RoutingOperations",
  "/mrp/workcenters": "./pages/mrp/WorkCenters",
  "/mrp/operations": "./pages/mrp/Operations",
  "/mrp/production": "./pages/mrp/ProductionOrders",
  "/mrp/material-issues": "./pages/mrp/MaterialIssues",
  "/mrp/material-returns": "./pages/mrp/MaterialReturns",
  "/mrp/plans": "./pages/mrp/MrpPlans",
  "/mrp/quality": "./pages/mrp/QualityInspections",
  "/system/users": "./pages/system/Users",
  "/system/tenants": "./pages/system/Tenants",
  "/system/roles": "./pages/system/Roles",
  "/system/menus": "./pages/system/Menus",
  "/system/settings": "./pages/system/Settings",
  "/system/workflow": "./pages/system/WorkflowConfig",
  "/system/doc-flow": "./pages/system/DocFlowConfig",
  "/system/document-types": "./pages/system/DocumentTypeBuilder",
  "/system/dictionaries": "./pages/system/Dictionaries",
  "/system/uoms": "./pages/system/Uoms",
  "/system/currencies": "./pages/system/Currencies",
  "/system/logs": "./pages/system/Logs",
  "/system/page-designer": "./features/page-builder/PageDesigner",
  "/system/baq": "./features/baq/BaqDesigner",
  "/system/knowledge-base": "./pages/system/KnowledgeBase",
};
export function ProLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { t, i18n } = useTranslation();
  const language = (
    i18n.resolvedLanguage === "en-US" ? "en-US" : "zh-CN"
  ) as SupportedLanguage;
  const [tabs, setTabs] = useState<TabItem[]>([
    { key: "/", label: t("menu.home"), closable: false, path: "/" },
  ]);
  const [activeTabKey, setActiveTabKey] = useState("/");
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("erp-dark-mode");
    return saved !== null ? JSON.parse(saved) : false;
  });
  const [themeColor, setThemeColor] = useState<ThemeColorKey>(() => {
    const saved = localStorage.getItem("erp-theme-color");
    return saved && saved in themeColors ? (saved as ThemeColorKey) : "default";
  });
  const [ismix, setMix] = useState(() => {
    const saved = localStorage.getItem("erp-layout-mix");
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [compact, setCompact] = useState<boolean>(() => {
    const saved = localStorage.getItem("erp-layout-compact");
    return saved !== null ? JSON.parse(saved) === true : true;
  });
  const [borderRadius, setBorderRadius] = useState<number>(() => {
    const saved = localStorage.getItem("erp-border-radius");
    const radius = saved !== null ? Number(saved) : NaN;
    return Number.isNaN(radius) ? 6 : radius;
  });
  const [aiChatOpen, setAiChatOpen] = useState(false);
  const [mcpGuideOpen, setMcpGuideOpen] = useState(false);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
  const [databaseMenus, setDatabaseMenus] = useState<MenuRoute[]>([]);

  useEffect(() => {
    const loadDatabaseMenus = async () => {
      const { data, error } = await supabase
        .from("sys_menus")
        .select("id, parent_id, menu_name, menu_code, menu_type, path, icon")
        .eq("status", "1")
        .eq("is_deleted", "n")
        .order("sort_order");

      if (error) {
        console.error("Failed to load database menus:", error);
        return;
      }
      setDatabaseMenus(buildDatabaseMenuTree((data || []) as DatabaseMenu[]));
    };
    void loadDatabaseMenus();
    const refreshDatabaseMenus = () => {
      void loadDatabaseMenus();
    };
    window.addEventListener("custom-pages-changed", refreshDatabaseMenus);
    window.addEventListener("menus-changed", refreshDatabaseMenus);
    return () => {
      window.removeEventListener("custom-pages-changed", refreshDatabaseMenus);
      window.removeEventListener("menus-changed", refreshDatabaseMenus);
    };
  }, []);
  // 币别元数据（本位币 / 符号 / 金额小数位）加载一次，供全站 formatMoney、MoneyInput 使用。
  // 加载完成后 useCurrencyRegistry 会自动触发订阅重渲染，无需在此管理状态。
  useEffect(() => {
    void loadCurrencyRegistry();
  }, []);
  useEffect(() => {
    localStorage.setItem("erp-dark-mode", JSON.stringify(dark));
    // 深浅模式目前只存在于 antd token 里，纯 CSS（如个人工作台的欢迎条）没法跟着切换。
    // 这里同步一个 DOM 标记，供 index.css 里需要跟随主题的样式使用。
    document.documentElement.setAttribute("data-erp-dark", dark ? "true" : "false");
  }, [dark]);

  useEffect(() => {
    const selected = themeColors[themeColor];
    localStorage.setItem("erp-theme-color", themeColor);
    document.documentElement.style.setProperty("--accent", selected.color);
    document.documentElement.style.setProperty(
      "--accent-bg",
      `rgba(${selected.rgb}, 0.1)`,
    );
    document.documentElement.style.setProperty(
      "--accent-border",
      `rgba(${selected.rgb}, 0.5)`,
    );
  }, [themeColor]);

  useEffect(() => {
    localStorage.setItem("erp-layout-mix", JSON.stringify(ismix));
  }, [ismix]);

  useEffect(() => {
    localStorage.setItem("erp-layout-compact", JSON.stringify(compact));
  }, [compact]);

  useEffect(() => {
    localStorage.setItem("erp-border-radius", String(borderRadius));
  }, [borderRadius]);

  const mergedMenuData = useMemo(
    () => mergeMenuTrees(menuData, databaseMenus),
    [databaseMenus],
  );

  const localizedMenuData = useMemo(() => {
    const localizeRoutes = (routes: MenuRoute[]): MenuRoute[] =>
      routes.map((route) => ({
        ...route,
        name: pathToTranslationKey[route.path]
          ? t(pathToTranslationKey[route.path])
          : route.name,
        routes: route.routes ? localizeRoutes(route.routes) : undefined,
      }));
    return localizeRoutes(mergedMenuData);
  }, [mergedMenuData, t, i18n.resolvedLanguage]);
  const visibleMenuData = useMemo(() => {
    if (user?.isSuperAdmin) {
      return localizedMenuData;
    }

    const allowedPaths = new Set(user?.menuPaths ?? []);
    const filterRoutes = (routes: MenuRoute[]): MenuRoute[] => {
      const result: MenuRoute[] = [];
      routes.forEach((route) => {
        const children = route.routes ? filterRoutes(route.routes) : undefined;
        const visibleByPath =
          route.path === "/" || allowedPaths.has(route.path);
        if (!visibleByPath && !children?.length) return;
        result.push({ ...route, routes: children });
      });
      return result;
    };
    return filterRoutes(localizedMenuData);
  }, [user, localizedMenuData]);
  const handleLogout = async () => {
    await logout();
  };

  // 个人工作台走站内导航：由 Tabs 的 addTab 逻辑在顶部标签栏里新开一个页签
  // （'/workbench' 已登记在 pathToNameMap / pathToTranslationKey 中，因此能拿到标题并出现在标签栏）。
  const openWorkbench = () => {
    navigate("/workbench");
  };

  const addTab = useCallback(
    (path: string) => {
      const translationKey = pathToTranslationKey[path];
      const label = translationKey
        ? t(translationKey)
        : findMenuName(localizedMenuData, path) || t("common.unnamed");
      setTabs((prev) => {
        const existingTab = prev.find((tab) => tab.key === path);
        if (!existingTab) {
          return [...prev, { key: path, label, closable: true, path }];
        }
        return prev;
      });
      setActiveTabKey(path);
    },
    [localizedMenuData, t],
  );

  // 顶部菜单搜索：选中后按标签栏的老规矩新开一个页签（已有则激活），再跳转过去。
  const openMenuInNewTab = useCallback(
    (path: string) => {
      addTab(path);
      navigate(path);
    },
    [addTab, navigate],
  );

  useEffect(() => {
    setTabs((currentTabs) =>
      currentTabs.map((tab) => ({
        ...tab,
        label: pathToTranslationKey[tab.path]
          ? t(pathToTranslationKey[tab.path])
          : tab.label,
      })),
    );
  }, [t, i18n.resolvedLanguage]);
  const removeTab = useCallback(
    (targetKey: string) => {
      let newActiveKey = activeTabKey;
      let lastIndex = -1;
      tabs.forEach((tab, i) => {
        if (tab.key === targetKey) {
          lastIndex = i - 1;
        }
      });
      const newTabs = tabs.filter((tab) => tab.key !== targetKey);
      if (newTabs.length && newActiveKey === targetKey) {
        if (lastIndex >= 0) {
          newActiveKey = newTabs[lastIndex].key;
        } else {
          newActiveKey = newTabs[0].key;
        }
      }
      setTabs(newTabs);
      setActiveTabKey(newActiveKey);
      navigate(newActiveKey);
    },
    [tabs, activeTabKey, navigate],
  );

  const closeOtherTabs = useCallback(() => {
    setTabs((prev) => prev.filter((tab) => !tab.closable || tab.key === activeTabKey));
  }, [activeTabKey]);

  const closeAllTabs = useCallback(() => {
    setTabs((prev) => prev.filter((tab) => !tab.closable));
    const homeTab = tabs.find((tab) => !tab.closable);
    if (homeTab) {
      setActiveTabKey(homeTab.key);
      navigate(homeTab.key);
    }
  }, [tabs, navigate]);

  const handleTabChange = useCallback(
    (key: string) => {
      setActiveTabKey(key);
      navigate(key);
    },
    [navigate],
  );

  useEffect(() => {
    const path = location.pathname;
    if (pathToNameMap[path] || findMenuName(mergedMenuData, path)) {
      addTab(path);
    }
  }, [location.pathname, addTab, mergedMenuData]);

  const tabItems = tabs.map((tab) => ({
    key: tab.key,
    label: tab.label,
    closable: tab.closable,
  }));
  const themeToken = useMemo(
    () => ({
      colorPrimary: themeColors[themeColor].color,
      borderRadius,
      controlItemBgHover: dark
        ? "rgba(255, 255, 255, 0.08)"
        : `rgba(${themeColors[themeColor].rgb}, 0.06)`,
      controlItemBgActive: dark
        ? "rgba(255, 255, 255, 0.12)"
        : `rgba(${themeColors[themeColor].rgb}, 0.08)`,
      controlItemBgActiveHover: dark
        ? "rgba(255, 255, 255, 0.18)"
        : `rgba(${themeColors[themeColor].rgb}, 0.14)`,
      ...(compact
        ? { fontSize: 12, controlHeight: 28, margin: 12 }
        : { fontSize: 14, controlHeight: 32, margin: 16 }),
    }),
    [themeColor, compact, borderRadius, dark],
  );
  return (
    <ConfigProvider
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: themeToken,
        components: {
          Table: {
            rowSelectedBg: dark
              ? "rgba(255, 255, 255, 0.12)"
              : `rgba(${themeColors[themeColor].rgb}, 0.08)`,
            rowSelectedHoverBg: dark
              ? "rgba(255, 255, 255, 0.18)"
              : `rgba(${themeColors[themeColor].rgb}, 0.14)`,
          },
          Select: {
            optionSelectedBg: dark
              ? "rgba(255, 255, 255, 0.12)"
              : `rgba(${themeColors[themeColor].rgb}, 0.08)`,
            optionActiveBg: dark
              ? "rgba(255, 255, 255, 0.08)"
              : `rgba(${themeColors[themeColor].rgb}, 0.06)`,
          },
          Menu: {
            itemSelectedBg: dark
              ? "rgba(255, 255, 255, 0.12)"
              : `rgba(${themeColors[themeColor].rgb}, 0.08)`,
            itemHoverBg: dark
              ? "rgba(255, 255, 255, 0.08)"
              : `rgba(${themeColors[themeColor].rgb}, 0.06)`,
            darkItemSelectedBg: "rgba(255, 255, 255, 0.12)",
            darkItemHoverBg: "rgba(255, 255, 255, 0.08)",
          },
        },
      }}
    >
      <AntProLayout
        layout={ismix ? "mix" : "side"}
        className={themeColor === "default" ? undefined : "themed-pro-layout"}
        style={
          themeColor === "default"
            ? undefined
            : ({
                "--theme-header-background": themeHeaderBackground(
                  themeColor,
                  dark,
                ),
              } as CSSProperties)
        }
        token={
          themeColor === "default"
            ? undefined
            : {
                header: {
                  colorBgHeader: themeSurface(themeColor, dark, 0.06, true),
                  colorBgScrollHeader: themeSurface(
                    themeColor,
                    dark,
                    0.075,
                    true,
                  ),
                  colorBgMenuItemHover: themeSurface(themeColor, dark, 0.06),
                  colorBgMenuItemSelected: themeSurface(themeColor, dark, 0.1),
                  colorBgRightActionsItemHover: themeSurface(
                    themeColor,
                    dark,
                    0.06,
                  ),
                },
                sider: {
                  colorMenuBackground: themeSurface(themeColor, dark, 0.015),
                  colorBgMenuItemHover: themeSurface(themeColor, dark, 0.045),
                  colorBgMenuItemActive: themeSurface(themeColor, dark, 0.065),
                  colorBgMenuItemSelected: themeSurface(themeColor, dark, 0.09),
                  colorBgCollapsedButton: themeSurface(themeColor, dark, 0.055),
                },
              }
        }
        // menuExtraRender={() => <Input.Search placeholder="搜索菜单" />}
        breadcrumbRender={false}
        fixSiderbar
        fixedHeader
        splitMenus={false}
        title="OPERP"
        logo={
          <img
            src={heroLogo}
            alt="Logo"
            style={{ height: "24px", filter: dark ? "invert(1)" : undefined }}
          />
        }
        route={{ routes: visibleMenuData }}
        menuDataRender={(items) => visibleMenuData as unknown as typeof items}
        location={{ pathname: location.pathname }}
        menuItemRender={(item, dom) => (
          <div onClick={() => navigate(item.path || "/")}>{dom}</div>
        )}
        headerContentRender={() => <Tag color="gold">V1.0.6</Tag>}
        avatarProps={{
          src: user?.profile.avatar_url || defaultAvatar,
          size: "small",
          // 侧边布局（非 mix）下右上角只留头像：title 就是 ProLayout 渲染在头像右侧的用户名，
          // 传 undefined 即不渲染那个 span（它不会被透传给 Avatar，所以不会丢失任何东西）。
          title: ismix
            ? user?.profile.real_name ||
              user?.profile.username ||
              user?.auth.email ||
              ""
            : undefined,
          render: (_props, dom) => {
            return user ? (
              <Dropdown
                menu={{
                  items: [
                    {
                      key: "workbench",
                      icon: <IdcardOutlined />,
                      label: t("workbench.title"),
                      onClick: openWorkbench,
                    },
                    { type: "divider" },
                    {
                      key: "logout",
                      icon: <LogoutOutlined />,
                      label: t("common.logout"),
                      onClick: handleLogout,
                    },
                  ],
                }}
              >
                {dom}
              </Dropdown>
            ) : (
              <Button
                size="small"
                type="primary"
                onClick={() => {
                  if (typeof (window as any).AIApp !== "undefined") {
                    (window as any).AIApp.Auth?.login();
                  } else {
                    window.location.href = "/login";
                  }
                }}
              >
                {t("common.login")}
              </Button>
            );
          },
        }}
        actionsRender={() => [
          <MenuSearch
            key="menu-search"
            menus={visibleMenuData}
            onSelect={openMenuInNewTab}
          />,
          <NotificationBell key="notifications" />,
          <PayCircleOutlined
            key="subscription"
            title={t("subscription.entry")}
            aria-label={t("subscription.entry")}
            onClick={() => setSubscriptionOpen(true)}
          />,
          dark ? (
            <MoonOutlined key="theme" onClick={() => setDark(false)} />
          ) : (
            <SunFilled key="theme" onClick={() => setDark(true)} />
          ),
          ismix ? (
            <PicLeftOutlined key="mix" onClick={() => setMix(false)} />
          ) : (
            <PicCenterOutlined key="mix" onClick={() => setMix(true)} />
          ),
          <Dropdown
            key="language"
            trigger={["click"]}
            menu={{
              selectable: true,
              selectedKeys: [language],
              onClick: ({ key }) => {
                void i18n.changeLanguage(key as SupportedLanguage);
              },
              items: [
                { key: "zh-CN", label: t("language.zhCN") },
                { key: "en-US", label: t("language.enUS") },
              ],
            }}
          >
            <TranslationOutlined
              title={t("language.switch")}
              aria-label={t("language.switch")}
            />
          </Dropdown>,

          ...(ismix
            ? [
                <OpenAIOutlined
                  key="openai"
                  className={`ai-chat-action${aiChatOpen ? " ai-chat-action-active" : ""}`}
                  onClick={() => setAiChatOpen(true)}
                />,
                <ApiOutlined
                  key="mcp-guide"
                  className={`ai-chat-action${mcpGuideOpen ? " ai-chat-action-active" : ""}`}
                  title={t("mcpGuide.entry")}
                  aria-label={t("mcpGuide.entry")}
                  onClick={() => setMcpGuideOpen(true)}
                />,
                <Dropdown
                  key="theme-color"
                  trigger={["click"]}
                  menu={{
                    items: [
                      {
                        type: "group",
                        label: t("layout.themeColor"),
                        children: Object.entries(themeColors).map(
                          ([key, item]) => ({
                            key: `theme-${key}`,
                            onClick: () => setThemeColor(key as ThemeColorKey),
                            label: (
                              <span
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  minWidth: 96,
                                }}
                              >
                                <span
                                  aria-hidden="true"
                                  style={{
                                    width: 14,
                                    height: 14,
                                    borderRadius: 3,
                                    background: item.secondaryRgb
                                      ? `linear-gradient(135deg, ${item.color}, rgb(${item.secondaryRgb}))`
                                      : (item.surfaceColor ?? item.color),
                                    border: item.surfaceColor
                                      ? "1px solid rgba(0, 0, 0, 0.12)"
                                      : undefined,
                                  }}
                                />
                                <span style={{ flex: 1 }}>{item.label}</span>
                                {themeColor === key ? <CheckOutlined /> : null}
                              </span>
                            ),
                          }),
                        ),
                      },
                      { type: "divider" },
                      {
                        type: "group",
                        label: t("layout.density"),
                        children: [
                          {
                            key: "density-normal",
                            onClick: () => setCompact(false),
                            label: (
                              <span
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  minWidth: 96,
                                }}
                              >
                                <span style={{ flex: 1 }}>
                                  {t("layout.densityNormal")}
                                </span>
                                {!compact ? <CheckOutlined /> : null}
                              </span>
                            ),
                          },
                          {
                            key: "density-compact",
                            onClick: () => setCompact(true),
                            label: (
                              <span
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  minWidth: 96,
                                }}
                              >
                                <span style={{ flex: 1 }}>
                                  {t("layout.densityCompact")}
                                </span>
                                {compact ? <CheckOutlined /> : null}
                              </span>
                            ),
                          },
                        ],
                      },
                      { type: "divider" },
                      {
                        type: "group",
                        label: t("layout.borderRadius"),
                        children: borderRadiusOptions.map((value) => ({
                          key: `radius-${value}`,
                          onClick: () => setBorderRadius(value),
                          label: (
                            <span
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                minWidth: 96,
                              }}
                            >
                              <span
                                aria-hidden="true"
                                style={{
                                  width: 16,
                                  height: 16,
                                  border: `1px solid ${themeColors[themeColor].color}`,
                                  borderRadius: value,
                                }}
                              />
                              <span style={{ flex: 1 }}>{value}px</span>
                              {borderRadius === value ? (
                                <CheckOutlined />
                              ) : null}
                            </span>
                          ),
                        })),
                      },
                    ],
                  }}
                >
                  <BgColorsOutlined
                    title={t("layout.switchThemeColor")}
                    aria-label={t("layout.switchThemeColor")}
                    style={{ color: themeColors[themeColor].color }}
                  />
                </Dropdown>,
                <InfoCircleFilled
                  key="info"
                  onClick={() => setIsInfoModalOpen(true)}
                />,
                <GithubFilled
                  key="github"
                  onClick={() =>
                    window.open(
                      "https://gitee.com/garychk/supabase-erp",
                      "_blank",
                    )
                  }
                />,
              ]
            : []),
        ]}
        footerRender={() => (
          <div style={{ textAlign: "center", padding: 12, color: "#999" }}>
            © 2026 OPERP
          </div>
        )}
      >
        <PageContainer title={false} pageHeaderRender={false}>
          <ProCard
            styles={{ body: { padding: "2px 2px 4px 2px" } }}
            className="main-container"
          >
            <Tabs
              activeKey={activeTabKey}
              onChange={handleTabChange}
              type="editable-card"
              hideAdd
              items={tabItems}
              onEdit={(targetKey, action) => {
                if (action === "remove") {
                  removeTab(targetKey as string);
                }
              }}
              tabBarExtraContent={{
                right: (
                  <Dropdown
                    menu={{
                      items: [
                        {
                          key: "close-others",
                          label: t("tabs.closeOthers"),
                          onClick: closeOtherTabs,
                        },
                        {
                          key: "close-all",
                          label: t("tabs.closeAll"),
                          onClick: closeAllTabs,
                        },
                      ],
                    }}
                    trigger={["click"]}
                  >
                    <Button type="text">
                      <UnorderedListOutlined />
                    </Button>
                  </Dropdown>
                ),
              }}
            />
            <MenuPermissionGuard>
              {/* 页面统一的内容视口：高度与滚动都在这里兜住（见 index.css 的 .page-viewport），
                  页面组件不必再各自挂 .mainContent，也不会因为忘记挂而被裁掉内容。 */}
              <div className="page-viewport">
                <Outlet />
              </div>
            </MenuPermissionGuard>
          </ProCard>
        </PageContainer>
        <AIChatDrawer open={aiChatOpen} onClose={() => setAiChatOpen(false)} />
        <McpGuideDrawer open={mcpGuideOpen} onClose={() => setMcpGuideOpen(false)} />
        <SubscriptionDrawer open={subscriptionOpen} onClose={() => setSubscriptionOpen(false)} />
        <Modal
          open={isInfoModalOpen}
          title={t("layout.aboutTitle")}
          footer={null}
          onCancel={() => setIsInfoModalOpen(false)}
        >
          <Typography.Paragraph>
            {t("layout.aboutDescription")}
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            {t("layout.version")}
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            {t("layout.author")}
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            {t("layout.email")}
          </Typography.Paragraph>
        </Modal>
      </AntProLayout>
    </ConfigProvider>
  );
}





