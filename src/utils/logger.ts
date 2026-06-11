import { supabase } from './supabase';

export interface LogParams {
  operation: string;
  method: string;
  params?: Record<string, any>;
  executeTime?: number;
  status?: 'success' | 'error';
  errorMsg?: string;
}

export async function logOperation(logParams: LogParams) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const username = session?.user?.user_metadata?.nick || session?.user?.email || 'anonymous';

    await supabase.from('sys_logs').insert({
      username,
      operation: logParams.operation,
      method: logParams.method,
      params: logParams.params || null,
      ip: '',
      user_agent: navigator.userAgent,
      execute_time: logParams.executeTime || 0,
      status: logParams.status === 'success' ? '1' : '0',
      error_msg: logParams.errorMsg || null,
    });
  } catch (e) {
    console.error('Failed to write log:', e);
  }
}

export async function logWithTiming<T>(
  operation: string,
  method: string,
  fn: () => Promise<T>,
  params?: Record<string, any>
): Promise<T> {
  const startTime = Date.now();
  try {
    const result = await fn();
    const executeTime = Date.now() - startTime;
    await logOperation({
      operation,
      method,
      params,
      executeTime,
      status: 'success',
    });
    return result;
  } catch (error: any) {
    const executeTime = Date.now() - startTime;
    await logOperation({
      operation,
      method,
      params,
      executeTime,
      status: 'error',
      errorMsg: error?.message || String(error),
    });
    throw error;
  }
}
