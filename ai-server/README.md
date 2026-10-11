# ERP AI Server

独立的 Node API + LangGraph 服务。

## 启动

```bash
npm install
npm run dev
```

## 接口

- `GET /api/health`
- `POST /api/ai/chat`
- `POST /api/ai/knowledge/parse` —— 上传文件（multipart，字段名 `files`）抽取纯文本，
  支持 `.docx` / `.pdf` / `.txt` / `.md` / `.markdown` / `.log` / `.csv`；
  **只解析不写库**，入库由前端带 JWT 直连 PostgREST（RLS 生效）
- `POST /api/ai/knowledge/reindex` —— 重建向量索引；`doc_id` / `doc_ids` 限定范围，都不传 = 全量

以上 `/api/ai/*` 端点均需 `Authorization: Bearer <Supabase access_token>`。
