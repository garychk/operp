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
