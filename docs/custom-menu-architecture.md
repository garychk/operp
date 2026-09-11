# 自定义菜单挂载机制（写入 → 读取 → 合并 → 渲染）

> 本文梳理 OPERP 中自定义菜单从写入到最终渲染的完整链路，涉及 `sys_menus`、`sys_custom_pages` 两张表，以及 `ProLayout.tsx`、`Menus.tsx`、`page-builder/api.ts`、`App.tsx` 四个关键文件。

## 总览

```
页面设计器发布 / 菜单管理页维护
        │
        ▼
   sys_menus 表（Supabase）
        │  status='1' AND is_deleted='n'，按 sort_order 排序
        ▼
ProLayout: loadDatabaseMenus
        ▼
buildDatabaseMenuTree（parent_id 组树）
        ▼
mergeMenuTrees（合并进静态 menuData）
        ▼
visibleMenuData（权限过滤）
        ▼
AntProLayout 侧边栏渲染
```

## 1. 写入：菜单怎么进表

### 1.1 页面设计器发布（`src/features/page-builder/api.ts` → `publishCustomPage()`）

1. 先把页面保存到 `sys_custom_pages`，状态置为 `published`。
2. 构造菜单记录：
   - `menu_code = custom_${slug}`（幂等键）
   - `menu_type = 'C'`
   - `path = /custom/${slug}`
   - `component = 'CustomPageRenderer'`
   - `parent_id = 0`（顶级）、`sort_order = 90`
3. 写入 `sys_menus` 的三段逻辑：
   - 页面已绑定 `menu_id` → 直接 update；
   - 未绑定但存在同 `menu_code` 且未删除的记录 → 复用该 id 并 update；
   - 都没有 → insert 新记录。
4. 将 `menu_id` 回写到 `sys_custom_pages`，建立页面 ↔ 菜单的一对一关联。
5. 派发 `window` 事件 `custom-pages-changed` 通知 ProLayout 刷新。

### 1.2 菜单管理页（`src/pages/system/Menus.tsx`）

- 直接对 `sys_menus` 增删改：删除为软删（`is_deleted='y'`）。
- 上移/下移：与相邻兄弟交换 `sort_order`。
- 图标（`icon` 字段）保存为组件名字符串（如 `BookOutlined`），渲染端通过图标注册表还原。
- 每次 fetch 后派发 `menus-changed` 事件。

### 1.3 角色授权（`src/pages/system/Roles.tsx`）

只控制菜单对角色的可见性（写入角色-菜单关联），不产生新菜单记录。

## 2. 读取（`src/components/ProLayout.tsx` → `loadDatabaseMenus()`）

- 组件挂载时查询 `sys_menus`：
  - 条件：`status = '1'` 且 `is_deleted = 'n'`
  - 排序：`sort_order` 升序
  - 字段：`id, parent_id, menu_name, menu_code, menu_type, path, icon`
- 同时注册两个刷新事件的监听（卸载时移除）：
  - `menus-changed`：菜单管理页保存后派发
  - `custom-pages-changed`：页面设计器发布后派发
- 收到事件即重新执行查询，无需刷新浏览器。

## 3. 合并

### 3.1 `buildDatabaseMenuTree()`：平铺记录组树

- 按 `parent_id` 把记录组装成树，无父的进 roots。
- `path` 归一化优先级：
  1. 记录自身的 `path`；
  2. `fixedMenuPathByCode` 兜底（finance / inventory / mrp / system 四个目录）；
  3. `/menu-group/{id}` 最终兜底。
- 图标：用 `icon` 字段在 `menuIconMap` 注册表中查组件，查不到兜底 `DashboardOutlined`。注册表与菜单管理页的 `iconOptions` 保持一致（扩充时两边同步改）。

### 3.2 `mergeMenuTrees()`：数据库树合并进静态 `menuData`

- 以 path 为匹配键：
  - 数据库菜单的 path 在静态树中已存在 → 用数据库的 `menu_name` 覆盖名称，并递归合并子级；
  - 不存在 → push 进结果。
- 排序：按数据库 `sort_order`（`databasePathOrder`）排列；首页 `/` 始终第一；静态菜单排末尾。
- 注意：同名 path 合并只覆盖显示名称，页面本身仍走静态路由（见第 5 节）。

## 4. 权限过滤与渲染

- `visibleMenuData`：
  - 超级管理员：全量；
  - 普通用户：按 `user.menuPaths` 过滤，保留 `/` 和仍有可见子级的节点。
- 结果传给 `AntProLayout` 的 `route` 与 `menuDataRender`，渲染到侧边栏/顶栏。
- 点击菜单项由 `menuItemRender` 内的 `navigate(item.path)` 跳转路由。
- Tab 标签页：`pathToTranslationKey` 命中则用 i18n 文案，否则用 `findMenuName` 在合并后的菜单树中找名称。

## 5. 路由挂载（`src/App.tsx`）

- 自定义页面统一注册在 `<Route path="custom/:slug" element={<CustomPageRenderer />} />`。
- `CustomPageRenderer`（`src/features/page-builder/PageRenderer.tsx`）按 URL 中的 slug 从 `sys_custom_pages` 加载配置并动态渲染。
- 静态菜单（如 `/finance/subjects`）走 App.tsx 中的静态路由表；数据库菜单若与其 path 相同，仅覆盖显示名称。

## 6. 关键约定与注意事项

| 事项 | 说明 |
|---|---|
| 幂等键 | 页面发布用 `menu_code = custom_${slug}` 保证重复发布不会产生重复菜单 |
| 软删除 | `is_deleted='y'` 即从读取结果剔除，不做物理删除 |
| 启用状态 | `status='1'` 才会显示 |
| 图标注册表 | `ProLayout.menuIconMap` 与 `Menus.iconOptions` 必须同步维护 |
| 刷新事件 | 新增菜单写入入口时，记得派发 `menus-changed` 或 `custom-pages-changed` |
| path 冲突 | 数据库菜单与静态菜单 path 相同时，仅覆盖名称，路由不变 |

## 7. 涉及文件清单

| 文件 | 职责 |
|---|---|
| `src/components/ProLayout.tsx` | 读取、组树、合并、权限过滤、渲染、图标注册表 |
| `src/pages/system/Menus.tsx` | 菜单增删改、排序、图标选择 |
| `src/features/page-builder/api.ts` | 页面发布时自动创建/更新菜单 |
| `src/features/page-builder/PageRenderer.tsx` | 自定义页面运行时渲染 |
| `src/App.tsx` | `custom/:slug` 路由注册 |
| `src/pages/system/Roles.tsx` | 角色-菜单授权 |
