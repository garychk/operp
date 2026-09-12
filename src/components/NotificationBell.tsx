import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Empty, List, Popover, Tabs, Tag, Typography, message, notification as antdNotification } from "antd";
import {
  AuditOutlined,
  BellOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  ScheduleOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabase } from "../utils/supabase";
import { useAuth } from "../contexts/AuthContext";
import { formatShanghaiDateTime } from "../utils/datetime";

export interface NotificationRow {
  id: number;
  recipient_user_id: number;
  recipient_role_code: string | null;
  notification_type: string;
  severity: string;
  title: string;
  content: string | null;
  source_type: string | null;
  source_id: number | null;
  source_no: string | null;
  link_path: string | null;
  is_read: boolean | null;
  read_at: string | null;
  created_at: string | null;
}

type NotificationTabKey = "all" | "approval" | "warning" | "task";

const PAGE_SIZE = 50;

const typeIconMap: Record<string, React.ReactNode> = {
  approval_pending: <AuditOutlined />,
  approval_result: <SendOutlined />,
  inventory_warning: <DatabaseOutlined />,
  order_delay: <ClockCircleOutlined />,
  task_completed: <ScheduleOutlined />,
};

const severityColorMap: Record<string, string> = {
  info: "blue",
  warning: "orange",
  critical: "red",
};

function typeLabelKey(type: string): string {
  const map: Record<string, string> = {
    approval_pending: "notification.type.approvalPending",
    approval_result: "notification.type.approvalResult",
    inventory_warning: "notification.type.inventoryWarning",
    order_delay: "notification.type.orderDelay",
    task_completed: "notification.type.taskCompleted",
  };
  return map[type] ?? "notification.type.approvalResult";
}

function tabOf(type: string): NotificationTabKey {
  if (type === "approval_pending" || type === "approval_result") return "approval";
  if (type === "inventory_warning" || type === "order_delay") return "warning";
  if (type === "task_completed") return "task";
  return "all";
}

export function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<NotificationTabKey>("all");
  const [loading, setLoading] = useState(false);

  const userId = user?.profile?.id ?? null;
  const channelName = useMemo(() => (userId ? `sys-notifications-${userId}` : ""), [userId]);
  const userIdRef = useRef<number | null>(null);
  userIdRef.current = userId;

  const refreshUnreadCount = useCallback(async () => {
    if (!userIdRef.current) return;
    const { count, error } = await supabase
      .from("sys_notifications")
      .select("id", { count: "exact", head: true })
      .eq("is_deleted", "n")
      .eq("recipient_user_id", userIdRef.current)
      .eq("is_read", false);
    if (!error) {
      setUnreadCount(count ?? 0);
    }
  }, []);

  const fetchList = useCallback(async () => {
    if (!userIdRef.current) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("sys_notifications")
        .select("*")
        .eq("is_deleted", "n")
        .eq("recipient_user_id", userIdRef.current)
        .order("created_at", { ascending: false })
        .limit(PAGE_SIZE);
      if (error) throw error;
      setRows((data as NotificationRow[]) ?? []);
    } catch (error) {
      console.error("Failed to load notifications:", error);
      message.error(t("notification.fetchFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!userId) {
      setRows([]);
      setUnreadCount(0);
      return;
    }
    void fetchList();
    void refreshUnreadCount();
  }, [userId, fetchList, refreshUnreadCount]);

  useEffect(() => {
    if (!channelName) return;

    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "sys_notifications",
          filter: `recipient_user_id=eq.${userId}`,
        },
        (payload: RealtimePostgresChangesPayload<NotificationRow>) => {
          const row = payload.new as NotificationRow;
          if (!row) return;
          setRows((prev) => [row, ...prev].slice(0, PAGE_SIZE));
          setUnreadCount((prev) => prev + 1);
          antdNotification.open({
            message: t("notification.newMessage"),
            description: row.title,
            placement: "bottomRight",
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [channelName, userId, t]);

  const markRead = useCallback(
    async (row: NotificationRow, navigateTo = true) => {
      if (!row.is_read) {
        try {
          const { error } = await supabase
            .from("sys_notifications")
            .update({ is_read: true, read_at: new Date().toISOString() })
            .eq("id", row.id);
          if (error) throw error;
          setRows((prev) => prev.map((item) => (item.id === row.id ? { ...item, is_read: true } : item)));
          setUnreadCount((prev) => Math.max(0, prev - 1));
        } catch (error) {
          console.error("Failed to mark notification read:", error);
        }
      }
      if (navigateTo && row.link_path) {
        setOpen(false);
        navigate(row.link_path);
      }
    },
    [navigate],
  );

  const markAllRead = useCallback(async () => {
    if (!userIdRef.current) return;
    const unreadIds = rows.filter((row) => !row.is_read).map((row) => row.id);
    if (unreadIds.length === 0) return;
    try {
      const { error } = await supabase
        .from("sys_notifications")
        .update({ is_read: true, read_at: new Date().toISOString() })
        .in("id", unreadIds);
      if (error) throw error;
      setRows((prev) => prev.map((row) => ({ ...row, is_read: true })));
      setUnreadCount(0);
      message.success(t("notification.markAllRead"));
    } catch (error) {
      console.error("Failed to mark all notifications read:", error);
    }
  }, [rows, t]);

  const filteredRows = useMemo(() => {
    if (activeTab === "all") return rows;
    return rows.filter((row) => tabOf(row.notification_type) === activeTab);
  }, [rows, activeTab]);

  const content = (
    <div style={{ width: 380 }}>
      <Tabs
        size="small"
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as NotificationTabKey)}
        items={[
          { key: "all", label: t("notification.tab.all") },
          { key: "approval", label: t("notification.tab.approval") },
          { key: "warning", label: t("notification.tab.warning") },
          { key: "task", label: t("notification.tab.task") },
        ]}
        tabBarStyle={{ marginBottom: 8 }}
      />
      <div style={{ maxHeight: 420, overflowY: "auto" }}>
        {filteredRows.length === 0 && !loading ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("notification.empty")} style={{ padding: "24px 0" }} />
        ) : (
          <List
            size="small"
            loading={loading}
            dataSource={filteredRows}
            rowKey={(row) => String(row.id)}
            renderItem={(row) => (
              <List.Item
                style={{
                  cursor: "pointer",
                  padding: "8px 4px",
                  background: row.is_read ? undefined : "rgba(22, 119, 255, 0.06)",
                  borderRadius: 6,
                }}
                onClick={() => void markRead(row)}
              >
                <List.Item.Meta
                  avatar={<span style={{ fontSize: 16 }}>{typeIconMap[row.notification_type] ?? <BellOutlined />}</span>}
                  title={
                    <span>
                      {!row.is_read && <Badge status="processing" style={{ marginRight: 6 }} />}
                      <Typography.Text strong={!row.is_read} ellipsis style={{ maxWidth: 200 }}>
                        {row.title}
                      </Typography.Text>
                      <Tag
                        color={severityColorMap[row.severity] ?? "default"}
                        style={{ marginLeft: 8 }}
                      >
                        {t(typeLabelKey(row.notification_type))}
                      </Tag>
                    </span>
                  }
                  description={
                    <>
                      <div>{row.content}</div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {formatShanghaiDateTime(row.created_at)}
                        {row.source_no ? ` · ${row.source_no}` : ""}
                      </Typography.Text>
                    </>
                  }
                />
                {!row.is_read && (
                  <Button
                    size="small"
                    type="text"
                    icon={<CheckOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      void markRead(row, false);
                    }}
                  />
                )}
              </List.Item>
            )}
          />
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 8, borderTop: "1px solid #f0f0f0" }}>
        <Button size="small" type="link" onClick={() => void markAllRead()} disabled={unreadCount === 0}>
          {t("notification.markAllRead")}
        </Button>
      </div>
    </div>
  );

  return (
    <Popover
      content={content}
      title={t("notification.title")}
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void fetchList();
      }}
    >
      <Badge count={unreadCount} size="small" offset={[-2, 2]}>
        <BellOutlined style={{ fontSize: 16, cursor: "pointer" }} aria-label={t("notification.title")} />
      </Badge>
    </Popover>
  );
}

export default NotificationBell;
