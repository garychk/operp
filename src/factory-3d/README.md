# factory-3d

基于 React + react-three-fiber 的 3D 工厂生产驾驶舱组件库，供 **supabase-erp** 以 npm 组件方式集成（方案②）。

数据全部来自 supabase-erp 现有生产制造表，经 `deploy_135` 的三个视图直出：

| 视图 | 内容 | 数据来源 |
|------|------|---------|
| `vw_factory_3d_devices` | 设备（工作中心）坐标、当班工单/工序、running/idle/offline 状态 | `erp_work_centers` + `factory_3d_device_layout` + `erp_production_order_operations` |
| `vw_factory_3d_orders` | 在制工单进度（入库/报工双口径）、物料齐套汇总、逾期天数 | `vw_erp_production_progress` + `erp_production_order_details` |
| `vw_factory_3d_order_operations` | 工单工序明细（活儿跑到哪一道） | `erp_production_order_operations` + `erp_operations` + `erp_employees` |

状态口径（全部从业务事实推导，无人工维护字段）：

- 设备 **running** = 该工作中心有 `in_progress` 工序（且工作中心 active）；**idle** = active 但无在制工序；**offline** = 工作中心非 active
- 物料 **齐套** = 工单材料行 `issued_quantity >= planned_quantity`（领料过账回写）

## 工程结构

```
├── src/lib/            组件库源码（构建产物入口）
│   ├── FactoryScene.tsx    3D 场景组件（对外主入口）
│   ├── store.ts            zustand 状态层（deviceRows / orders / operations）
│   ├── adapters.ts         DeviceRow → 3D 设备模型（坐标缺省自动排布）
│   ├── components/         地面 / 厂房 / 设备（铭牌带当班订单徽标）
│   ├── types.ts            与视图字段逐一对齐的类型
│   └── mockDevices / mockDashboard / mockRealtime   演示数据
├── src/demo/           本地演示驾驶舱（KPI 条 + 订单/工序/物料面板）
├── types/index.d.ts    组件库类型声明
└── vite.config.ts      lib 模式构建配置
```

## 本地开发

```bash
npm install
npm run dev     # 演示驾驶舱 http://localhost:5173
npm run build   # 构建 ES 模块包 → dist/factory-3d.es.js
```

## 在 supabase-erp 中集成

### 1. 数据库：执行 deploy_135（一次性，可选增强件）

> `deploy_135` **不在** supabase-erp 的 `000_run_all_*` 主线清单里（ERP 不依赖它），
> 用 3D 驾驶舱时手动单独执行；文件幂等，可重复跑。

```bash
cd D:/Projects/supabase-erp
NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules" \
PGPASSWORD=<本机库口令> node ./scripts/verify/run-migration.cjs supabase/tables/deploy_135_factory_3d_dashboard.sql
```

产出：布局表 `factory_3d_device_layout_s_539dcf81_b`（工作中心 → 场景坐标，超级管理员/租户管理员可维护）+ 三个视图。未配置坐标的设备会自动按行序排布兜底。

### 2. 安装组件

```bash
# 联调期：本地路径安装，3D 端 npm run build 后即生效
npm install D:/Projects/3D-Factory
```

### 3. 页面接线（含多语言与主题跟随）

```tsx
import { useEffect } from 'react'
import { FactoryScene, useFactoryStore } from 'factory-3d'
import { supabase } from '../lib/supabase' // ERP 内已有的 supabase-js 客户端
import { useTranslation } from 'react-i18n' // ERP 内已有的 i18n
import { useErpDarkMode } from '../hooks/useErpDarkMode'

export default function Factory3DPage() {
  const { i18n } = useTranslation()        // 'zh-CN' | 'en-US'
  const isDark = useErpDarkMode()          // ERP 现有暗色 hook

  useEffect(() => {
    let dispose: (() => void) | undefined
    ;(async () => {
      const { setDeviceRows, setOrders, setOperations } = useFactoryStore.getState()
      // RLS 视图，登录用户 JWT 直查即可
      const [dev, ord, ops] = await Promise.all([
        supabase.from('vw_factory_3d_devices').select('*'),
        supabase.from('vw_factory_3d_orders').select('*'),
        supabase.from('vw_factory_3d_order_operations').select('*'),
      ])
      if (dev.data) setDeviceRows(dev.data)
      if (ord.data) setOrders(ord.data)
      if (ops.data) setOperations(ops.data)

      // 实时刷新：监听底层业务表变更后重拉视图（视图不进 postgres_changes）
      const channel = supabase.channel('factory-3d')
        .on('postgres_changes', { event: '*', schema: 'public',
             table: 'erp_production_order_operations_s_539dcf81_b' }, refetch)
        .on('postgres_changes', { event: '*', schema: 'public',
             table: 'erp_production_orders_s_539dcf81_b' }, refetch)
        .subscribe()
      dispose = () => { supabase.removeChannel(channel) }
    })()
    return () => dispose?.()
  }, [])

  return (
    <div style={{ width: '100%', height: 'calc(100vh - 64px)' }}>
      {/* theme / locale 受控 props：跟随宿主切换，无需 3D 组件自己管理 */}
      <FactoryScene
        theme={isDark ? 'dark' : 'light'}
        locale={i18n.language}          // 'zh-CN'/'en-US' 自动归一为 'zh'/'en'
        onDeviceSelect={(code) => {
          if (code) openErpPanel(code) // 联动 ERP 业务面板
        }}
      />
    </div>
  )
}
```

多语言说明：

- 组件库内置文案（3D 设备铭牌的状态字样）走 `LIB_DICT`（zh/en 两套），跟随 `locale` prop 切换
- 订单号/产品名/设备名等**数据内容**由视图直出，多语言由 ERP 数据侧决定（与 ERP 其他页面同策略）
- 驾驶舱面板（KPI、订单/物料/工序）属宿主 UI，用 ERP 自己的 i18n key 实现（可参照 `src/demo/DemoApp.tsx` + `src/demo/i18n.ts` 的词典结构直接搬）

> 表名以库内实际后缀为准（当前快照为 `_s_539dcf81_b`，多环境部署时用 `pg_tables` 确认）。

### 4. 维护设备布局

3D 场景里设备的位置来自 `factory_3d_device_layout`。给工作中心配置坐标：

```sql
insert into factory_3d_device_layout_s_539dcf81_b (work_center_id, scene_x, scene_z)
values (1, -7, -3), (2, -2.5, -3), (3, 2.5, -3)
on conflict (tenant_id, work_center_id) do update
  set scene_x = excluded.scene_x, scene_z = excluded.scene_z, updated_at = now();
```

不配置也能跑（自动排布），配置后即为真实车间平面图。

## 注意事项

- **React 版本对齐**：组件库按 **React 18 + R3F v8 + drei v9** 基线开发（与 supabase-erp 的 React 18.2 一致），peer 限制 `react >=18 <20`。宿主升级 React 19 时改用 `@react-three/fiber@9 + drei@10` 重装本包 dev 依赖并重新构建即可。
- **按需加载**：在 ERP 中用 `React.lazy(() => import('factory-3d'))` 懒加载 3D 页面，three.js 不进首包。
- **驾驶舱面板归属**：KPI 条、订单/物料/工序面板属 ERP 业务 UI，建议在 supabase-erp 侧实现（可参照本仓库 `src/demo/DemoApp.tsx` 直接搬运）；组件库只负责 3D 场景与状态。
- **模型升级路径**：当前为程序化低多边形；后续 Blender 建 GLB（Draco 压缩）后替换 `Device` 内几何体即可，状态灯/交互逻辑不变。
