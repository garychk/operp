import { supabase } from './supabase';

// Fallback prefixes per document type, used when the naming RPC is unavailable
// (offline / rule not configured) so the UI still gets a usable unique number.
const DOC_NO_PREFIX: Record<string, string> = {
  purchase_order: 'PO',
  sales_order: 'SO',
  purchase_receipt: 'PR',
  sales_delivery: 'SD',
  inventory_transfer: 'TR',
  stock_count: 'SC',
  stock_adjustment: 'SA',
  voucher: 'V',
  production_order: 'MO',
  material_issue: 'MI',
  mrp_plan: 'MRP',
  bom: 'BOM',
  routing: 'RT',
};

const timestampFallback = (documentType: string) => {
  const prefix = DOC_NO_PREFIX[documentType] ?? documentType.slice(0, 2).toUpperCase();
  return `${prefix}${Date.now().toString().slice(-8)}`;
};

/**
 * Ask the database for the next document number of `documentType`,
 * rendered from sys_document_types.naming_rule (e.g. PO{YYYY}{####} -> PO20260001).
 * Falls back to the legacy timestamp-based number when the RPC fails.
 *
 * Note: the RPC consumes a sequence number even if the user abandons the form,
 * so gaps are possible — same behaviour as ERPNext's naming series.
 */
export const nextDocumentNo = async (documentType: string): Promise<string> => {
  try {
    const { data, error } = await supabase.rpc('generate_document_no', {
      p_document_type: documentType,
    });
    if (error) throw error;
    if (typeof data === 'string' && data.trim() !== '') return data;
    throw new Error('generate_document_no returned an empty result');
  } catch (error) {
    console.warn(
      `[documentNaming] generate_document_no failed for "${documentType}", falling back to timestamp number`,
      error,
    );
    return timestampFallback(documentType);
  }
};
