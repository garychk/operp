import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Table, Tag } from "antd";
import { supabase } from "../utils/supabase";
import {
  DocFlowConnectionsGraph,
  type DocFlowConnectionsData,
  type DocFlowConnectionItem,
} from "./DocFlowConnectionsGraph";

interface DocFlowConnectionsPanelProps {
  documentType?: string;
  documentId?: number | string | null;
  /** 图区高度，tabs 里可以调小一些。 */
  graphHeight?: number;
  showTable?: boolean;
}

type Row = DocFlowConnectionItem & { direction: "upstream" | "downstream" };

/**
 * Self-contained connections view. Use it on its own inside a tab, or let
 * DocFlowConnectionsModal wrap it in a dialog.
 */
export function DocFlowConnectionsPanel({
  documentType,
  documentId,
  graphHeight = 340,
  showTable = true,
}: DocFlowConnectionsPanelProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<DocFlowConnectionsData | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!documentType || documentId == null) return;
    setLoading(true);
    try {
      const { data: result, error } = await supabase.rpc("doc_flow_connections", {
        p_document_type: documentType,
        p_document_id: Number(documentId),
      });
      if (error) throw error;
      setData((result as unknown as DocFlowConnectionsData) ?? null);
    } catch (error) {
      console.error("Failed to load document connections:", error);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [documentType, documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows: Row[] = [
    ...(data?.upstream ?? []).map((item) => ({ ...item, direction: "upstream" as const })),
    ...(data?.downstream ?? []).map((item) => ({ ...item, direction: "downstream" as const })),
  ];

  const columns = [
    {
      title: t("docFlow.connections.direction"),
      dataIndex: "direction",
      key: "direction",
      width: 100,
      render: (direction: Row["direction"]) => (
        <Tag color={direction === "upstream" ? "teal" : "orange"}>
          {direction === "upstream"
            ? t("docFlow.connections.upstream")
            : t("docFlow.connections.downstream")}
        </Tag>
      ),
    },
    {
      title: t("docFlow.connections.documentType"),
      dataIndex: "document_name",
      key: "document_name",
      width: 140,
    },
    {
      title: t("docFlow.connections.documentNo"),
      dataIndex: "document_no",
      key: "document_no",
      width: 180,
    },
    {
      title: t("docFlow.connections.qty"),
      dataIndex: "quantity",
      key: "quantity",
      width: 100,
      render: (qty: number) => Number(qty ?? 0).toLocaleString(),
    },
    {
      title: t("docFlow.connections.lines"),
      dataIndex: "lines",
      key: "lines",
      width: 80,
    },
  ];

  return (
    <>
      <DocFlowConnectionsGraph data={data} loading={loading} height={graphHeight} />
      {showTable && (
        <Table<Row>
          rowKey={(row) => `${row.direction}-${row.document_type}-${row.document_id}`}
          size="small"
          style={{ marginTop: 16 }}
          dataSource={rows}
          columns={columns}
          pagination={false}
        />
      )}
    </>
  );
}

export default DocFlowConnectionsPanel;
