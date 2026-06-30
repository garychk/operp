-- 1. 关闭外键约束检查
SET session_replication_role = 'replica';

-- 2. 批量删除 public 下所有表
DO $$
DECLARE
    tbl RECORD;
BEGIN
    FOR tbl IN
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
    LOOP
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE;', tbl.table_name);
    END LOOP;
END $$;

-- 3. 恢复权限
SET session_replication_role = 'origin';