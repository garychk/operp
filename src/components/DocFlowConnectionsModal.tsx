import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "antd";
import { supabase } from "../utils/supabase";
import { DocFlowConnectionsPanel } from "./DocFlowConnectionsPanel";

interface DocFlowConnectionsModalProps {
  open: boolean;
  documentType?: string;
  documentId?: number | string | null;
  onCancel: () => void;
}

export function DocFlowConnectionsModal({
  open,
  documentType,
  documentId,
  onCancel,
}: DocFlowConnectionsModalProps) {
  const { t } = useTranslation();
  const [documentNo, setDocumentNo] = useState<string | undefined>();

  useEffect(() => {
    if (!open || !documentType || documentId == null) return;
    let alive = true;
    void (async () => {
      try {
        const { data } = await supabase.rpc("doc_flow_document_no", {
          p_document_type: documentType,
          p_document_id: Number(documentId),
        });
        if (alive) setDocumentNo((data as string) ?? undefined);
      } catch {
        if (alive) setDocumentNo(undefined);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, documentType, documentId]);

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      width={980}
      footer={null}
      destroyOnHidden
      title={`${t("docFlow.connections.title")}${documentNo ? ` - ${documentNo}` : ""}`}
    >
      {open && (
        <DocFlowConnectionsPanel
          documentType={documentType}
          documentId={documentId}
        />
      )}
    </Modal>
  );
}

export default DocFlowConnectionsModal;
