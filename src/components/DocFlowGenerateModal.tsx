import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  message,
} from "antd";
import { supabase } from "../utils/supabase";
import { ProductUnit } from "./ProductUnit";

type GenerateResult = {
  ok: boolean;
  target_document_type: string;
  target_document_id: number;
  target_document_no: string;
  lines: number;
};

type RuleRow = {
  id: number;
  rule_code: string;
  rule_name: string;
  source_document_type: string;
  target_document_type: string;
  source_quantity_field: string;
  source_detail_key_field: string;
  source_detail_parent_field: string;
};

interface LineRow {
  source_detail_id: number;
  line_no: number;
  product_id: number | null;
  source_qty: number;
  transferred: number;
  remaining: number;
  this_qty: number;
}

interface DocFlowGenerateModalProps {
  open: boolean;
  sourceDocumentType: string;
  sourceDocumentId: number | null;
  sourceDocumentNo?: string;
  ruleCode?: string;
  productField?: string;
  usageType?: string;
  onCancel: () => void;
  onSuccess?: (result: GenerateResult) => void;
}

const round4 = (value: number) => Math.round(value * 10000) / 10000;

export function DocFlowGenerateModal({
  open,
  sourceDocumentType,
  sourceDocumentId,
  sourceDocumentNo,
  ruleCode: fixedRuleCode,
  productField = "product_id",
  usageType = "purchase",
  onCancel,
  onSuccess,
}: DocFlowGenerateModalProps) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [ruleCode, setRuleCode] = useState<string | undefined>(fixedRuleCode);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [productNames, setProductNames] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const activeRule = useMemo(
    () => rules.find((r) => r.rule_code === ruleCode),
    [rules, ruleCode],
  );

  useEffect(() => {
    if (!open) return;
    setRuleCode(fixedRuleCode);
    setLines([]);
  }, [open, fixedRuleCode]);

  useEffect(() => {
    if (!open) return;
    const loadRules = async () => {
      const { data, error } = await supabase
        .from("doc_flow_rules")
        .select("*")
        .eq("is_deleted", "n")
        .eq("is_active", true)
        .eq("source_document_type", sourceDocumentType)
        .order("id");
      if (error) {
        message.error(error.message);
        return;
      }
      const rows = (data || []) as unknown as RuleRow[];
      setRules(rows);
      if (!fixedRuleCode) {
        setRuleCode((current) => current ?? rows[0]?.rule_code);
      }
    };
    loadRules();
  }, [open, sourceDocumentType, fixedRuleCode]);

  const fetchProductNames = useCallback(async (ids: number[]) => {
    const unique = Array.from(new Set(ids.filter((id) => !!id)));
    if (unique.length === 0) {
      setProductNames({});
      return;
    }
    const { data } = await supabase
      .from("erp_products_s_539dcf81_b")
      .select("id, code, name")
      .in("id", unique);
    const map: Record<number, string> = {};
    (data || []).forEach((p: { id: number; code?: string; name?: string }) => {
      map[p.id] = p.code ? `${p.code} - ${p.name}` : p.name || "";
    });
    setProductNames(map);
  }, []);

  const loadLines = useCallback(
    async (rule: RuleRow) => {
      if (!sourceDocumentId) return;
      setLoading(true);
      try {
        const { data: detailTable, error: tableError } = await supabase.rpc(
          "doc_flow_detail_table",
          { p_document_type: rule.source_document_type },
        );
        if (tableError) throw tableError;
        if (!detailTable) {
          throw new Error(t("docFlow.generate.missingDetailTable"));
        }

        const { data, error } = await (supabase.from(detailTable) as any)
          .select("*")
          .eq(rule.source_detail_parent_field, sourceDocumentId)
          .eq("is_deleted", "n")
          .order("line_no");
        if (error) throw error;

        const rows = (data || []) as Record<string, any>[];
        const detailed: LineRow[] = await Promise.all(
          rows.map(async (row) => {
            const detailId = Number(row[rule.source_detail_key_field]);
            const { data: transferred, error: qtyError } = await supabase.rpc(
              "doc_flow_transferred_qty",
              { p_source_detail_id: detailId },
            );
            if (qtyError) throw qtyError;
            const sourceQty = Number(row[rule.source_quantity_field] || 0);
            const done = Number(transferred || 0);
            const remaining = Math.max(0, round4(sourceQty - done));
            return {
              source_detail_id: detailId,
              line_no: Number(row.line_no || 0),
              product_id: row[productField] ?? null,
              source_qty: sourceQty,
              transferred: done,
              remaining,
              this_qty: remaining,
            };
          }),
        );
        setLines(detailed);
        await fetchProductNames(detailed.map((l) => l.product_id as number));
      } catch (error: any) {
        console.error("Failed to load convertible lines:", error);
        message.error(error?.message || t("common.fetchFailed"));
      } finally {
        setLoading(false);
      }
    },
    [sourceDocumentId, productField, fetchProductNames, t],
  );

  useEffect(() => {
    if (!open || !activeRule) return;
    loadLines(activeRule);
  }, [open, activeRule, loadLines]);

  const updateQuantity = (detailId: number, value: number | null) => {
    setLines((prev) =>
      prev.map((line) =>
        line.source_detail_id === detailId
          ? { ...line, this_qty: Math.min(line.remaining, Number(value || 0)) }
          : line,
      ),
    );
  };

  const handleGenerate = async () => {
    if (!ruleCode || !sourceDocumentId) return;
    const requests = lines
      .filter((line) => line.this_qty > 0)
      .map((line) => ({
        source_detail_id: line.source_detail_id,
        quantity: line.this_qty,
      }));

    if (requests.length === 0) {
      message.warning(t("docFlow.generate.noQuantity"));
      return;
    }

    setSubmitting(true);
    try {
      const { data, error } = await supabase.rpc("doc_flow_generate", {
        p_rule_code: ruleCode,
        p_source_document_id: sourceDocumentId,
        p_line_mode: "explicit",
        p_line_requests: requests,
      });
      if (error) throw error;
      const result = data as unknown as GenerateResult;
      message.success(
        `${t("docFlow.generate.success")}：${result.target_document_no}`,
      );
      onSuccess?.(result);
      onCancel();
    } catch (error: any) {
      console.error("Failed to generate document:", error);
      message.error(error?.message || t("common.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const columns = [
    {
      title: t("docFlow.generate.lineNo"),
      dataIndex: "line_no",
      key: "line_no",
      width: 70,
    },
    {
      title: t("docFlow.generate.product"),
      dataIndex: "product_id",
      key: "product_id",
      render: (productId: number | null) =>
        productId ? productNames[productId] || productId : "-",
    },
    {
      title: t("docFlow.generate.unit"),
      dataIndex: "product_id",
      key: "unit",
      width: 90,
      render: (productId: number | null) =>
        productId ? <ProductUnit productId={productId} usageType={usageType} /> : "-",
    },
    {
      title: t("docFlow.generate.sourceQty"),
      dataIndex: "source_qty",
      key: "source_qty",
      width: 100,
      render: (qty: number) => qty?.toLocaleString() || "0",
    },
    {
      title: t("docFlow.generate.transferred"),
      dataIndex: "transferred",
      key: "transferred",
      width: 100,
      render: (qty: number) => qty?.toLocaleString() || "0",
    },
    {
      title: t("docFlow.generate.remaining"),
      dataIndex: "remaining",
      key: "remaining",
      width: 100,
      render: (qty: number) => (
        <Tag color={qty > 0 ? "blue" : "default"}>
          {qty?.toLocaleString() || "0"}
        </Tag>
      ),
    },
    {
      title: t("docFlow.generate.thisQty"),
      dataIndex: "this_qty",
      key: "this_qty",
      width: 140,
      render: (_: number, record: LineRow) => (
        <InputNumber
          min={0}
          max={record.remaining}
          step={1}
          value={record.this_qty}
          disabled={record.remaining <= 0}
          onChange={(value) => updateQuantity(record.source_detail_id, value)}
          style={{ width: "100%" }}
        />
      ),
    },
  ];

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      width={960}
      title={`${t("docFlow.generate.title")}${sourceDocumentNo ? ` - ${sourceDocumentNo}` : ""}`}
      footer={
        <Space>
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button
            type="primary"
            loading={submitting}
            onClick={handleGenerate}
            disabled={!activeRule || lines.length === 0}
          >
            {t("docFlow.generate.submit")}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {!fixedRuleCode && (
          <Space>
            <span>{t("docFlow.generate.rule")}</span>
            <Select
              value={ruleCode}
              onChange={setRuleCode}
              style={{ width: 320 }}
              options={rules.map((r) => ({
                value: r.rule_code,
                label: `${r.rule_name} (${r.rule_code})`,
              }))}
            />
          </Space>
        )}
        <Alert
          type="info"
          showIcon
          message={t("docFlow.generate.hint")}
        />
        <Table
          columns={columns}
          dataSource={lines}
          rowKey="source_detail_id"
          loading={loading}
          pagination={false}
          size="small"
          scroll={{ y: 360 }}
        />
      </Space>
    </Modal>
  );
}
