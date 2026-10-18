import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, InputNumber, Space, Table, Tag, message } from "antd";
import type { InputNumberProps } from "antd";
import { SaveOutlined } from "@ant-design/icons";
import { supabase } from "../utils/supabase";
import SimpleModal from "./SimpleModal";

/**
 * 3D 车间布局维护（独立组件，可在任意页面调用）
 *
 * 维护 factory_3d_device_layout_s_539dcf81_b（工作中心 → 3D 场景坐标）。
 * 用法：
 *   const [open, setOpen] = useState(false)
 *   <Factory3dLayoutModal open={open} onClose={() => setOpen(false)} />
 *
 * 可选 props.workCenters 限定范围（不传自动拉全部在用工作中心），
 * 可选 props.onSaved 在保存成功后回调（宿主可借此刷新 3D 场景数据）。
 */

const WC_TABLE = "erp_work_centers_s_539dcf81_b";
const LAYOUT_TABLE = "factory_3d_device_layout_s_539dcf81_b";

interface WcOption {
  id: number;
  code: string;
  name: string;
}

/** 布局表行（deploy_135 尚未进 database.generated 类型，此处本地对齐） */
interface LayoutRow {
  id: number;
  work_center_id: number;
  scene_x: number;
  scene_z: number;
  label: string | null;
}

/** 表格里的一行 = 工作中心 + （可能存在的）布局配置 */
interface EditRow extends WcOption {
  layoutId: number | null;
  sceneX: number | null;
  sceneZ: number | null;
  label: string;
}

export interface Factory3dLayoutModalProps {
  open: boolean;
  onClose: () => void;
  /** 不传则自动加载全部在用工作中心 */
  workCenters?: WcOption[];
  /** 保存成功后回调 */
  onSaved?: () => void;
}

export function Factory3dLayoutModal({
  open,
  onClose,
  workCenters,
  onSaved,
}: Factory3dLayoutModalProps) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<EditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      // 工作中心列表：外部传入则不重复拉取
      let wcs: WcOption[] = workCenters ?? [];
      if (!workCenters) {
        const { data, error } = await supabase
          .from(WC_TABLE)
          .select("id, code, name")
          .eq("is_deleted", "n")
          .order("code");
        if (error) throw error;
        wcs = data || [];
      }
      // 已有布局配置
      const { data: layouts, error: layoutErr } = await supabase
        .from(LAYOUT_TABLE)
        .select("id, work_center_id, scene_x, scene_z, label")
        .eq("is_deleted", "n");
      if (layoutErr) throw layoutErr;

      const byWc = new Map<number, LayoutRow>(
        (layouts || []).map((l) => [l.work_center_id, l]),
      );
      setRows(
        wcs.map((wc) => {
          const l = byWc.get(wc.id);
          return {
            ...wc,
            layoutId: l?.id ?? null,
            sceneX: l ? Number(l.scene_x) : null,
            sceneZ: l ? Number(l.scene_z) : null,
            label: l?.label ?? "",
          };
        }),
      );
    } catch (error) {
      console.error("Error loading factory 3d layout:", error);
      message.error(t("factory3d.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [workCenters, t]);

  useEffect(() => {
    if (open) loadData();
  }, [open, loadData]);

  const patchRow = (id: number, patch: Partial<EditRow>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const numChanged = useMemo(
    () => rows.filter((r) => r.sceneX != null || r.sceneZ != null).length,
    [rows],
  );

  /** 清空坐标 = 软删布局行（3D 场景回退自动排布） */
  const isCleared = (r: EditRow) =>
    r.sceneX == null && r.sceneZ == null && !r.label.trim();

  const handleSave = async () => {
    try {
      setSaving(true);
      for (const r of rows) {
        const label = r.label.trim() || null;
        if (r.layoutId != null) {
          if (isCleared(r)) {
            // 原来配置过、现在清空 → 软删除，回退自动排布
            const { error } = await supabase
              .from(LAYOUT_TABLE)
              .update({ is_deleted: "y", updated_at: new Date().toISOString() })
              .eq("id", r.layoutId);
            if (error) throw error;
          } else {
            const { error } = await supabase
              .from(LAYOUT_TABLE)
              .update({
                scene_x: r.sceneX ?? 0,
                scene_z: r.sceneZ ?? 0,
                label,
                updated_at: new Date().toISOString(),
              })
              .eq("id", r.layoutId);
            if (error) throw error;
          }
        } else if (!isCleared(r)) {
          // 新配置（tenant_id 由库端 default current_tenant_id() 填充）
          const { error } = await supabase.from(LAYOUT_TABLE).insert([
            {
              work_center_id: r.id,
              scene_x: r.sceneX ?? 0,
              scene_z: r.sceneZ ?? 0,
              label,
            },
          ]);
          if (error) throw error;
        }
      }
      message.success(t("factory3d.saveSuccess"));
      onSaved?.();
      onClose();
    } catch (error) {
      console.error("Error saving factory 3d layout:", error);
      message.error(t("factory3d.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const coordProps = (min: number, max: number): InputNumberProps<number> => ({
    style: { width: "100%" },
    step: 0.5,
    min,
    max,
    precision: 1,
  });

  const columns = [
    { title: t("common.code"), dataIndex: "code", width: 120 },
    { title: t("common.name"), dataIndex: "name", width: 140, ellipsis: true },
    {
      title: t("factory3d.status"),
      width: 110,
      render: (_: unknown, r: EditRow) =>
        r.layoutId != null && !isCleared(r) ? (
          <Tag color="success">{t("factory3d.configured")}</Tag>
        ) : (
          <Tag>{t("factory3d.notConfigured")}</Tag>
        ),
    },
    {
      title: t("factory3d.sceneX"),
      dataIndex: "sceneX",
      width: 150,
      render: (_: unknown, r: EditRow) => (
        <InputNumber
          value={r.sceneX ?? undefined}
          onChange={(v) => patchRow(r.id, { sceneX: v ?? null })}
          placeholder="0"
          {...coordProps(-50, 50)}
        />
      ),
    },
    {
      title: t("factory3d.sceneZ"),
      dataIndex: "sceneZ",
      width: 150,
      render: (_: unknown, r: EditRow) => (
        <InputNumber
          value={r.sceneZ ?? undefined}
          onChange={(v) => patchRow(r.id, { sceneZ: v ?? null })}
          placeholder="0"
          {...coordProps(-50, 50)}
        />
      ),
    },
    {
      title: t("factory3d.label"),
      dataIndex: "label",
      render: (_: unknown, r: EditRow) => (
        <Input
          value={r.label}
          onChange={(e) => patchRow(r.id, { label: e.target.value })}
          placeholder={t("factory3d.labelPlaceholder")}
          maxLength={100}
        />
      ),
    },
  ];

  return (
    <SimpleModal
      title={t("factory3d.layoutTitle")}
      open={open}
      onCancel={onClose}
      width={860}
      footer={
        <Space>
          <span style={{ marginRight: "auto", fontSize: 12, color: "#999" }}>
            {t("factory3d.hint", { n: numChanged })}
          </span>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            onClick={handleSave}
          >
            {t("factory3d.save")}
          </Button>
        </Space>
      }
    >
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ y: 420 }}
      />
    </SimpleModal>
  );
}
