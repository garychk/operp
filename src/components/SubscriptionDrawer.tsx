/**
 * 订阅管理抽屉（Waffo Pancake 在线订阅收款）。
 *
 * - 展示当前租户的使用期限（sys_tenants.expires_at）与订阅/续费流水；
 * - 「订阅/续费（按月）」调 ai-server POST /api/subscription/checkout，
 *   拿到 checkoutUrl 后**新标签页打开**收银台（不能用页面跳转，会丢登录态）；
 * - 支付结果由 Waffo webhook 回调 ai-server → 库内 RPC 幂等续租，
 *   本抽屉不做任何支付结果的本地推断，重新拉一次 status 即可看到新期限。
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { PayCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";
import { aiServerAuthHeaders, resolveAiServerBaseUrl } from "../utils/aiServer";
import { formatShanghaiDateTime } from "../utils/datetime";

interface SubscriptionHistoryRow {
  id: number;
  event_type: string;
  order_id: string | null;
  product_name: string | null;
  buyer_email: string | null;
  currency: string | null;
  amount: string | number | null;
  mode: string | null;
  months: number;
  period_start: string;
  period_end: string;
  created_at: string;
}

interface SubscriptionStatus {
  ok: boolean;
  configured: boolean;
  environment: "test" | "prod";
  plan: { billingPeriod: string; productId: string | null; currency: string };
  tenant: { id: number; code: string; name: string; expires_at: string | null } | null;
  history: SubscriptionHistoryRow[];
}

const EXPIRY_SOON_DAYS = 30;

export function SubscriptionDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const headers = await aiServerAuthHeaders();
      const res = await fetch(`${resolveAiServerBaseUrl()}/api/subscription/status`, {
        headers,
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setStatus(data as SubscriptionStatus);
    } catch (err) {
      // fetch 自身的 TypeError（Failed to fetch）= 连接都没建立：服务没起 / 端口不对 / CORS
      const hint =
        err instanceof TypeError
          ? t("subscription.error.unreachable", { url: `${resolveAiServerBaseUrl() || window.location.origin}/api/subscription` })
          : err instanceof Error
            ? err.message
            : String(err);
      message.error(`${t("subscription.error.load")}: ${hint}`);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) void loadStatus();
  }, [open, loadStatus]);

  const handleSubscribe = async () => {
    setCheckoutLoading(true);
    try {
      const headers = {
        ...(await aiServerAuthHeaders()),
        "Content-Type": "application/json",
      };
      const res = await fetch(`${resolveAiServerBaseUrl()}/api/subscription/checkout`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          success_url: `${window.location.origin}/?subscription=success`,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      // 收银台必须新标签页打开：保留本页登录态与滚动位置
      window.open(data.checkout_url, "_blank", "noopener,noreferrer");
      message.info(t("subscription.checkout.opened"));
    } catch (err) {
      const hint =
        err instanceof TypeError
          ? t("subscription.error.unreachable", { url: `${resolveAiServerBaseUrl() || window.location.origin}/api/subscription` })
          : err instanceof Error
            ? err.message
            : String(err);
      message.error(`${t("subscription.error.checkout")}: ${hint}`);
    } finally {
      setCheckoutLoading(false);
    }
  };

  const expiryInfo = (() => {
    const expiresAt = status?.tenant?.expires_at ?? null;
    if (!expiresAt) {
      return { tag: <Tag>{t("subscription.expires.unlimited")}</Tag>, days: null };
    }
    const days = dayjs(expiresAt).diff(dayjs(), "day");
    if (days < 0) {
      return {
        tag: <Tag color="red">{t("subscription.expires.expired")}</Tag>,
        days,
      };
    }
    if (days <= EXPIRY_SOON_DAYS) {
      return {
        tag: <Tag color="orange">{t("subscription.expires.soon", { days })}</Tag>,
        days,
      };
    }
    return {
      tag: <Tag color="green">{t("subscription.expires.ok", { days })}</Tag>,
      days,
    };
  })();

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={1020}
      title={
        <Space>
          <PayCircleOutlined />
          {t("subscription.title")}
        </Space>
      }
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void loadStatus()} loading={loading}>
          {t("subscription.refresh")}
        </Button>
      }
    >
      {status && !status.configured && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("subscription.error.config")}
        />
      )}

      <Descriptions
        bordered
        size="small"
        column={1}
        items={[
          {
            key: "tenant",
            label: t("subscription.tenant"),
            children: status?.tenant
              ? `${status.tenant.name} (${status.tenant.code})`
              : "-",
          },
          {
            key: "expires",
            label: t("subscription.tenantExpires"),
            children: (
              <Space>
                {status?.tenant?.expires_at
                  ? formatShanghaiDateTime(status.tenant.expires_at)
                  : null}
                {expiryInfo.tag}
              </Space>
            ),
          },
          {
            key: "plan",
            label: t("subscription.plan"),
            children: (
              <Space>
                <Tag color="blue">{t("subscription.plan.monthly")}</Tag>                
                {status?.plan.currency ? <Tag>{status.plan.currency}</Tag> : null}
                <Tag color="gold">19.9 / {t("common.monthly")}</Tag>
                {status?.environment ? (
                  <Tag color={status.environment === "prod" ? "green" : "gold"}>
                    {t(`subscription.env.${status.environment}`)}
                  </Tag>
                ) : null}
              </Space>
            ),
          },
        ]}
      />

      <div style={{ margin: "16px 0" }}>
        <Button
          type="primary"
          icon={<PayCircleOutlined />}
          disabled={status ? !status.configured : false}
          loading={checkoutLoading}
          onClick={() => void handleSubscribe()}
        >
          {t("subscription.action.subscribe")}
        </Button>
        <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
          {t("subscription.checkout.hint")}
        </Typography.Text>
      </div>

      <Typography.Title level={5} style={{ marginTop: 8 }}>
        {t("subscription.history.title")}
      </Typography.Title>
      <Table<SubscriptionHistoryRow>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={status?.history ?? []}
        pagination={{ pageSize: 8, hideOnSinglePage: true }}
        locale={{ emptyText: t("subscription.history.empty") }}
        columns={[
          {
            title: t("subscription.history.col.time"),
            dataIndex: "created_at",
            width: 160,
            render: (v: string) => formatShanghaiDateTime(v),
          },
          {
            title: t("subscription.history.col.event"),
            dataIndex: "event_type",
            width: 200,
            ellipsis: true,
          },
          {
            title: t("subscription.history.col.order"),
            dataIndex: "order_id",
            width: 140,
            ellipsis: true,
            render: (v: string | null) => v ?? "-",
          },
          {
            title: t("subscription.history.col.amount"),
            width: 110,
            render: (_: unknown, row) =>
              row.amount != null ? `${row.currency ?? ""} ${row.amount}` : "-",
          },
          {
            title: t("subscription.history.col.months"),
            dataIndex: "months",
            width: 70,
          },
          {
            title: t("subscription.history.col.until"),
            dataIndex: "period_end",
            width: 160,
            render: (v: string) => formatShanghaiDateTime(v),
          },
          {
            title: t("subscription.history.col.mode"),
            dataIndex: "mode",
            width: 80,
            render: (v: string | null) =>
              v ? (
                <Tag color={v === "prod" ? "green" : "gold"}>
                  {t(`subscription.env.${v}`)}
                </Tag>
              ) : (
                "-"
              ),
          },
        ]}
      />
    </Drawer>
  );
}
