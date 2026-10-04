import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Spin } from 'antd';
import { Forbidden } from '../pages/Forbidden';

interface RouteGuardProps {
  children: ReactNode;
}

const normalizePath = (path: string) => {
  const normalized = path.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  return normalized || '/';
};

// 个人页面（不属于任何业务菜单，也不参与基线-副本菜单授权）：
// 只要登录成功就允许访问，否则非超管用户点开会被判成「无权限」。
const PERSONAL_PATHS = new Set<string>(['/workbench']);

export function ProtectedRoute({ children }: RouteGuardProps) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
      }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
};

export function MenuPermissionGuard({ children }: RouteGuardProps) {
  const { user } = useAuth();
  const location = useLocation();

  if (!user) {
    return null;
  }

  const currentPath = normalizePath(location.pathname);
  const hasMenuPermission = user.menuPaths.some(
    (path) => normalizePath(path) === currentPath,
  );

  if (currentPath !== '/' && !PERSONAL_PATHS.has(currentPath) && !user.isSuperAdmin && !hasMenuPermission) {
    return <Forbidden />;
  }

  return <>{children}</>;
};


