import { DeleteOutlined, PlusOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Button, Select, Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import { sameNameConditions } from "./joinGraph";
import type { BaqColumn, BaqJoinCondition } from "./types";

/**
 * 一条关联的条件编辑器：一行一对「左字段 = 右字段」，多行之间是 AND。
 *
 * 关键点：两端下拉列出的是**该表的全部列**，不限于外键——现实里经常要用业务
 * 编码关联（物料 code = 单据上的物料编码），这种关系在 pg_constraint 里根本
 * 不存在。「按同名字段匹配」按钮用来一键补上 code = code 这类条件。
 *
 * 图形面板与经典页签共用本组件，保证两边行为一致。
 */
interface JoinConditionEditorProps {
  conditions: BaqJoinCondition[];
  leftColumns: BaqColumn[];
  rightColumns: BaqColumn[];
  leftAlias: string;
  rightAlias: string;
  /** 左/右表的外键列名，仅用于在下拉里标注默认的主外键字段 */
  leftFk?: Set<string>;
  rightFk?: Set<string>;
  onChange: (conditions: BaqJoinCondition[]) => void;
  compact?: boolean;
}

export function JoinConditionEditor({
  conditions,
  leftColumns,
  rightColumns,
  leftAlias,
  rightAlias,
  leftFk,
  rightFk,
  onChange,
  compact = false,
}: JoinConditionEditorProps) {
  const { t } = useTranslation();

  const optionsOf = (columns: BaqColumn[], fk?: Set<string>) =>
    columns.map((column) => ({
      value: column.name,
      label: fk?.has(column.name)
        ? `${column.name} · ${t("baqDesigner.graphFkField")}`
        : column.name,
    }));

  const leftOptions = optionsOf(leftColumns, leftFk);
  const rightOptions = optionsOf(rightColumns, rightFk);

  const patch = (index: number, next: Partial<BaqJoinCondition>) =>
    onChange(conditions.map((item, i) => (i === index ? { ...item, ...next } : item)));

  const addCondition = () => onChange([...conditions, { leftField: "", rightField: "" }]);

  const removeCondition = (index: number) =>
    onChange(conditions.filter((_, i) => i !== index));

  /** 同名字段一键匹配（code = code 这类非主外键关联） */
  const candidates = sameNameConditions(leftColumns, rightColumns);
  const applySameName = () => {
    const existing = new Set(
      conditions.map((item) => `${item.leftField}|${item.rightField}`),
    );
    const added = candidates.filter(
      (item) => !existing.has(`${item.leftField}|${item.rightField}`),
    );
    if (added.length === 0) return;
    // 只剩一条空条件时直接替换掉，避免留下空行
    const kept = conditions.filter((item) => item.leftField || item.rightField);
    onChange([...kept, ...added]);
  };

  return (
    <div className={`baq-join-cond${compact ? " is-compact" : ""}`}>
      {conditions.map((condition, index) => (
        <div className="baq-join-cond-row" key={index}>
          {index > 0 && (
            <span className="baq-join-cond-and">
              {t("baqDesigner.graphConditionAnd")}
            </span>
          )}
          <Select
            size="small"
            className="baq-join-cond-field"
            showSearch
            optionFilterProp="label"
            value={condition.leftField || undefined}
            placeholder={leftAlias}
            options={leftOptions}
            onChange={(leftField) => patch(index, { leftField })}
          />
          <span className="baq-join-cond-eq">=</span>
          <Select
            size="small"
            className="baq-join-cond-field"
            showSearch
            optionFilterProp="label"
            value={condition.rightField || undefined}
            placeholder={rightAlias}
            options={rightOptions}
            onChange={(rightField) => patch(index, { rightField })}
          />
          <Tooltip title={t("baqDesigner.graphRemoveCondition")}>
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              disabled={conditions.length <= 1}
              onClick={() => removeCondition(index)}
            />
          </Tooltip>
        </div>
      ))}
      <div className="baq-join-cond-actions">
        <Button size="small" type="link" icon={<PlusOutlined />} onClick={addCondition}>
          {t("baqDesigner.graphAddCondition")}
        </Button>
        {candidates.length > 0 && (
          <Tooltip
            title={t("baqDesigner.graphSameNameMatchHint", {
              fields: candidates.map((item) => item.leftField).join("、"),
            })}
          >
            <Button
              size="small"
              type="link"
              icon={<ThunderboltOutlined />}
              onClick={applySameName}
            >
              {t("baqDesigner.graphSameNameMatch", { count: candidates.length })}
            </Button>
          </Tooltip>
        )}
        {!compact && (
          <span className="baq-join-cond-hint">
            {t("baqDesigner.graphAnyFieldHint")}
          </span>
        )}
      </div>
    </div>
  );
}
