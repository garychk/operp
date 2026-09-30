import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Card, DatePicker, Input, Button, Space, Tag, message, Popconfirm, Descriptions, Modal } from 'antd';
import { SearchOutlined, ReloadOutlined, DeleteOutlined, EyeOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { Dayjs } from 'dayjs';
import { supabase } from '../../utils/supabase';
import { useAuth } from '../../contexts/AuthContext';

interface Log {
  id: number;
  username: string;
  operation: string;
  method: string;
  params: Record<string, unknown> | string | null;
  ip: string;
  user_agent: string;
  execute_time: number;
  status: string;
  error_msg: string;
  created_at: string;
  tenant_id?: number | null;
}

interface TenantOption {
  id: number;
  name: string;
}

export function Logs() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [logs, setLogs] = useState<Log[]>([]);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [searchUsername, setSearchUsername] = useState('');
  const [searchOperation, setSearchOperation] = useState('');
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20 });
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [currentLog, setCurrentLog] = useState<Log | null>(null);

  const fetchLogs = async (page = 1, pageSize = 20) => {
    setLoading(true);
    try {
      let query = supabase
        .from('sys_logs')
        .select('*', { count: 'exact' })
        .eq('is_deleted', 'n')
        .order('created_at', { ascending: false });

      if (searchUsername) {
        query = query.ilike('username', `%${searchUsername}%`);
      }
      if (searchOperation) {
        query = query.ilike('operation', `%${searchOperation}%`);
      }
      if (dateRange && dateRange[0] && dateRange[1]) {
        query = query.gte('created_at', dateRange[0].format('YYYY-MM-DD'))
          .lte('created_at', dateRange[1].format('YYYY-MM-DD'));
      }

      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);

      if (error) throw error;
      setLogs(data || []);
      setTotal(count || 0);
    } catch (error) {
      message.error(t('logs.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  // 只有 super_admin 能看到跨租户日志，其余人看到的全是自己租户的，
  // 加这列反而占宽度，所以按角色决定是否展示。
  const showTenantColumn = user?.isSuperAdmin === true;

  const fetchTenants = async () => {
    if (!showTenantColumn) return;
    const { data, error } = await supabase
      .from('sys_tenants')
      .select('id, name')
      .eq('is_deleted', 'n')
      .order('id');
    if (error) {
      console.error('Failed to fetch tenants:', error);
      return;
    }
    setTenants((data as TenantOption[]) || []);
  };

  const tenantName = (id?: number | null) => {
    if (!id) return '-';
    return tenants.find((item) => item.id === id)?.name || `#${id}`;
  };

  useEffect(() => {
    fetchLogs(pagination.current, pagination.pageSize);
    fetchTenants();
  }, []);

  const handleSearch = () => {
    setPagination({ current: 1, pageSize: 20 });
    fetchLogs(1, 20);
  };

  const handleReset = () => {
    setSearchUsername('');
    setSearchOperation('');
    setDateRange(null);
    setPagination({ current: 1, pageSize: 20 });
    fetchLogs(1, 20);
  };

  const handlePageChange = (page: number, pageSize: number) => {
    setPagination({ current: page, pageSize });
    fetchLogs(page, pageSize);
  };

  const handleDelete = async (id: number) => {
    try {
      const { error } = await supabase
        .from('sys_logs')
        .update({ is_deleted: 'y' })
        .eq('id', id);

      if (error) throw error;
      message.success(t('common.deleteSuccess'));
      fetchLogs(pagination.current, pagination.pageSize);
    } catch (error) {
      message.error(t('common.deleteFailed'));
    }
  };

  const handleBatchDelete = async () => {
    try {
      const { error } = await supabase
        .from('sys_logs')
        .update({ is_deleted: 'y' })
        .in('id', selectedRowKeys);

      if (error) throw error;
      message.success(t('logs.batchDeleteSuccess'));
      setSelectedRowKeys([]);
      fetchLogs(pagination.current, pagination.pageSize);
    } catch (error) {
      message.error(t('logs.batchDeleteFailed'));
    }
  };

  const handleSelectChange = (newSelectedRowKeys: React.Key[]) => {
    setSelectedRowKeys(newSelectedRowKeys);
  };

  const handleViewDetail = (log: Log) => {
    setCurrentLog(log);
    setIsDetailModalOpen(true);
  };

  const handleCloseDetailModal = () => {
    setIsDetailModalOpen(false);
    setCurrentLog(null);
  };

  const formatParams = (params: Log['params']) => {
    if (!params) return '-';
    return typeof params === 'string' ? params : JSON.stringify(params);
  };

  const allColumns: ColumnsType<Log> = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 80,
    },
    {
      title: t('logs.operator'),
      dataIndex: 'username',
      width: 120,
      ellipsis: true,
    },
    {
      title: t('logs.tenant'),
      dataIndex: 'tenant_id',
      width: 130,
      ellipsis: true,
      render: (tenantId) => tenantName(tenantId),
    },
    {
      title: t('logs.operationType'),
      dataIndex: 'operation',
      width: 150,
    },
    {
      title: t('logs.requestMethod'),
      dataIndex: 'method',
      width: 200,
      ellipsis: true,
    },
    {
      title: t('logs.requestParams'),
      dataIndex: 'params',
      ellipsis: true,
      render: (params) => formatParams(params),
    },
    {
      title: t('logs.ipAddress'),
      dataIndex: 'ip',
      width: 130,
    },
    {
      title: t('logs.executeTimeMs'),
      dataIndex: 'execute_time',
      width: 120,
      render: (time) => time || '-',
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 80,
      render: (status) => (
        <Tag color={status === '1' || status === 'success' ? 'success' : 'error'}>
          {status === '1' || status === 'success' ? t('logs.success') : t('logs.failure')}
        </Tag>
      ),
    },
    {
      title: t('logs.operationTime'),
      dataIndex: 'created_at',
      width: 180,
      render: (date) => new Date(date).toLocaleString(),
    },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_, record) => (
        <Space>
          <Button type="text" icon={<EyeOutlined />} onClick={() => handleViewDetail(record)}>
            {t('logs.detail')}
          </Button>
          <Popconfirm
            title={t('logs.deleteSingleConfirm')}
            onConfirm={() => handleDelete(record.id)}
            okText={t('logs.confirm')}
            cancelText={t('common.cancel')}
          >
            <Button type="text" danger icon={<DeleteOutlined />}>
              {t('common.delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  // 先声明成 ColumnsType<Log> 再过滤，直接在字面量数组上 .filter()
  // 会让 render 回调的参数丢失上下文类型，下面 6 个 render 全部变成隐式 any。
  const columns = (
    showTenantColumn
      ? allColumns
      : allColumns.filter((col) => !('dataIndex' in col && col.dataIndex === 'tenant_id'))
  ) as ColumnsType<Log>;

  const rowSelection = {
    selectedRowKeys,
    onChange: handleSelectChange,
  };

  return (
    <>
      <Card variant="borderless" title={t('logs.title')} extra={
        <Space size="middle">
          {selectedRowKeys.length > 0 && (
            <Popconfirm
              title={t('logs.batchDeleteConfirm', { count: selectedRowKeys.length })}
              onConfirm={handleBatchDelete}
              okText={t('logs.confirm')}
              cancelText={t('common.cancel')}
            >
              <Button type="primary" danger icon={<DeleteOutlined />}>
                {t('logs.batchDelete')} ({selectedRowKeys.length})
              </Button>
            </Popconfirm>
          )}
          <Input
            placeholder={t('logs.username')}
            value={searchUsername}
            onChange={(e) => setSearchUsername(e.target.value)}
            style={{ width: 150 }}
          />
          <Input
            placeholder={t('logs.operationType')}
            value={searchOperation}
            onChange={(e) => setSearchOperation(e.target.value)}
            style={{ width: 150 }}
          />
          <DatePicker.RangePicker
            value={dateRange}
            onChange={(dates) => setDateRange(dates as [Dayjs | null, Dayjs | null] | null)}
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>
            {t('logs.search')}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={handleReset}>
            {t('common.reset')}
          </Button>
        </Space>
      }>
        <Table
          columns={columns}
          dataSource={logs}
          loading={loading}
          rowKey="id"
          scroll={{ y: 500 }}
          size="small"
          rowSelection={rowSelection}
          pagination={{
            current: pagination.current,
            pageSize: pagination.pageSize,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50', '100'],
            showTotal: (total) => t('logs.total', { total }),
            total,
            onChange: handlePageChange,
          }}
        />
      </Card>
      <Modal
        title={t('logs.detailTitle')}
        open={isDetailModalOpen}
        onCancel={handleCloseDetailModal}
        footer={null}
        width={800}
        height={500}
      >
        {currentLog && (
            <Descriptions column={1} size='small' bordered>
            <Descriptions.Item label={t('logs.logId')}>{currentLog.id}</Descriptions.Item>
            <Descriptions.Item label={t('logs.operator')}>{currentLog.username}</Descriptions.Item>
            <Descriptions.Item label={t('logs.operationType')}>{currentLog.operation}</Descriptions.Item>
            <Descriptions.Item label={t('logs.requestMethod')}>{currentLog.method}</Descriptions.Item>
            <Descriptions.Item label={t('logs.requestParams')}>{formatParams(currentLog.params)}</Descriptions.Item>
            <Descriptions.Item label={t('logs.ipAddress')}>{currentLog.ip}</Descriptions.Item>
            <Descriptions.Item label="User Agent">{currentLog.user_agent || '-'}</Descriptions.Item>
            <Descriptions.Item label={t('logs.executeTime')}>{currentLog.execute_time} ms</Descriptions.Item>
            <Descriptions.Item label={t('common.status')}>
              <Tag color={currentLog.status === '1' || currentLog.status === 'success' ? 'success' : 'error'}>
                {currentLog.status === '1' || currentLog.status === 'success' ? t('logs.success') : t('logs.failure')}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('logs.operationTime')}>
              {new Date(currentLog.created_at).toLocaleString()}
            </Descriptions.Item>
            <Descriptions.Item label={t('logs.errorMessage')}>
              <span className="detail-value error-msg">{currentLog.error_msg || t('logs.none')}</span>
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </>
  );
}
