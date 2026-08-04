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
  ShopOutlined,
  InboxOutlined,
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
  SunFilled,
  MoonOutlined,
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
  LineChartOutlined,
  BarChartOutlined,
  TableOutlined,
} from "@ant-design/icons";
import { useAuth } from "../contexts/AuthContext";
import { MenuPermissionGuard } from "./ProtectedRoute";
import { AIChatDrawer } from "./AIChatDrawer";
import heroLogo from "../assets/opelix.svg";
import defaultAvatar from "../assets/avatar.png";
import { supabase } from "../utils/supabase";
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
}

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
      icon:
        record.menu_type === "M" ? <AppstoreOutlined /> : <DashboardOutlined />,
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
  | "blue"
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
  blue: {
    label: "星际蓝",
    color: "#0ea5e9",
    rgb: "14, 165, 233",
    secondaryRgb: "99, 102, 241",
    surfaceRgb: "47, 134, 237",
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
      { path: "/mrp/plans", name: "MRP计划", icon: <CalendarOutlined /> },
      { path: "/mrp/quality", name: "检验管理", icon: <ExperimentOutlined /> },
    ],
  },
  {
    path: "/system",
    name: "系统管理",
    icon: <SettingOutlined />,
    routes: [
      { path: "/system/users", name: "用户管理", icon: <TeamOutlined /> },
      { path: "/system/roles", name: "角色管理", icon: <SafetyOutlined /> },
      { path: "/system/menus", name: "菜单管理", icon: <MenuOutlined /> },
      { path: "/system/settings", name: "系统设置", icon: <SettingOutlined /> },
      { path: "/system/workflow", name: "流程配置", icon: <BranchesOutlined /> },
      { path: "/system/document-types", name: "DocType构建", icon: <ProfileOutlined /> },
      {
        path: "/system/dictionaries",
        name: "数据字典",
        icon: <BookOutlined />,
      },
      { path: "/system/logs", name: "系统日志", icon: <FileTextOutlined /> },
      {
        path: "/system/page-designer",
        name: "页面设计器",
        icon: <AppstoreOutlined />,
      },
      { path: "/system/baq", name: "BAQ管理", icon: <ProfileOutlined /> },
    ],
  },
];

const pathToNameMap: Record<string, string> = {
  "/": "首页",
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
  "/inventory/stock": "库存查询",
  "/inventory/purchase": "采购订单",
  "/inventory/purchase-receipts": "采购入库",
  "/inventory/sales": "销售订单",
  "/inventory/sales-deliveries": "销售出货",
  "/mrp/departments": "部门管理",
  "/mrp/boms": "BOM管理",
  "/mrp/routings": "工艺路线",
  "/mrp/workcenters": "工作中心",
  "/mrp/operations": "工序管理",
  "/mrp/production": "生产订单",
  "/mrp/plans": "MRP计划",
  "/mrp/quality": "检验管理",
  "/system/users": "用户管理",
  "/system/roles": "角色管理",
  "/system/menus": "菜单管理",
  "/system/settings": "系统设置",
  "/system/workflow": "流程配置",
  "/system/document-types": "DocType构建",
  "/system/dictionaries": "数据字典",
  "/system/logs": "系统日志",
  "/system/page-designer": "页面设计器",
  "/system/baq": "BAQ管理",
};

const pathToTranslationKey: Record<string, string> = {
  "/": "menu.home",
  "/finance": "menu.finance",
  "/finance/subjects": "menu.subjects",
  "/finance/vouchers": "menu.vouchers",
  "/finance/gl-balance": "menu.glBalance",
  "/finance/trial-balance": "menu.trialBalance",
  "/finance/ledger": "menu.ledger",
  "/finance/receivables": "menu.receivables",
  "/finance/payables": "menu.payables",
  "/finance/assets": "menu.assets",
  "/finance/asset-categories": "menu.assetCategories",
  "/inventory": "menu.inventory",
  "/inventory/customers": "menu.customers",
  "/inventory/suppliers": "menu.suppliers",
  "/inventory/products": "menu.products",
  "/inventory/warehouses": "menu.warehouses",
  "/inventory/stock": "menu.stock",
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
  "/mrp/plans": "menu.plans",
  "/mrp/quality": "menu.quality",
  "/system": "menu.system",
  "/system/users": "menu.users",
  "/system/roles": "menu.roles",
  "/system/menus": "menu.menus",
  "/system/settings": "menu.settings",
  "/system/workflow": "menu.workflow",
  "/system/document-types": "menu.documentTypes",
  "/system/dictionaries": "menu.dictionaries",
  "/system/logs": "menu.logs",
  "/system/page-designer": "menu.pageDesigner",
  "/system/baq": "menu.baq",
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
  const [aiChatOpen, setAiChatOpen] = useState(false);
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
  const [databaseMenus, setDatabaseMenus] = useState<MenuRoute[]>([]);

  useEffect(() => {
    const loadDatabaseMenus = async () => {
      const { data, error } = await supabase
        .from("sys_menus")
        .select("id, parent_id, menu_name, menu_code, menu_type, path")
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
  useEffect(() => {
    localStorage.setItem("erp-dark-mode", JSON.stringify(dark));
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
  return (
    <ConfigProvider
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: themeColors[themeColor].color },
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
        logo={<img src={heroLogo} alt="Logo" style={{ height: "24px", filter: dark ? "invert(1)" : undefined }} />}
        route={{ routes: visibleMenuData }}
        menuDataRender={(items) => visibleMenuData as unknown as typeof items}
        location={{ pathname: location.pathname }}
        menuItemRender={(item, dom) => (
          <div onClick={() => navigate(item.path || "/")}>{dom}</div>
        )}
        headerContentRender={() => <Tag color="gold">V1.0</Tag>}
        avatarProps={{
          src: user?.profile.avatar_url || defaultAvatar,
          size: "small",
          title:
            user?.profile.real_name ||
            user?.profile.username ||
            user?.auth.email ||
            "",
          render: (_props, dom) => {
            return user ? (
              <Dropdown
                menu={{
                  items: [
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
              ]
            : []),
          <Dropdown
            key="theme-color"
            trigger={["click"]}
            menu={{
              selectable: true,
              selectedKeys: [themeColor],
              onClick: ({ key }) => setThemeColor(key as ThemeColorKey),
              items: Object.entries(themeColors).map(([key, item]) => ({
                key,
                label: (
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      minWidth: 72,
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
              })),
            }}
          >
            <BgColorsOutlined
              title={t("layout.switchThemeColor")}
              aria-label={t("layout.switchThemeColor")}
              style={{ color: themeColors[themeColor].color }}
            />
          </Dropdown>,
          ...(ismix
            ? [
                <InfoCircleFilled
                  key="info"
                  onClick={() => setIsInfoModalOpen(true)}
                />,
              ]
            : []),

          ...(ismix
            ? [
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
                        { key: "close-others", label: t("tabs.closeOthers"), onClick: closeOtherTabs },
                        { key: "close-all", label: t("tabs.closeAll"), onClick: closeAllTabs },
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
              <Outlet />
            </MenuPermissionGuard>
          </ProCard>
        </PageContainer>
        <AIChatDrawer open={aiChatOpen} onClose={() => setAiChatOpen(false)} />
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




