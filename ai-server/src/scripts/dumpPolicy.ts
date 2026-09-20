import { loadEntityCatalog, evaluateWritePolicy } from "../tools/entityRegistry.js";

const tables = await loadEntityCatalog();
const w: string[] = [];
const r: string[] = [];
for (const t of tables) {
  const p = evaluateWritePolicy(t.table, t.module);
  (p.writable ? w : r).push(t.table.replace(/_s_[0-9a-f]{6,}_[a-z]$/i, ""));
}
console.log("可写 " + w.length + "：\n" + w.join(", "));
console.log("\n只读 " + r.length + "：\n" + r.join(", "));
