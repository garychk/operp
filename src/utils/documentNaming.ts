import { supabase } from './supabase';

/**
 * Ask the database for the next document number of `documentType`,
 * rendered from sys_document_types.naming_rule (e.g. PO{YYYY}{####} -> PO20260001).
 *
 * 失败一律抛错，不做降级。以前 RPC 出错会退回时间戳编号（形如 PO12345678），
 * 表面能用，实际绕开了编号规则和计数器：号段出现两套规则、序列被跳过，
 * 而且计数器已按租户隔离、时间戳编号不属于任何租户 —— 等于写出一条
 * 编号不合规且无租户归属的单据。宁可让操作失败并明确提示。
 *
 * 调用方必须自己兜住错误（多数是「新增」按钮：拿不到号就不开弹窗），
 * 否则会变成未捕获的 Promise rejection。
 *
 * Note: the RPC consumes a sequence number even if the user abandons the form,
 * so gaps are possible — same behaviour as ERPNext's naming series.
 */
export const nextDocumentNo = async (documentType: string): Promise<string> => {
  const { data, error } = await supabase.rpc('generate_document_no', {
    p_document_type: documentType,
  });

  if (error) throw error;
  if (typeof data === 'string' && data.trim() !== '') return data;

  throw new Error(`generate_document_no returned an empty result for "${documentType}"`);
};
