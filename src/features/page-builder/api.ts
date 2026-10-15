import { supabase } from '../../utils/supabase';
import type { CustomPage } from './types';

export async function listCustomPages() {
  const { data, error } = await supabase.from('sys_custom_pages').select('*').eq('is_deleted', 'n').order('updated_at', { ascending: false });
  if (error) throw error;
  return (data || []) as CustomPage[];
}

export async function getCustomPage(slug: string) {
  const { data, error } = await supabase.from('sys_custom_pages').select('*').eq('slug', slug).eq('is_deleted', 'n').single();
  if (error) throw error;
  return data as CustomPage;
}

export async function saveCustomPage(page: CustomPage) {
  const payload = { name: page.name, slug: page.slug, description: page.description || null, status: page.status, config: page.config, updated_at: new Date().toISOString() };
  if (page.id) {
    const { data, error } = await supabase.from('sys_custom_pages').update(payload).eq('id', page.id).select().single();
    if (error) throw error;
    return data as CustomPage;
  }
  const { data, error } = await supabase.from('sys_custom_pages').insert(payload).select().single();
  if (error) throw error;
  return data as CustomPage;
}

export async function publishCustomPage(page: CustomPage) {
  const saved = await saveCustomPage({ ...page, status: 'published' });
  const path = `/custom/${saved.slug}`;
  const menuPayload = { parent_id: 0, menu_name: saved.name, menu_code: `custom_${saved.slug}`, menu_type: 'C', icon: 'DashboardOutlined', path, component: 'CustomPageRenderer', sort_order: 90, status: '1', is_deleted: 'n' };
  let menuId = saved.menu_id;
  if (menuId) {
    const { error } = await supabase.from('sys_menus').update(menuPayload).eq('id', menuId);
    if (error) throw error;
  } else {
    const { data: existingMenu, error: lookupError } = await supabase
      .from('sys_menus')
      .select('id')
      .eq('menu_code', menuPayload.menu_code)
      .eq('is_deleted', 'n')
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (existingMenu) {
      menuId = existingMenu.id;
      const { error } = await supabase.from('sys_menus').update(menuPayload).eq('id', menuId);
      if (error) throw error;
    } else {
      const { data, error } = await supabase.from('sys_menus').insert(menuPayload).select('id').single();
      if (error) throw error;
      menuId = data.id;
    }
    const { error: pageError } = await supabase.from('sys_custom_pages').update({ menu_id: menuId }).eq('id', saved.id!);
    if (pageError) throw pageError;
  }
  window.dispatchEvent(new Event('custom-pages-changed'));
  return { ...saved, menu_id: menuId };
}

export interface DeletePageResult {
  ok: boolean;
  /** 被引用（已发布并在菜单中生成入口）而阻止删除 */
  referenced?: boolean;
  menuName?: string;
}

/**
 * 删除自定义页面：先校验是否被引用（已发布页面会在 sys_menus 生成菜单项），
 * 被引用的页面阻止删除，避免菜单入口失效；未被引用的页面走软删除（is_deleted = 'y'）。
 */
export async function deleteCustomPage(page: CustomPage): Promise<DeletePageResult> {
  if (!page.id) return { ok: true };
  const menuCode = `custom_${page.slug}`;
  const { data: menu, error: menuErr } = await supabase
    .from('sys_menus')
    .select('id, menu_name')
    .eq('menu_code', menuCode)
    .eq('is_deleted', 'n')
    .maybeSingle();
  if (menuErr) throw menuErr;
  if (menu) {
    return { ok: false, referenced: true, menuName: (menu as { menu_name?: string }).menu_name };
  }
  const { error } = await supabase
    .from('sys_custom_pages')
    .update({ is_deleted: 'y' })
    .eq('id', page.id);
  if (error) throw error;
  window.dispatchEvent(new Event('custom-pages-changed'));
  return { ok: true };
}
