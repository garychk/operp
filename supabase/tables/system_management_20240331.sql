CREATE TABLE IF NOT EXISTS public.sys_users (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    real_name VARCHAR(100),
    email VARCHAR(255),
    phone VARCHAR(50),
    avatar_url TEXT,
    status CHAR(1) DEFAULT '1',
    last_login_at TIMESTAMP WITH TIME ZONE,
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sys_roles (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    role_code VARCHAR(100) NOT NULL UNIQUE,
    role_name VARCHAR(100) NOT NULL,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    status CHAR(1) DEFAULT '1',
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sys_user_roles (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    user_id INTEGER NOT NULL REFERENCES public.sys_users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES public.sys_roles(id) ON DELETE CASCADE,
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, role_id)
);

CREATE TABLE IF NOT EXISTS public.sys_menus (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    parent_id INTEGER DEFAULT 0,
    menu_name VARCHAR(100) NOT NULL,
    menu_code VARCHAR(100),
    menu_type CHAR(1) DEFAULT 'M',
    icon VARCHAR(100),
    path VARCHAR(255),
    component VARCHAR(255),
    sort_order INTEGER DEFAULT 0,
    status CHAR(1) DEFAULT '1',
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sys_role_menus (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    role_id INTEGER NOT NULL REFERENCES public.sys_roles(id) ON DELETE CASCADE,
    menu_id INTEGER NOT NULL REFERENCES public.sys_menus(id) ON DELETE CASCADE,
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(role_id, menu_id)
);

CREATE TABLE IF NOT EXISTS public.sys_logs (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    user_id INTEGER REFERENCES public.sys_users(id),
    username VARCHAR(100),
    operation VARCHAR(100) NOT NULL,
    method VARCHAR(255),
    params TEXT,
    ip VARCHAR(50),
    user_agent TEXT,
    execute_time INTEGER,
    status CHAR(1) DEFAULT '1',
    error_msg TEXT,
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO public.sys_users (username, password_hash, real_name, email, phone, status) VALUES
('admin', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iAt6Z5EO', '系统管理员', 'admin@erp.com', '13800138000', '1'),
('zhangsan', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iAt6Z5EO', '张三', 'zhangsan@erp.com', '13800138001', '1'),
('lisi', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iAt6Z5EO', '李四', 'lisi@erp.com', '13800138002', '1');

INSERT INTO public.sys_roles (role_code, role_name, description, sort_order, status) VALUES
('super_admin', '超级管理员', '拥有所有权限', 1, '1'),
('finance_manager', '财务经理', '财务管理权限', 2, '1'),
('inventory_manager', '仓库管理员', '进销存管理权限', 3, '1'),
('mrp_manager', '生产主管', 'MRP管理权限', 4, '1'),
('operator', '普通操作员', '基本操作权限', 5, '1');

INSERT INTO public.sys_user_roles (user_id, role_id) VALUES
(1, 1),
(2, 2),
(2, 3),
(3, 5);

INSERT INTO public.sys_menus (parent_id, menu_name, menu_code, menu_type, icon, path, component, sort_order, status) VALUES
(0, '系统管理', 'system', 'M', 'SettingOutlined', '/system', NULL, 100, '1'),
(1, '用户管理', 'user', 'C', 'TeamOutlined', '/system/users', './pages/system/Users', 1, '1'),
(1, '角色管理', 'role', 'C', 'SafetyOutlined', '/system/roles', './pages/system/Roles', 2, '1'),
(1, '菜单管理', 'menu', 'C', 'MenuOutlined', '/system/menus', './pages/system/Menus', 3, '1'),
(1, '系统日志', 'log', 'C', 'FileTextOutlined', '/system/logs', './pages/system/Logs', 4, '1');

INSERT INTO public.sys_role_menus (role_id, menu_id) VALUES
(1, 1),
(1, 2),
(1, 3),
(1, 4),
(1, 5);

INSERT INTO public.sys_logs (user_id, username, operation, method, params, ip, status, created_at) VALUES
(1, 'admin', '用户登录', 'POST /api/login', '{"username":"admin"}', '192.168.1.100', '1', NOW() - INTERVAL '1 hour'),
(1, 'admin', '创建用户', 'POST /api/users', '{"username":"zhangsan"}', '192.168.1.100', '1', NOW() - INTERVAL '30 minutes'),
(2, 'zhangsan', '用户登录', 'POST /api/login', '{"username":"zhangsan"}', '192.168.1.101', '1', NOW() - INTERVAL '20 minutes'),
(2, 'zhangsan', '查询库存', 'GET /api/inventory', '{}', '192.168.1.101', '1', NOW() - INTERVAL '10 minutes');
