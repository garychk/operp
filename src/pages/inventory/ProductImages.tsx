import { useEffect, useState } from "react";
import { Image, Modal, Spin, Upload, message } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import type { GetProp, UploadFile, UploadProps } from "antd";
import { useTranslation } from "react-i18next";
import { supabase } from "../../utils/supabase";
import type { Tables } from "../../utils/supabase";

type ProductImage = Tables["erp_product_images_s_539dcf81_b"]["Row"];

/** 物料图片统一存放的 Storage 桶（deploy_79 创建，公开读） */
export const IMAGE_BUCKET = "uploadfiles";
/** 单图大小上限：10MB（与桶配置一致） */
const MAX_IMAGE_SIZE_MB = 10;

const productImageTable = "erp_product_images_s_539dcf81_b";

/** 由桶内路径得到公开访问 URL */
export function imagePublicUrl(bucket: string, storagePath: string): string {
  const { data } = supabase.storage.from(bucket || IMAGE_BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

type FileType = Parameters<GetProp<UploadProps, "beforeUpload">>[0];

const getBase64 = (file: FileType): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
  });

interface ProductImagesProps {
  /** 已保存的产品 id；为空（新增产品未保存）时不可维护图片。 */
  productId?: number | null;
  /** 图片增删后的回调（父组件用来刷新列表首图缩略）。 */
  onChanged?: () => void;
}

/** 数据库行 uid 前缀：区分「已入库的图」与「本地上传中的临时项」 */
const DB_UID_PREFIX = "db-";

/**
 * 物料图片维护组件（picture-card 卡片式，参照 antd 官方 Upload 示例）：
 * 卡片网格 + 上传占位卡 + 点击大图预览 + 卡片删除。
 * 上传走 Supabase Storage uploadfiles 桶，元数据写入 erp_product_images。
 */
export function ProductImages({ productId, onChanged }: ProductImagesProps) {
  const { t } = useTranslation();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [rows, setRows] = useState<ProductImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewImage, setPreviewImage] = useState("");

  /** uid -> 数据库行；仅已入库的图可删除 */
  const rowMap = new Map<string, ProductImage>(
    rows.map((r) => [`${DB_UID_PREFIX}${r.id}`, r]),
  );

  const fetchImages = async (id: number) => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(productImageTable)
        .select("*")
        .eq("product_id", id)
        .eq("is_deleted", "n")
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      const dbRows = data || [];
      setRows(dbRows);
      setFileList(
        dbRows.map((row) => ({
          uid: `${DB_UID_PREFIX}${row.id}`,
          name: row.file_name || row.storage_path.split("/").pop() || "image",
          status: "done" as const,
          url: imagePublicUrl(row.bucket, row.storage_path),
        })),
      );
    } catch (error) {
      console.error("Error fetching product images:", error);
      message.error(t("products.imageLoadFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (productId) {
      fetchImages(productId);
    } else {
      setRows([]);
      setFileList([]);
    }
  }, [productId]);

  const beforeUpload: UploadProps["beforeUpload"] = (file) => {
    if (!file.type.startsWith("image/")) {
      message.error(t("products.imageInvalidType"));
      return Upload.LIST_IGNORE;
    }
    if (file.size > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
      message.error(t("products.imageTooLarge", { size: MAX_IMAGE_SIZE_MB }));
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
    if (!productId) {
      message.warning(t("products.imageSaveHint"));
      onError?.(new Error(t("products.imageSaveHint")));
      return;
    }
    const uploadFile = file as FileType & { name: string; size: number; type: string };

    try {
      const fileExt = uploadFile.name.split(".").pop() || "png";
      const rand = Math.random().toString(36).slice(2, 8);
      const storagePath = `${productId}/${Date.now()}-${rand}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from(IMAGE_BUCKET)
        .upload(storagePath, uploadFile, {
          cacheControl: "3600",
          contentType: uploadFile.type,
        });
      if (uploadError) throw uploadError;

      // 新上传的图排在已有图后面（首图 = sort_order 最小者）
      const lastSort = rows.length > 0 ? rows[rows.length - 1].sort_order : -1;
      const { error: insertError } = await supabase.from(productImageTable).insert([
        {
          product_id: productId,
          bucket: IMAGE_BUCKET,
          storage_path: storagePath,
          file_name: uploadFile.name,
          file_size: uploadFile.size,
          mime_type: uploadFile.type,
          sort_order: lastSort + 1,
        },
      ]);
      if (insertError) {
        // 行写入失败则回滚存储对象，避免孤儿文件
        await supabase.storage.from(IMAGE_BUCKET).remove([storagePath]);
        throw insertError;
      }

      message.success(t("products.imageUploadSuccess"));
      onSuccess?.(storagePath);
      await fetchImages(productId);
      onChanged?.();
    } catch (error: any) {
      console.error("Error uploading product image:", error);
      message.error(error?.message || t("products.imageUploadFailed"));
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  /** onChange 只同步 antd 的临时状态（uploading/error）；done 后由 fetchImages 用库内行重建列表 */
  const handleChange: UploadProps["onChange"] = ({ fileList: newFileList }) => {
    setFileList(newFileList);
  };

  const handlePreview = async (file: UploadFile) => {
    if (!file.url && !file.preview) {
      file.preview = await getBase64(file.originFileObj as FileType);
    }
    setPreviewImage(file.url || (file.preview as string));
    setPreviewOpen(true);
  };

  const handleRemove = (file: UploadFile): Promise<boolean> | boolean => {
    const row = rowMap.get(file.uid);
    if (!row) return true; // 本地上传中的临时/失败项，仅从列表移除
    return new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: t("common.confirmDelete"),
        content: t("products.imageDeleteConfirm"),
        onOk: async () => {
          try {
            const { error } = await supabase
              .from(productImageTable)
              .update({ is_deleted: "y" })
              .eq("id", row.id);
            if (error) throw error;
            // 存储对象尽力删除；失败不影响软删结果
            await supabase.storage
              .from(row.bucket || IMAGE_BUCKET)
              .remove([row.storage_path]);
            message.success(t("common.deleteSuccess"));
            onChanged?.();
            resolve(true);
          } catch (error) {
            console.error("Error deleting product image:", error);
            message.error(t("common.deleteFailed"));
            resolve(false);
          }
        },
        onCancel: () => resolve(false),
      });
    });
  };

  const uploadButton = (
    <button style={{ border: 0, background: "none" }} type="button">
      <PlusOutlined />
      <div style={{ marginTop: 8 }}>{t("products.imageUpload")}</div>
    </button>
  );

  if (!productId) {
    return (
      <div style={{ color: "#999", padding: "12px 0" }}>
        {t("products.imageSaveHint")}
      </div>
    );
  }

  return (
    <Spin spinning={loading}>
      <Upload
        accept="image/*"
        multiple
        listType="picture-card"
        fileList={fileList}
        beforeUpload={beforeUpload}
        customRequest={handleUpload as any}
        onPreview={handlePreview}
        onChange={handleChange}
        onRemove={handleRemove}
      >
        {uploadButton}
      </Upload>
      {previewImage && (
        <Image
          styles={{ root: { display: "none" } }}
          preview={{
            open: previewOpen,
            onOpenChange: (open) => setPreviewOpen(open),
            afterOpenChange: (open) => !open && setPreviewImage(""),
          }}
          src={previewImage}
        />
      )}
    </Spin>
  );
}

export default ProductImages;
