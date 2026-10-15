import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dropdown, Space } from "antd";
import { ArrowDownOutlined } from "@ant-design/icons";
import { DocFlowGenerateModal } from "./DocFlowGenerateModal";
import {
  isStatusAllowed,
  loadDocFlowRules,
  type DocFlowRuleRow,
} from "../utils/docFlowRules";

interface DocFlowGenerateButtonProps {
  sourceDocumentType: string;
  sourceDocumentId: number;
  sourceDocumentNo?: string;
  sourceStatus?: string | null;
  /** 仅有一条规则时的按钮文案，缺省用规则名。 */
  label?: string;
  productField?: string;
  usageType?: string;
  disabled?: boolean;
  onSuccess?: () => void;
}

/**
 * Drop-in entry point for the conversion engine. Rules, their enabled statuses
 * and their labels all come from the database, so adding a downstream document
 * needs no front-end change: configure a rule and the button appears.
 */
export function DocFlowGenerateButton({
  sourceDocumentType,
  sourceDocumentId,
  sourceDocumentNo,
  sourceStatus,
  label,
  productField,
  usageType,
  disabled,
  onSuccess,
}: DocFlowGenerateButtonProps) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<DocFlowRuleRow[]>([]);
  const [open, setOpen] = useState(false);
  const [activeRuleCode, setActiveRuleCode] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    loadDocFlowRules(sourceDocumentType)
      .then((rows) => {
        if (alive) setRules(rows);
      })
      .catch((error) => console.error("Failed to load flow rules:", error));
    return () => {
      alive = false;
    };
  }, [sourceDocumentType]);

  const enabled = (rule: DocFlowRuleRow) =>
    !disabled && isStatusAllowed(rule, sourceStatus);

  const openWith = (ruleCode: string) => {
    setActiveRuleCode(ruleCode);
    setOpen(true);
  };

  const modal = (
    <DocFlowGenerateModal
      open={open}
      sourceDocumentType={sourceDocumentType}
      sourceDocumentId={sourceDocumentId}
      sourceDocumentNo={sourceDocumentNo}
      ruleCode={activeRuleCode}
      productField={productField}
      usageType={usageType}
      onCancel={() => setOpen(false)}
      onSuccess={() => {
        setOpen(false);
        onSuccess?.();
      }}
    />
  );

  if (rules.length === 0) return null;

  if (rules.length === 1) {
    const rule = rules[0];
    return (
      <>
        <Button
          type="default"
          icon={<ArrowDownOutlined />}
          disabled={!enabled(rule)}
          onClick={() => openWith(rule.rule_code)}
        >
          {label ?? rule.rule_name}
        </Button>
        {modal}
      </>
    );
  }

  return (
    <>
      <Dropdown
        trigger={["click"]}
        arrow={false}
        menu={{
          items: rules.map((rule) => ({
            key: rule.rule_code,
            label: rule.rule_name,
            disabled: !enabled(rule),
          })),
          onClick: ({ key }) => openWith(key),
        }}
      >
        <Button
          type="default"
          disabled={rules.every((rule) => !enabled(rule))}
          icon={<ArrowDownOutlined />}
        >
          <Space size={4}>
            {label ?? t("docFlow.button.generate")}
          </Space>
        </Button>
      </Dropdown>
      {modal}
    </>
  );
}
