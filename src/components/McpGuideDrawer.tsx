import { useTranslation } from "react-i18next";
import { Alert, Descriptions, Divider, Drawer, Space, Table, Tabs, Tag, Typography } from "antd";
import { ApiOutlined } from "@ant-design/icons";
import { McpKeyPanel } from "./McpKeyPanel";
import type { ColumnsType } from "antd/es/table";
import type { CSSProperties } from "react";

interface McpGuideDrawerProps {
  open: boolean;
  onClose: () => void;
}

const { Title, Paragraph, Text, Link } = Typography;

/**
 * 工具清单与后端 src/mcp/tools.ts（只读）+ src/mcp/documentTools.ts（单据写入）
 * 两处注册项一一对应。
 *
 * 这里只保留「结构性事实」——工具名、参数名、类型、是否必填。
 * 说明性文字全部走 i18n，键为 mcpGuide.tool.<name>.title / .desc / .param.<paramName>。
 *
 * 这样拆分的理由：工具名与参数名属于后端 inputSchema 的一部分，
 * 把它们放进翻译文件等于给「前后端不一致」开了口子；而说明文字本来就该随语言变。
 * 后端增删工具后，同步本数组 + 两个语言文件里的对应键。
 */
/**
 * kind 决定右侧标签：
 *   query  —— 纯查询，不改动任何数据
 *   model  —— 依赖大模型（成本更高，可能受模型配置影响）
 *   write  —— 只产草稿（落 sys_ai_pending_actions），业务表不动
 *   commit —— 真正写业务库，必须用草稿编号二次提交
 */
type ToolKind = "query" | "model" | "write" | "commit";

type ToolShape = {
  name: string;
  kind: ToolKind;
  params: { name: string; type: string; required: boolean }[];
};

const TOOL_KIND_TAG: Record<ToolKind, { color: string; labelKey: string }> = {
  query: { color: "green", labelKey: "mcpGuide.tools.queryTag" },
  model: { color: "orange", labelKey: "mcpGuide.tools.modelTag" },
  write: { color: "blue", labelKey: "mcpGuide.tools.writeTag" },
  commit: { color: "red", labelKey: "mcpGuide.tools.commitTag" },
};

const MCP_TOOLS: ToolShape[] = [
  {
    name: "erp_list_entities",
    kind: "query",
    params: [
      { name: "keyword", type: "string", required: false },
      { name: "module", type: "string", required: false },
      { name: "writable_only", type: "boolean", required: false },
      { name: "limit", type: "number", required: false },
    ],
  },
  {
    name: "erp_describe_entity",
    kind: "query",
    params: [{ name: "entity", type: "string", required: true }],
  },
  {
    name: "erp_count_records",
    kind: "query",
    params: [{ name: "entity", type: "string", required: true }],
  },
  {
    name: "erp_finance_summary",
    kind: "query",
    params: [],
  },
  {
    name: "erp_business_analysis",
    kind: "model",
    params: [
      { name: "question", type: "string", required: true },
      { name: "target", type: "string", required: false },
      { name: "query_mode", type: "enum", required: false },
    ],
  },
  {
    name: "erp_search_knowledge",
    kind: "model",
    params: [
      { name: "query", type: "string", required: true },
      { name: "limit", type: "number", required: false },
    ],
  },
  {
    name: "erp_query_documents",
    kind: "query",
    params: [
      { name: "document_no", type: "string", required: false },
      { name: "document_type", type: "string", required: false },
    ],
  },
  {
    name: "erp_create_document",
    kind: "write",
    params: [
      { name: "document_type", type: "string", required: true },
      { name: "party_name", type: "string", required: false },
      { name: "date", type: "string", required: false },
      { name: "warehouse_name", type: "string", required: false },
      { name: "remark", type: "string", required: false },
      { name: "lines", type: "array", required: true },
    ],
  },
  {
    name: "erp_document_action",
    kind: "write",
    params: [
      { name: "action", type: "enum", required: true },
      { name: "document_no", type: "string", required: false },
      { name: "document_id", type: "number", required: false },
      { name: "document_type", type: "string", required: false },
      { name: "comment", type: "string", required: false },
      { name: "rule_code", type: "string", required: false },
    ],
  },
  {
    name: "erp_commit_document",
    kind: "commit",
    params: [{ name: "action_id", type: "number", required: true }],
  },
];

type EnvRow = {
  key: string;
  name: string;
  whereKey: string;
  descKey: string;
};

/** 变量名与配置位置是固定的技术事实，说明文字走 i18n */
const ENV_ROWS: EnvRow[] = [
  {
    key: "1",
    name: "MCP_API_KEYS",
    whereKey: "mcpGuide.server.env.serverEnv",
    descKey: "mcpGuide.server.env.mcpApiKeys",
  },
  {
    key: "2",
    name: "MCP_API_KEY",
    whereKey: "mcpGuide.server.env.clientEnv",
    descKey: "mcpGuide.server.env.mcpApiKey",
  },
  {
    key: "3",
    name: "MCP_USER_ID",
    whereKey: "mcpGuide.server.env.serverEnv",
    descKey: "mcpGuide.server.env.mcpUserId",
  },
  {
    key: "4",
    name: "MCP_TENANT_ID",
    whereKey: "mcpGuide.server.env.serverEnv",
    descKey: "mcpGuide.server.env.mcpTenantId",
  },
];

const FAQ_INDEXES = [1, 2, 3, 4, 5, 6];

/**
 * 配置片段一律不含可翻译文本 —— 占位符用中性的尖括号形式。
 * 把中文写进 JSON 示例会让英文用户复制到一半中文，也容易与真实配置混淆。
 */
const CLIENT_CONFIG_JSON = `{
  "mcpServers": {
    "operp-erp": {
      "command": "/abs/path/to/node",
      "args": ["/abs/path/ai-server/dist/mcp/server.js"],
      "env": {
        "MCP_API_KEY": "<your-mcp-api-key>"
      }
    }
  }
}`;

/** 服务端 .env 现在只放基础项，凭据不在其中 */
const SERVER_ENV_SNIPPET = `PORT=3001
SUPABASE_URL=http://localhost:54321
SUPABASE_SERVICE_ROLE_KEY=<service_role key>`;

/** 已停用的备用通道格式，仅救急时手工启用 */
const FALLBACK_ENV_SNIPPET = `MCP_API_KEYS=operp_xxxxxxxxxxxxxxxx=1,operp_yyyyyyyyyyyyyyyy=2`;

const START_COMMANDS = `cd ai-server
npm install
npm run build        # -> dist/mcp/server.js
npm run mcp:start    # production entry
npm run mcp          # dev (tsx on source)`;

const CODE_BLOCK_STYLE: CSSProperties = {
  margin: 0,
  padding: 12,
  background: "rgba(0, 0, 0, 0.03)",
  border: "1px solid rgba(0, 0, 0, 0.08)",
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.7,
  overflowX: "auto",
};

export function McpGuideDrawer({ open, onClose }: McpGuideDrawerProps) {
  const { t } = useTranslation();

  const paramColumns: ColumnsType<{ key: string; name: string; type: string; required: boolean; desc: string }> = [
    {
      title: t("mcpGuide.tools.colParam"),
      dataIndex: "name",
      width: 150,
      render: (value: string) => <Text code>{value}</Text>,
    },
    { title: t("mcpGuide.tools.colType"), dataIndex: "type", width: 90 },
    {
      title: t("mcpGuide.tools.colRequired"),
      dataIndex: "required",
      width: 88,
      render: (required: boolean) =>
        required ? (
          <Tag color="red">{t("mcpGuide.tools.requiredYes")}</Tag>
        ) : (
          <Tag>{t("mcpGuide.tools.requiredNo")}</Tag>
        ),
    },
    { title: t("mcpGuide.tools.colDesc"), dataIndex: "desc" },
  ];

  const envColumns: ColumnsType<EnvRow> = [
    {
      title: t("mcpGuide.server.env.colName"),
      dataIndex: "name",
      width: 150,
      render: (v: string) => <Text code>{v}</Text>,
    },
    {
      title: t("mcpGuide.server.env.colWhere"),
      dataIndex: "whereKey",
      width: 120,
      render: (v: string) => t(v),
    },
    { title: t("mcpGuide.server.env.colDesc"), dataIndex: "descKey", render: (v: string) => t(v) },
  ];

  const overviewTab = (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Paragraph style={{ marginBottom: 0 }}>{t("mcpGuide.overview.intro")}</Paragraph>

      <Descriptions column={1} bordered size="small">
        <Descriptions.Item label={t("mcpGuide.overview.serviceName")}>operp-erp</Descriptions.Item>
        <Descriptions.Item label={t("mcpGuide.overview.transport")}>
          {t("mcpGuide.overview.transportValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("mcpGuide.overview.scope")}>
          <Tag color="green">{t("mcpGuide.overview.scopeValue")}</Tag>
          <Text type="secondary" style={{ marginLeft: 8 }}>
            {t("mcpGuide.overview.scopeNote")}
          </Text>
        </Descriptions.Item>
        <Descriptions.Item label={t("mcpGuide.overview.isolation")}>
          {t("mcpGuide.overview.isolationValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("mcpGuide.overview.toolCount")}>
          {t("mcpGuide.overview.toolCountValue", { count: MCP_TOOLS.length })}
        </Descriptions.Item>
      </Descriptions>

      <div>
        <Title level={5}>{t("mcpGuide.overview.canTitle")}</Title>
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          <li>{t("mcpGuide.overview.can1")}</li>
          <li>{t("mcpGuide.overview.can2")}</li>
          <li>{t("mcpGuide.overview.can3")}</li>
          <li>{t("mcpGuide.overview.can4")}</li>
          <li>{t("mcpGuide.overview.can5")}</li>
          <li>{t("mcpGuide.overview.can6")}</li>
        </ul>
      </div>

      <div>
        <Title level={5}>{t("mcpGuide.overview.cantTitle")}</Title>
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          <li>{t("mcpGuide.overview.cant1")}</li>
          <li>{t("mcpGuide.overview.cant2")}</li>
          <li>{t("mcpGuide.overview.cant3")}</li>
          <li>{t("mcpGuide.overview.cant4")}</li>
        </ul>
      </div>

      <Alert
        type="warning"
        showIcon
        message={t("mcpGuide.overview.writeTitle")}
        description={t("mcpGuide.overview.writeDesc")}
      />

      <Alert
        type="info"
        showIcon
        message={t("mcpGuide.overview.identityTitle")}
        description={t("mcpGuide.overview.identityDesc")}
      />
    </Space>
  );

  const toolsTab = (
    <Space direction="vertical" size={20} style={{ width: "100%" }}>
      {MCP_TOOLS.map((tool) => {
        const params = tool.params.map((param) => ({
          ...param,
          key: param.name,
          desc: t(`mcpGuide.tool.${tool.name}.param.${param.name}`),
        }));

        return (
          <div key={tool.name}>
            <Space align="center" wrap>
              <Text strong style={{ fontSize: 15 }}>
                {t(`mcpGuide.tool.${tool.name}.title`)}
              </Text>
              <Text code copyable={{ text: tool.name }}>
                {tool.name}
              </Text>
              <Tag color={TOOL_KIND_TAG[tool.kind].color}>
                {t(TOOL_KIND_TAG[tool.kind].labelKey)}
              </Tag>
            </Space>
            <Paragraph type="secondary" style={{ margin: "8px 0 12px" }}>
              {t(`mcpGuide.tool.${tool.name}.desc`)}
            </Paragraph>
            {params.length ? (
              <Table columns={paramColumns} dataSource={params} pagination={false} size="small" />
            ) : (
              <Text type="secondary">{t("mcpGuide.tools.noParams")}</Text>
            )}
            <Divider style={{ margin: "20px 0 0" }} />
          </div>
        );
      })}
    </Space>
  );

  const clientTab = (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Alert
        type="warning"
        showIcon
        message={t("mcpGuide.client.buildTitle")}
        description={t("mcpGuide.client.buildDesc")}
      />

      <div>
        <Title level={5}>{t("mcpGuide.client.configTitle")}</Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t("mcpGuide.client.configHint")}
        </Paragraph>
        <ul style={{ paddingLeft: 20, margin: "8px 0 12px" }}>
          {[
            { code: "command", text: t("mcpGuide.client.configPointCommand") },
            { code: "args", text: t("mcpGuide.client.configPointArgs") },
            { code: "MCP_API_KEY", text: t("mcpGuide.client.configPointKey") },
          ].map((point) => (
            <li key={point.code}>
              <Text code>{point.code}</Text>
              {point.text}
            </li>
          ))}
        </ul>
        <Paragraph copyable={{ text: CLIENT_CONFIG_JSON }} style={{ marginBottom: 12 }}>
          <pre style={CODE_BLOCK_STYLE}>{CLIENT_CONFIG_JSON}</pre>
        </Paragraph>
        <Text type="secondary">
          {t("mcpGuide.client.configEnvNote")} <Text code>ai-server/.env</Text>
        </Text>
      </div>

      <div>
        <Title level={5}>{t("mcpGuide.client.pathTitle")}</Title>
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          <li>
            {t("mcpGuide.client.pathClaude")} <Text code>claude_desktop_config.json</Text>
            <div style={{ marginTop: 2 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t("mcpGuide.client.pathMacosDir")}
              </Text>{" "}
              <Text code style={{ fontSize: 12 }}>
                ~/Library/Application Support/Claude/
              </Text>
            </div>
          </li>
          <li>
            {t("mcpGuide.client.pathCursor")} <Text code>~/.cursor/mcp.json</Text>
          </li>
          <li>
            {t("mcpGuide.client.pathWorkbuddy")} <Text code>~/.workbuddy/mcp.json</Text>
          </li>
        </ul>
      </div>

      <Alert
        type="info"
        showIcon
        message={t("mcpGuide.client.verifyTitle")}
        description={t("mcpGuide.client.verifyDesc")}
      />
    </Space>
  );

  const serverTab = (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Title level={5}>{t("mcpGuide.server.sourceTitle")}</Title>
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          <li>
            <Text strong>{t("mcpGuide.server.sourceDbTitle")}</Text>
            {t("mcpGuide.server.sourceDbDesc")} <Text code>deploy_55_mcp_api_keys.sql</Text>
          </li>
          <li>
            {t("mcpGuide.server.sourceEnvPrefix")} <Text code>.env</Text>
            {t("mcpGuide.server.sourceEnvSuffix")}
          </li>
        </ul>
        <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
          {t("mcpGuide.server.sourceNote")}
        </Paragraph>
      </div>

      <div>
        <Title level={5}>{t("mcpGuide.server.envTitle")}</Title>
        <Table columns={envColumns} dataSource={ENV_ROWS} pagination={false} size="small" />
      </div>

      <Alert
        type="warning"
        showIcon
        message={t("mcpGuide.server.reconnectTitle")}
        description={t("mcpGuide.server.reconnectDesc")}
      />

      <div>
        <Title level={5}>{t("mcpGuide.server.dotenvTitle")}</Title>
        <Paragraph type="secondary" style={{ marginBottom: 8 }}>
          <Text code>.env</Text> {t("mcpGuide.server.dotenvDesc")}
        </Paragraph>
        <pre style={CODE_BLOCK_STYLE}>{SERVER_ENV_SNIPPET}</pre>
      </div>

      <div>
        <Title level={5}>{t("mcpGuide.server.fallbackTitle")}</Title>
        <Paragraph type="secondary" style={{ marginBottom: 8 }}>
          {t("mcpGuide.server.fallbackNote")}
        </Paragraph>
        <pre style={CODE_BLOCK_STYLE}>{FALLBACK_ENV_SNIPPET}</pre>
      </div>

      <div>
        <Title level={5}>{t("mcpGuide.server.commandTitle")}</Title>
        <pre style={CODE_BLOCK_STYLE}>{START_COMMANDS}</pre>
      </div>

      <Alert
        type="success"
        showIcon
        message={t("mcpGuide.server.sharedTitle")}
        description={t("mcpGuide.server.sharedDesc")}
      />
    </Space>
  );

  const faqTab = (
    <Space direction="vertical" size={18} style={{ width: "100%" }}>
      {FAQ_INDEXES.map((index) => (
        <div key={index}>
          <Text strong>{t(`mcpGuide.faq.q${index}`)}</Text>
          <Paragraph type="secondary" style={{ margin: "6px 0 0" }}>
            {t(`mcpGuide.faq.a${index}`)}
          </Paragraph>
        </div>
      ))}
    </Space>
  );

  return (
    <Drawer
      size={880}
      open={open}
      onClose={onClose}
      destroyOnHidden={false}
      title={
        <Space>
          <ApiOutlined />
          {t("mcpGuide.title")}
        </Space>
      }
    >
      <Tabs
        items={[
          { key: "overview", label: t("mcpGuide.tab.overview"), children: overviewTab },
          { key: "keys", label: t("mcpGuide.tab.keys"), children: <McpKeyPanel /> },
          {
            key: "tools",
            label: t("mcpGuide.tab.tools", { count: MCP_TOOLS.length }),
            children: toolsTab,
          },
          { key: "client", label: t("mcpGuide.tab.client"), children: clientTab },
          { key: "server", label: t("mcpGuide.tab.server"), children: serverTab },
          { key: "faq", label: t("mcpGuide.tab.faq"), children: faqTab },
        ]}
      />
      <Divider style={{ marginTop: 24 }} />
      <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
        {t("mcpGuide.footer.before")} <Text code>ai-server/src/mcp/</Text> {t("mcpGuide.footer.between")}{" "}
        <Text code>ai-server/src/mcp/tools.ts</Text>
        {t("mcpGuide.footer.tail")}
        <Link
          href="https://modelcontextprotocol.io"
          target="_blank"
          rel="noreferrer"
          style={{ marginLeft: 8 }}
        >
          {t("mcpGuide.footer.docLink")}
        </Link>
      </Paragraph>
    </Drawer>
  );
}
