-- ============================================================================
-- deploy_138：3D 工厂驾驶舱 —— 库位库存视图
--   场景：点击 3D 场景中的「仓储房屋」场景对象（bindId = 仓库 id），
--   右侧面板列出该仓库下所有库位的库存量 / 占用量 / 可用量。
--
--   口径：库存事实表 erp_inventory 已含 location_id（库位）、warehouse_id（仓库），
--   按「仓库 + 库位」聚合三个数字：
--     · on_hand_quantity   库存量 = SUM(quantity)
--     · locked_quantity    占用量 = SUM(locked_quantity)
--     · available_quantity 可用量 = SUM(available_quantity)
--   不区分 stock_status（available/inspection/rejected 等一并合计）。
--   security_invoker = true：走底层表 RLS，租户隔离与其它 factory 视图一致。
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_factory_3d_bin_stock
  WITH (security_invoker = true) AS
SELECT
  inv.tenant_id,
  inv.warehouse_id,
  wh.code                       AS warehouse_code,
  wh.name                       AS warehouse_name,
  inv.location_id               AS bin_id,
  b.code                        AS bin_code,
  b.name                        AS bin_name,
  b.location                    AS bin_location,
  SUM(COALESCE(inv.quantity, 0))           AS on_hand_quantity,
  SUM(COALESCE(inv.locked_quantity, 0))    AS locked_quantity,
  SUM(COALESCE(inv.available_quantity, 0)) AS available_quantity
FROM public.erp_inventory_s_539dcf81_b inv
LEFT JOIN public.erp_warehouses_s_539dcf81_b wh
       ON wh.id = inv.warehouse_id AND wh.tenant_id = inv.tenant_id
LEFT JOIN public.erp_bins_s_539dcf81_b b
       ON b.id = inv.location_id AND b.tenant_id = inv.tenant_id
WHERE COALESCE(inv.is_deleted, 'n') = 'n'
GROUP BY inv.tenant_id, inv.warehouse_id, wh.code, wh.name,
         inv.location_id, b.code, b.name, b.location;

GRANT SELECT ON public.vw_factory_3d_bin_stock TO authenticated;
