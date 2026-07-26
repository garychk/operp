-- Unified inspections for purchasing, sales returns and production operations.
CREATE TABLE IF NOT EXISTS public.erp_sales_returns_s_539dcf81_b (
 id SERIAL PRIMARY KEY, corp_id VARCHAR(128), emp_id VARCHAR(128), is_deleted CHAR(1) DEFAULT 'n', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
 return_no VARCHAR(50) NOT NULL UNIQUE, return_date DATE NOT NULL, customer_id INTEGER REFERENCES public.erp_customers_s_539dcf81_b(id), delivery_id INTEGER REFERENCES public.erp_sales_deliveries_s_539dcf81_b(id), warehouse_id INTEGER REFERENCES public.erp_warehouses_s_539dcf81_b(id), reason TEXT,
 status VARCHAR(20) DEFAULT 'draft' CHECK(status IN('draft','submitted','inspecting','completed','cancelled'))
);
CREATE TABLE IF NOT EXISTS public.erp_sales_return_details_s_539dcf81_b (
 id SERIAL PRIMARY KEY, corp_id VARCHAR(128), emp_id VARCHAR(128), is_deleted CHAR(1) DEFAULT 'n', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
 return_id INTEGER NOT NULL REFERENCES public.erp_sales_returns_s_539dcf81_b(id) ON DELETE CASCADE, line_no INTEGER NOT NULL, delivery_detail_id INTEGER REFERENCES public.erp_sales_delivery_details_s_539dcf81_b(id), product_id INTEGER NOT NULL REFERENCES public.erp_products_s_539dcf81_b(id), quantity DECIMAL(18,4) NOT NULL CHECK(quantity>0), batch_no VARCHAR(50), reason TEXT, UNIQUE(return_id,line_no)
);
CREATE TABLE IF NOT EXISTS public.erp_quality_inspections_s_539dcf81_b (
 id SERIAL PRIMARY KEY, corp_id VARCHAR(128), emp_id VARCHAR(128), is_deleted CHAR(1) DEFAULT 'n', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
 inspection_no VARCHAR(50) NOT NULL UNIQUE, inspection_date DATE NOT NULL DEFAULT CURRENT_DATE, source_type VARCHAR(30) NOT NULL CHECK(source_type IN('purchase_receipt','sales_return','production_operation')), source_id INTEGER NOT NULL, source_detail_id INTEGER, source_no VARCHAR(50), product_id INTEGER NOT NULL REFERENCES public.erp_products_s_539dcf81_b(id), production_order_id INTEGER REFERENCES public.erp_production_orders_s_539dcf81_b(id), operation_id INTEGER REFERENCES public.erp_operations_s_539dcf81_b(id), batch_no VARCHAR(50),
 inspection_quantity DECIMAL(18,4) NOT NULL CHECK(inspection_quantity>0), sample_quantity DECIMAL(18,4) DEFAULT 0 CHECK(sample_quantity>=0), qualified_quantity DECIMAL(18,4) DEFAULT 0 CHECK(qualified_quantity>=0), unqualified_quantity DECIMAL(18,4) DEFAULT 0 CHECK(unqualified_quantity>=0), result VARCHAR(20) DEFAULT 'pending' CHECK(result IN('pending','qualified','unqualified','conditional')), status VARCHAR(20) DEFAULT 'pending' CHECK(status IN('pending','inspecting','completed','cancelled')), disposition VARCHAR(30) CHECK(disposition IS NULL OR disposition IN('accept','return','rework','scrap','concession','sort')), inspector VARCHAR(100), completed_at TIMESTAMP, remark TEXT, UNIQUE(source_type,source_id,source_detail_id)
);
CREATE TABLE IF NOT EXISTS public.erp_quality_inspection_items_s_539dcf81_b (
 id SERIAL PRIMARY KEY, corp_id VARCHAR(128), emp_id VARCHAR(128), is_deleted CHAR(1) DEFAULT 'n', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), inspection_id INTEGER NOT NULL REFERENCES public.erp_quality_inspections_s_539dcf81_b(id) ON DELETE CASCADE, item_name VARCHAR(100) NOT NULL, standard VARCHAR(255), method VARCHAR(100), measured_value VARCHAR(100), result VARCHAR(20) DEFAULT 'pending' CHECK(result IN('pending','qualified','unqualified')), defect_description TEXT, remark TEXT
);
CREATE INDEX IF NOT EXISTS idx_quality_source ON public.erp_quality_inspections_s_539dcf81_b(source_type,source_id);
CREATE INDEX IF NOT EXISTS idx_quality_status ON public.erp_quality_inspections_s_539dcf81_b(status,inspection_date DESC);
DO $$ BEGIN
 IF to_regprocedure('public.refresh_sys_tables()') IS NOT NULL THEN PERFORM public.refresh_sys_tables(); END IF;
 GRANT SELECT,INSERT,UPDATE,DELETE ON public.erp_sales_returns_s_539dcf81_b,public.erp_sales_return_details_s_539dcf81_b,public.erp_quality_inspections_s_539dcf81_b,public.erp_quality_inspection_items_s_539dcf81_b TO authenticated;
 GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
 IF to_regprocedure('public.install_role_table_rls(text)') IS NOT NULL THEN PERFORM public.install_role_table_rls('erp_sales_returns_s_539dcf81_b'); PERFORM public.install_role_table_rls('erp_sales_return_details_s_539dcf81_b'); PERFORM public.install_role_table_rls('erp_quality_inspections_s_539dcf81_b'); PERFORM public.install_role_table_rls('erp_quality_inspection_items_s_539dcf81_b'); END IF;
END $$;
