# 单据类型与流程数据库实体说明

本文档记录当前系统中业务单据类型和工作流相关的数据库实体。字段说明以以下迁移文件为准：

- `supabase/tables/deploy_14_workflow_engine.sql`
- `supabase/tables/deploy_15_document_types.sql`

## 1. 实体关系

```text
sys_document_types
        |
        | workflow_process_id
        v
wf_process_definitions
        |
        | process_id
        v
wf_process_nodes
        |
        +--------------------+
        |                    |
        v                    v
wf_process_instances    wf_process_actions
```

业务单据通过 `document_type` 与流程匹配：

```text
业务页面 workflowDocumentType
        -> sys_document_types.document_type
        -> workflow_process_id
        -> 启用的流程定义
        -> 流程节点
```

当前流程连线没有独立数据表，保存在流程定义的 `config_json.workflowEdges` 中。

## 2. sys_document_types

### 2.1 用途

`sys_document_types` 是业务单据类型主表，类似 ERPNext/Frappe 的 DocType 主记录。它描述单据的编码、名称、所属模块、业务表、编号规则、默认流程和页面行为。

业务页面继续通过稳定编码绑定流程：

```tsx
<SupaModal workflowDocumentType="purchase_order" />
```

### 2.2 字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `id` | `SERIAL` | 是 | 自增 | 主键 |
| `document_type` | `VARCHAR(100)` | 是 | 无 | 单据类型稳定编码，例如 `purchase_order`，唯一 |
| `document_name` | `VARCHAR(150)` | 是 | 无 | 单据显示名称，例如“采购订单” |
| `module_code` | `VARCHAR(100)` | 否 | `NULL` | 所属业务模块，例如 `inventory`、`finance` |
| `route_path` | `VARCHAR(255)` | 否 | `NULL` | 对应页面路由，仅作页面元数据，不参与流程匹配 |
| `table_name` | `VARCHAR(128)` | 否 | `NULL` | 对应业务数据表名称 |
| `primary_key_field` | `VARCHAR(128)` | 是 | `id` | 业务表主键字段 |
| `workflow_process_id` | `INTEGER` | 否 | `NULL` | 默认关联的流程定义 ID，外键指向 `wf_process_definitions.id` |
| `naming_rule` | `VARCHAR(255)` | 否 | `NULL` | 单据编号规则，例如 `PO{YYYY}{####}` |
| `is_submittable` | `BOOLEAN` | 是 | `TRUE` | 是否支持提交审批 |
| `is_single` | `BOOLEAN` | 是 | `FALSE` | 是否为单例单据，只允许一个实例 |
| `is_child` | `BOOLEAN` | 是 | `FALSE` | 是否为子表单据，例如采购订单明细 |
| `is_tree` | `BOOLEAN` | 是 | `FALSE` | 是否使用树形父子结构 |
| `quick_entry` | `BOOLEAN` | 是 | `FALSE` | 是否支持快速录入 |
| `track_changes` | `BOOLEAN` | 是 | `TRUE` | 是否记录字段变更 |
| `track_seen` | `BOOLEAN` | 是 | `FALSE` | 是否记录用户查看记录 |
| `track_views` | `BOOLEAN` | 是 | `FALSE` | 是否记录访问次数或访问日志 |
| `is_virtual` | `BOOLEAN` | 是 | `FALSE` | 是否为虚拟单据，不直接对应实体数据表 |
| `is_custom` | `BOOLEAN` | 是 | `FALSE` | 是否为用户自定义单据类型 |
| `form_config` | `JSONB` | 是 | `{}` | 表单布局和行为配置 |
| `list_config` | `JSONB` | 是 | `{}` | 列表页列、筛选、排序配置 |
| `permission_config` | `JSONB` | 是 | `{}` | 单据级权限配置 |
| `status` | `CHAR(1)` | 是 | `1` | 状态，通常 `1` 启用 |
| `sort_order` | `INTEGER` | 是 | `0` | 单据类型显示顺序 |
| `is_deleted` | `CHAR(1)` | 是 | `n` | 软删除标记，`n` 未删除，`y` 已删除 |
| `created_at` | `TIMESTAMPTZ` | 是 | 当前时间 | 创建时间 |
| `updated_at` | `TIMESTAMPTZ` | 是 | 当前时间 | 更新时间 |

### 2.3 关键约束和索引

- `document_type` 唯一。
- `workflow_process_id` 关联 `wf_process_definitions.id`，流程删除时置空。
- `form_config` 和 `list_config` 建立 GIN 索引，便于 JSON 查询。
- `status = '1' AND is_deleted = 'n'` 表示可用单据类型。

## 3. wf_process_definitions

### 3.1 用途

流程定义表保存一个业务流程的主信息和版本。一个单据类型可以对应多个流程版本，但运行时应选择启用且版本最新的流程。

### 3.2 字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `id` | `SERIAL` | 是 | 自增 | 流程定义主键 |
| `corp_id` | `VARCHAR(128)` | 否 | `NULL` | 企业或租户标识 |
| `emp_id` | `VARCHAR(128)` | 否 | `NULL` | 创建或维护人员标识 |
| `is_deleted` | `CHAR(1)` | 否 | `n` | 软删除标记 |
| `created_at` | `TIMESTAMPTZ` | 否 | 当前时间 | 创建时间 |
| `updated_at` | `TIMESTAMPTZ` | 否 | 当前时间 | 更新时间 |
| `process_code` | `VARCHAR(100)` | 是 | 无 | 流程编码，唯一 |
| `process_name` | `VARCHAR(200)` | 是 | 无 | 流程名称 |
| `document_type` | `VARCHAR(100)` | 是 | 无 | 流程适用的单据类型编码 |
| `description` | `TEXT` | 否 | `NULL` | 流程说明 |
| `is_active` | `BOOLEAN` | 否 | `TRUE` | 是否启用 |
| `version` | `INTEGER` | 否 | `1` | 流程版本号 |
| `config_json` | `JSONB` | 否 | `{}` | 流程级配置，包括当前连线 `workflowEdges` |

### 3.3 连线配置

当前连线存储在：

```json
{
  "workflowEdges": [
    {
      "id": "amount-condition-true",
      "source": "amount_condition",
      "target": "finance_manager",
      "sourcePort": "amount_condition-right",
      "targetPort": "finance_manager-left",
      "kind": "true",
      "label": "是",
      "lineStyle": "dashed",
      "color": "#1677ff"
    }
  ]
}
```

| 属性 | 说明 |
|---|---|
| `id` | 连线唯一标识 |
| `source` | 起始节点编码 |
| `target` | 目标节点编码 |
| `sourcePort` | 起始端口 |
| `targetPort` | 目标端口 |
| `kind` | `default`、`true` 或 `false` |
| `label` | 连线显示标签 |
| `lineStyle` | `solid` 或 `dashed` |
| `color` | 连线颜色 |

## 4. wf_process_nodes

### 4.1 用途

流程节点表保存流程中的开始节点、审批节点、条件节点和结束节点。

### 4.2 字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `id` | `SERIAL` | 是 | 自增 | 节点主键 |
| `corp_id` | `VARCHAR(128)` | 否 | `NULL` | 企业或租户标识 |
| `emp_id` | `VARCHAR(128)` | 否 | `NULL` | 维护人员标识 |
| `is_deleted` | `CHAR(1)` | 否 | `n` | 软删除标记 |
| `created_at` | `TIMESTAMPTZ` | 否 | 当前时间 | 创建时间 |
| `updated_at` | `TIMESTAMPTZ` | 否 | 当前时间 | 更新时间 |
| `process_id` | `INTEGER` | 是 | 无 | 所属流程定义，外键指向 `wf_process_definitions.id` |
| `node_key` | `VARCHAR(100)` | 是 | 无 | 节点稳定编码，在同一流程内唯一 |
| `node_name` | `VARCHAR(200)` | 是 | 无 | 节点名称 |
| `node_type` | `VARCHAR(30)` | 是 | `approval` | 节点类型：`start`、`condition`、`approval`、`end` |
| `sequence_no` | `INTEGER` | 是 | 无 | 兼容字段和展示顺序；当前旧 RPC 仍会使用它决定下一节点 |
| `approver_mode` | `VARCHAR(30)` | 否 | `role` | 审批人解析方式 |
| `approver_role_code` | `VARCHAR(100)` | 否 | `NULL` | 审批角色编码 |
| `approver_user_id` | `INTEGER` | 否 | `NULL` | 固定审批人 ID |
| `allow_reject` | `BOOLEAN` | 否 | `TRUE` | 是否允许当前节点驳回，目前运行时尚未完整接入 |
| `allow_withdraw` | `BOOLEAN` | 否 | `FALSE` | 是否允许当前节点撤回，目前运行时尚未完整接入 |
| `is_start_node` | `BOOLEAN` | 否 | `FALSE` | 是否为流程开始节点 |
| `is_end_node` | `BOOLEAN` | 否 | `FALSE` | 是否为流程结束节点，目前结束判断仍主要依赖顺序流转 |
| `rule_json` | `JSONB` | 否 | `{}` | 条件表达式、节点布局等扩展配置 |

唯一约束：

```text
UNIQUE(process_id, node_key)
```

典型 `rule_json`：

```json
{
  "expr": "amount >= 50000",
  "conditionLabel": "金额判断",
  "layout": {
    "x": 260,
    "y": 24
  }
}
```

## 5. wf_process_instances

### 5.1 用途

流程实例表记录某一张具体业务单据当前运行到哪个流程、哪个节点以及当前状态。

### 5.2 字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `id` | `SERIAL` | 是 | 自增 | 流程实例主键 |
| `corp_id` | `VARCHAR(128)` | 否 | `NULL` | 企业或租户标识 |
| `emp_id` | `VARCHAR(128)` | 否 | `NULL` | 维护人员标识 |
| `is_deleted` | `CHAR(1)` | 否 | `n` | 软删除标记 |
| `created_at` | `TIMESTAMPTZ` | 否 | 当前时间 | 创建时间 |
| `updated_at` | `TIMESTAMPTZ` | 否 | 当前时间 | 更新时间 |
| `process_id` | `INTEGER` | 是 | 无 | 实际使用的流程定义 ID |
| `document_type` | `VARCHAR(100)` | 是 | 无 | 业务单据类型编码 |
| `document_id` | `INTEGER` | 是 | 无 | 业务单据主键 ID |
| `document_no` | `VARCHAR(100)` | 否 | `NULL` | 业务单据编号 |
| `current_node_id` | `INTEGER` | 否 | `NULL` | 当前节点 ID |
| `current_node_key` | `VARCHAR(100)` | 否 | `NULL` | 当前节点编码快照 |
| `current_node_name` | `VARCHAR(200)` | 否 | `NULL` | 当前节点名称快照 |
| `status` | `VARCHAR(30)` | 是 | `draft` | 实例状态，例如 `draft`、`pending`、`approved` |
| `started_by` | `INTEGER` | 否 | `NULL` | 发起人 ID |
| `started_at` | `TIMESTAMP` | 否 | `NULL` | 发起时间 |
| `finished_at` | `TIMESTAMP` | 否 | `NULL` | 完成时间 |
| `finished_by` | `INTEGER` | 否 | `NULL` | 完成人 ID |
| `current_step_no` | `INTEGER` | 否 | `0` | 当前审批步骤号 |

唯一约束：

```text
UNIQUE(document_type, document_id)
```

同一业务单据只能有一个未删除的流程实例。

## 6. wf_process_actions

### 6.1 用途

流程动作表是流程审批历史，记录提交、通过、驳回、撤回等动作及状态变化。

### 6.2 字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `id` | `SERIAL` | 是 | 自增 | 动作记录主键 |
| `corp_id` | `VARCHAR(128)` | 否 | `NULL` | 企业或租户标识 |
| `emp_id` | `VARCHAR(128)` | 否 | `NULL` | 维护人员标识 |
| `is_deleted` | `CHAR(1)` | 否 | `n` | 软删除标记 |
| `created_at` | `TIMESTAMPTZ` | 否 | 当前时间 | 创建时间 |
| `updated_at` | `TIMESTAMPTZ` | 否 | 当前时间 | 更新时间 |
| `instance_id` | `INTEGER` | 是 | 无 | 所属流程实例 |
| `node_id` | `INTEGER` | 否 | `NULL` | 执行动作时所在节点 |
| `action` | `VARCHAR(30)` | 是 | 无 | 动作编码，例如 `submit`、`approve`、`reject`、`withdraw` |
| `action_label` | `VARCHAR(100)` | 是 | 无 | 动作显示名称 |
| `actor_id` | `INTEGER` | 否 | `NULL` | 操作人 ID |
| `actor_username` | `VARCHAR(100)` | 否 | `NULL` | 操作人名称快照 |
| `comment` | `TEXT` | 否 | `NULL` | 审批意见 |
| `from_status` | `VARCHAR(30)` | 否 | `NULL` | 动作前状态 |
| `to_status` | `VARCHAR(30)` | 否 | `NULL` | 动作后状态 |
| `from_node_key` | `VARCHAR(100)` | 否 | `NULL` | 动作前节点编码 |
| `to_node_key` | `VARCHAR(100)` | 否 | `NULL` | 动作后节点编码 |
| `acted_at` | `TIMESTAMPTZ` | 否 | 当前时间 | 实际操作时间 |

## 7. 流程版本与单据类型

推荐使用以下规则解析业务单据对应的流程：

1. 根据 `document_type` 查询 `sys_document_types`。
2. 读取 `workflow_process_id` 作为默认流程关联。
3. 在 `wf_process_definitions` 中确认流程未删除且已启用。
4. 如果同一单据类型存在多个启用版本，选择 `version` 最大的记录。
5. 创建流程实例时，将实际使用的 `process_id` 固化到 `wf_process_instances`。

流程版本发布后，新的单据实例使用新版本；已有实例继续使用实例中固化的旧版本。

## 8. 当前实现边界

- 节点位置保存在 `wf_process_nodes.rule_json.layout`。
- 连线保存在 `wf_process_definitions.config_json.workflowEdges`，尚未拆成独立的 `wf_process_edges` 表。
- 节点属性中的 `allow_reject` 和 `allow_withdraw` 已存储，但当前 RPC 和前端动作栏尚未完全按照节点配置限制操作。
- `is_start_node` 已用于查找提交后的起始节点。
- `is_end_node` 已定义，但当前旧审批 RPC 仍主要使用 `sequence_no` 查找下一节点。
- 条件表达式和连线已支持配置，但后端流程执行目前还没有完全按照条件连线执行。

## 9. 后续建议

后续补充以下实体：

- `sys_document_type_fields`：单据字段定义
- `wf_process_edges`：独立流程连线表
- 单据类型权限表
- 流程节点审批人规则表
- 字段级流程权限表
