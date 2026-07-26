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

  if (currentPath !== '/' && !user.isSuperAdmin && !hasMenuPermission) {
    return <Forbidden />;
  }

  return <>{children}</>;
};


