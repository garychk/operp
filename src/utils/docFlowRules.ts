import { supabase } from "./supabase";

export interface DocFlowRuleRow {
  id: number;
  rule_code: string;
  rule_name: string;
  source_document_type: string;
  target_document_type: string;
  source_quantity_field: string;
  source_detail_key_field: string;
  source_detail_parent_field: string;
  target_source_ref_field: string | null;
  require_source_approved: boolean | null;
  allowed_source_statuses: string[] | null;
}

// Used only when the column is missing, i.e. before deploy_35 was re-run with
// allowed_source_statuses. Being permissive here keeps the button clickable
// rather than greying every row out after a partial conversion.
const FALLBACK_STATUSES = [
  "approved",
  "partially_received",
  "partially_delivered",
  "partially_issued",
];

const cache = new Map<string, { at: number; rows: DocFlowRuleRow[] }>();
const TTL_MS = 5 * 60 * 1000;

export async function loadDocFlowRules(
  sourceDocumentType: string,
  force = false,
): Promise<DocFlowRuleRow[]> {
  const cached = cache.get(sourceDocumentType);
  if (!force && cached && Date.now() - cached.at < TTL_MS) {
    return cached.rows;
  }

  const { data, error } = await supabase
    .from("doc_flow_rules")
    .select("*")
    .eq("is_deleted", "n")
    .eq("is_active", true)
    .eq("source_document_type", sourceDocumentType)
    .order("id");
  if (error) throw error;

  const rows = (data || []) as unknown as DocFlowRuleRow[];
  cache.set(sourceDocumentType, { at: Date.now(), rows });
  return rows;
}

export function invalidateDocFlowRuleCache(sourceDocumentType?: string) {
  if (sourceDocumentType) {
    cache.delete(sourceDocumentType);
    return;
  }
  cache.clear();
}

export function isStatusAllowed(
  rule: DocFlowRuleRow,
  status?: string | null,
): boolean {
  if (!rule.require_source_approved) return true;
  const allowed = rule.allowed_source_statuses?.length
    ? rule.allowed_source_statuses
    : FALLBACK_STATUSES;
  return allowed.includes(status || "");
}
