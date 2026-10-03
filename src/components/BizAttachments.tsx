import { useEffect, useState } from "react";
import { InboxOutlined } from "@ant-design/icons";
import { Modal, Spin, Upload, message } from "antd";
import type { UploadFile, UploadProps } from "antd";
import { useTranslation } from "react-i18next";
import { supabase } from "../utils/supabase";
import type { Tables } from "../utils/supabase";

type Attachment = Tables["erp_attachments_s_539dcf81_b"]["Row"];

/** 附件统一存放的 Storage 桶（deploy_79 创建 / deploy_80 放开文档 mime） */
export const ATTACHMENT_BUCKET = "uploadfiles";
/** 单文件大小上限：20MB（与桶配置一致） */
const MAX_FILE_SIZE_MB = 20;

/** 允许的扩展名：PDF / Word / Excel / Txt / Markdown */
const ALLOWED_EXTS = ["pdf", "doc", "docx", "xls", "xlsx", "txt", "md", "markdown"];

const attachmentTable = "erp_attachments_s_539dcf81_b";

/** 由桶内路径得到公开访问 URL（浏览器直接打开即下载/预览） */
export function attachmentPublicUrl(bucket: string, storagePath: string): string {
  const { data } = supabase.storage.from(bucket || ATTACHMENT_BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

interface BizAttachmentsProps {
  /** 业务类型，如 sales_order / purchase_order / supplier / bom ... */
  bizType: string;
  /** 已保存的业务记录 id；为空（新增未保存）时不可上传。 */
  bizId?: number | null;
  /** 附件增删后的回调。 */
  onChanged?: () => void;
}

/** 数据库行 uid 前缀：区分「已入库的附件」与「本地上传中的临时项」 */
const DB_UID_PREFIX = "db-";

/**
 * 业务附件通用组件（Dragger 拖拽样式）：
 * 多文件上传 / 列表展示 / 点击打开 / 删除（软删 + 尽力删存储对象）。
 * 元数据写 erp_attachments（biz_type + biz_id 通用引用）。
 */
export function BizAttachments({ bizType, bizId, onChanged }: BizAttachmentsProps) {
  const { t } = useTranslation();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [rows, setRows] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);

  /** uid -> 数据库行；仅已入库的附件可删除 */
  const rowMap = new Map<string, Attachment>(
    rows.map((r) => [`${DB_UID_PREFIX}${r.id}`, r]),
  );

  const fetchAttachments = async () => {
    if (!bizId) {
      setRows([]);
      setFileList([]);
      return;
    }
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(attachmentTable)
        .select("*")
        .eq("biz_type", bizType)
        .eq("biz_id", bizId)
        .eq("is_deleted", "n")
        .order("id", { ascending: true });
      if (error) throw error;
      const dbRows = data || [];
      setRows(dbRows);
      setFileList(
        dbRows.map((row) => ({
          uid: `${DB_UID_PREFIX}${row.id}`,
          name: row.file_name || row.storage_path.split("/").pop() || "file",
          status: "done" as const,
          url: attachmentPublicUrl(row.bucket, row.storage_path),
        })),
      );
    } catch (error) {
      console.error("Error fetching attachments:", error);
      message.error(t("attachments.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAttachments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bizType, bizId]);

  const beforeUpload: UploadProps["beforeUpload"] = (file) => {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) {
      message.error(t("attachments.invalidType"));
      return Upload.LIST_IGNORE;
    }
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      message.error(t("attachments.tooLarge", { size: MAX_FILE_SIZE_MB }));
      return Upload.LIST_IGNORE;
    }
    return true;
  };

  const handleUpload = async (options: {
    file: unknown;
    onSuccess?: (body: unknown) => void;
    onError?: (event: Error) => void;
  }) => {
    const { file, onError, onSuccess } = options;
    if (!bizId) {
      message.warning(t("attachments.saveHint"));
      onError?.(new Error(t("attachments.saveHint")));
      return;
    }
    const uploadFile = file as File;

    try {
      const fileExt = (uploadFile.name.split(".").pop() || "bin").toLowerCase();
      const rand = Math.random().toString(36).slice(2, 8);
      const storagePath = `${bizType}/${bizId}/${Date.now()}-${rand}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from(ATTACHMENT_BUCKET)
        .upload(storagePath, uploadFile, {
          cacheControl: "3600",
          contentType: uploadFile.type || undefined,
        });
      if (uploadError) throw uploadError;

      const { error: insertError } = await supabase.from(attachmentTable).insert([
        {
          biz_type: bizType,
          biz_id: bizId,
          bucket: ATTACHMENT_BUCKET,
          storage_path: storagePath,
          file_name: uploadFile.name,
          file_size: uploadFile.size,
          mime_type: uploadFile.type || null,
        },
      ]);
      if (insertError) {
        // 行写入失败则回滚存储对象，避免孤儿文件
        await supabase.storage.from(ATTACHMENT_BUCKET).remove([storagePath]);
        throw insertError;
      }

      message.success(t("attachments.uploadSuccess", { name: uploadFile.name }));
      onSuccess?.(storagePath);
      await fetchAttachments();
      onChanged?.();
    } catch (error: any) {
      console.error("Error uploading attachment:", error);
      message.error(
        t("attachments.uploadFailed", {
          name: uploadFile?.name ?? "",
          message: error?.message || "",
        }),
      );
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  /** onChange 只同步 antd 的临时状态（uploading/error）；done 后由 fetchAttachments 用库内行重建列表 */
  const handleChange: UploadProps["onChange"] = ({ fileList: newFileList }) => {
    setFileList(newFileList);
  };

  /** 点击文件：新标签页打开（浏览器可直接预览 PDF，其余类型触发下载） */
  const handlePreview = (file: UploadFile) => {
    if (file.url) {
      window.open(file.url, "_blank");
    }
  };

  const handleRemove = (file: UploadFile): Promise<boolean> | boolean => {
    const row = rowMap.get(file.uid);
    if (!row) return true; // 本地上传中的临时/失败项，仅从列表移除
    return new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: t("common.confirmDelete"),
        content: t("attachments.deleteConfirm"),
        onOk: async () => {
          try {
            const { error } = await supabase
              .from(attachmentTable)
              .update({ is_deleted: "y" })
              .eq("id", row.id);
            if (error) throw error;
            // 存储对象尽力删除；失败不影响软删结果
            await supabase.storage
              .from(row.bucket || ATTACHMENT_BUCKET)
              .remove([row.storage_path]);
            message.success(t("common.deleteSuccess"));
            onChanged?.();
            resolve(true);
          } catch (error) {
            console.error("Error deleting attachment:", error);
            message.error(t("common.deleteFailed"));
            resolve(false);
          }
        },
        onCancel: () => resolve(false),
      });
    });
  };

  if (!bizId) {
    return <div style={{ color: "#999", padding: "12px 0" }}>{t("attachments.saveHint")}</div>;
  }

  const draggerProps: UploadProps = {
    name: "file",
    multiple: true,
    accept: ALLOWED_EXTS.map((e) => `.${e}`).join(","),
    fileList,
    beforeUpload,
    customRequest: handleUpload as any,
    onChange: handleChange,
    onPreview: handlePreview,
    onRemove: handleRemove,
  };

  return (
    <Spin spinning={loading}>
      <Upload.Dragger {...draggerProps}>
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">{t("attachments.uploadText")}</p>
        <p className="ant-upload-hint">{t("attachments.uploadHint", { size: MAX_FILE_SIZE_MB })}</p>
      </Upload.Dragger>
    </Spin>
  );
}

export default BizAttachments;
