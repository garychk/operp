import { loadEntityCatalog, buildEntityDef, evaluateWritePolicy, resolveEntityForState, resolveForeignKeyValues, shortKeyOf } from "../tools/entityRegistry.js";

async function main() {
  const tables = await loadEntityCatalog(true);
  console.log("表总数:", tables.length);
  console.log("可写表数:", tables.filter((t) => evaluateWritePolicy(t.table, t.module).writable).length);

  const uom = tables.find((t) => shortKeyOf(t.table) === "uoms");
  if (!uom) throw new Error("未找到 uoms 表");
  const def = buildEntityDef(uom);
  console.log("\n--- uoms 动态定义 ---");
  console.log("table:", def.tableName, "| label:", def.label, "| key:", def.key);
  console.log("codeField:", def.codeField, "| nameField:", def.nameField);
  console.log("required:", def.requiredFields.map((f) => `${f.key}=${f.label}`).join(", "));
  console.log("defaults:", JSON.stringify(def.defaults()));
  console.log("writable:", def.writable);
  console.log("insertable:", def.insertableFields.join(", "));

  console.log("\n--- 写保护 ---");
  for (const name of ["erp_gl_entries", "erp_voucher_details_s_539dcf81_b", "erp_inventory_transactions_s_539dcf81_b", "sys_roles", "sys_users", "sys_user_roles", "sys_role_menus", "erp_uoms_s_539dcf81_b", "erp_stock_counts_s_539dcf81_b"]) {
    const policy = evaluateWritePolicy(name, name.startsWith("sys_") ? "system" : "erp");
    console.log(`${name}: ${policy.writable ? "可写" : "只读"} ${policy.reason || ""}`);
  }

  console.log("\n--- 外键解析（只给名称） ---");
  const fk = await resolveForeignKeyValues(def, { code: "ML", name: "毫升", group_id: "体积" });
  console.log(JSON.stringify(fk));

  main_tail();
}

async function main_tail() {
  console.log("\n--- 实体识别 ---");
  const samples = [
    "在字典uom中帮我在增加一个单位毫升",
    "帮我新增一个客户，编码 C001，名称 测试客户",
    "创建一个采购订单",
    "新增一个库存盘点单",
    "帮我把这些凭证删掉",
  ];
  for (const text of samples) {
    const result = await resolveEntityForState({ sessionId: "test", text, skill: "create", recentMessages: [] } as never);
    console.log(`「${text}」 ->`, result.def ? `${result.def.label} (${result.def.tableName}) writable=${result.def.writable}` : result.error);
  }

  // 系统字典（sys_dict_items）与业务表（erp_*）是两套数据，必须区分开
  console.log("\n--- 系统字典 vs 业务表 ---");
  const dictSamples = [
    "帮我在字典uom里加一个单位厘米",
    "在字典里加一个厘米",
    "帮我在性别字典里加一个未知",
    "帮我加一个计量单位厘米",
    "帮我加一个单位厘米",
  ];
  for (const text of dictSamples) {
    const result = await resolveEntityForState({ sessionId: "test", text, skill: "create", recentMessages: [] } as never);
    console.log(`「${text}」 ->`, result.def ? `${result.def.label} (${result.def.tableName})` : result.error);
  }

  const dictTable = (await loadEntityCatalog()).find((t) => t.table === "sys_dict_items");
  if (dictTable) {
    const dictDef = buildEntityDef(dictTable);
    console.log("\n--- 字典项实体 ---");
    console.log("table:", dictDef.tableName, "| nameField:", dictDef.nameField, "| writable:", dictDef.writable);
    console.log("required:", dictDef.requiredFields.map((f) => `${f.key}=${f.label}`).join(", "));
    console.log("defaults:", JSON.stringify(dictDef.defaults()));
    const fk = await resolveForeignKeyValues(dictDef, { type_id: "uom", code: "cm", label: "厘米" });
    console.log("type_id 解析:", JSON.stringify(fk.payload), "|", fk.resolved.join(","));
  }
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
