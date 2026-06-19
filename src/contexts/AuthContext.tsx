import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../utils/supabase';
import { logOperation } from '../utils/logger';
import type { SysRolesRow, SysUsersRow } from '../types/database';

interface AuthContextType {
  user: AppUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
}

export type SysUser = SysUsersRow & {
  auth_id: string | null;
};

export type Role = SysRolesRow;

export interface AppUser {
  auth: User;
  profile: SysUser;
  roles: Role[];
  menuPaths: string[];
  isSuperAdmin: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  const loadAppUser = useCallback(async (authUser: User): Promise<AppUser> => {
    const { data: existingProfile, error: profileError } = await supabase
      .from('sys_users')
      .select('*')
      .eq('auth_id', authUser.id)
      .maybeSingle();

    if (profileError) {
      throw profileError;
    }

    let profile = existingProfile as SysUser | null;

    if (!profile) {
      const email = authUser.email ?? '';
      if (email) {
        const { data: emailProfile, error: emailProfileError } = await supabase
          .from('sys_users')
          .select('*')
          .eq('email', email)
          .eq('is_deleted', 'n')
          .maybeSingle();

        if (emailProfileError) {
          throw emailProfileError;
        }

        if (emailProfile) {
          const { data: linkedProfile, error: linkError } = await supabase
            .from('sys_users')
            .update({ auth_id: authUser.id })
            .eq('id', emailProfile.id)
            .select('*')
            .single();

          if (linkError) {
            throw linkError;
          }

          profile = linkedProfile as SysUser;
        }
      }
    }

    if (!profile) {
      const email = authUser.email ?? '';
      const username =
        authUser.user_metadata?.username ||
        authUser.user_metadata?.nick ||
        email ||
        authUser.id;

      const { data: createdProfile, error: insertError } = await supabase
        .from('sys_users')
        .upsert([{
          auth_id: authUser.id,
          username,
          email,
          real_name: authUser.user_metadata?.real_name || authUser.user_metadata?.name || null,
          avatar_url: authUser.user_metadata?.avatar || authUser.user_metadata?.avatar_url || null,
          password_hash: '$supabase_auth$',
          status: '1',
          is_deleted: 'n',
        }], { onConflict: 'auth_id' })
        .select('*')
        .single();

      if (insertError) {
        throw insertError;
      }

      profile = createdProfile as SysUser;
    }

    const { data: userRoles, error: userRolesError } = await supabase
      .from('sys_user_roles')
      .select('role_id')
      .eq('user_id', profile.id)
      .eq('is_deleted', 'n');

    if (userRolesError) {
      throw userRolesError;
    }

    const roleIds = (userRoles || [])
      .map((item) => item.role_id)
      .filter((roleId): roleId is number => typeof roleId === 'number');

    let roles: Role[] = [];
    if (roleIds.length > 0) {
      const { data: roleRows, error: rolesError } = await supabase
        .from('sys_roles')
        .select('*')
        .in('id', roleIds)
        .eq('is_deleted', 'n');

      if (rolesError) {
        throw rolesError;
      }

      roles = (roleRows || []) as Role[];
    }

    const { data: superAdminResult, error: superAdminError } = await supabase
      .rpc('current_user_is_super_admin');

    if (superAdminError) {
      throw superAdminError;
    }

    const isSuperAdmin = Boolean(superAdminResult) || roles.some((role) => role.role_code === 'super_admin');
    let menuPaths: string[] = [];

    if (!isSuperAdmin && roleIds.length > 0) {
      const { data: menus, error: menusError } = await supabase
        .rpc('current_user_menu_paths');

      if (menusError) {
        throw menusError;
      }

      const rows = (menus || []) as Array<{ path: string | null }>;
      menuPaths = Array.from(new Set(
        rows
          .map((menu) => menu.path)
          .filter((path): path is string => typeof path === 'string' && path.length > 0),
      ));
    }

    return {
      auth: authUser,
      profile,
      roles,
      menuPaths,
      isSuperAdmin,
    };
  }, []);

  useEffect(() => {
    const fetchSession = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        setUser(session?.user ? await loadAppUser(session.user) : null);
      } catch (error) {
        console.error('Failed to load auth session:', error);
        setUser(null);
      } finally {
        setLoading(false);
      }
    };

    fetchSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!session?.user) {
        setUser(null);
        setLoading(false);
        return;
      }

      try {
        setUser(await loadAppUser(session.user));
      } catch (error) {
        console.error('Failed to load app user:', error);
        setUser(null);
      } finally {
        setLoading(false);
      }
    });

    return () => {
      subscription?.unsubscribe();
    };
  }, [loadAppUser]);

  const login = async (username: string, password: string): Promise<boolean> => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: username,
        password,
      });
      
      if (error) {
        console.error('Login error:', error);
        return false;
      }
      
      if (!data.user) {
        return false;
      }

      const appUser = await loadAppUser(data.user);
      setUser(appUser);
      await logOperation({
        operation: '用户登录',
        method: 'LOGIN',
        params: {
          user_id: appUser.profile.id,
          username: appUser.profile.username,
        },
        status: 'success',
      });
      return true;
    } catch (err) {
      console.error('Login exception:', err);
      return false;
    }
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
