import { useState, useEffect } from 'react';
import { Table, Card, DatePicker, Input, Button, Space, Tag, message, Popconfirm } from 'antd';
import { SearchOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { Dayjs } from 'dayjs';
import { supabase } from '../../utils/supabase';

interface Log {
  id: number;
  username: string;
  operation: string;
  method: string;
  params: string;
  ip: string;
  user_agent: string;
  execute_time: number;
  status: string;
  error_msg: string;
  created_at: string;
}

export function Logs() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [searchUsername, setSearchUsername] = useState('');
  const [searchOperation, setSearchOperation] = useState('');
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20 });
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);

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
      message.error('获取日志列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs(pagination.current, pagination.pageSize);
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
      message.success('删除成功');
      fetchLogs(pagination.current, pagination.pageSize);
    } catch (error) {
      message.error('删除失败');
    }
  };

  const handleBatchDelete = async () => {
    try {
      const { error } = await supabase
        .from('sys_logs')
        .update({ is_deleted: 'y' })
        .in('id', selectedRowKeys);
      
      if (error) throw error;
      message.success('批量删除成功');
      setSelectedRowKeys([]);
      fetchLogs(pagination.current, pagination.pageSize);
    } catch (error) {
      message.error('批量删除失败');
    }
  };

  const handleSelectChange = (newSelectedRowKeys: React.Key[]) => {
    setSelectedRowKeys(newSelectedRowKeys);
  };

  const columns: ColumnsType<Log> = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 80,
    },
    {
      title: '操作用户',
      dataIndex: 'username',
      width: 120,
      ellipsis: true,
    },
    {
      title: '操作类型',
      dataIndex: 'operation',
      width: 150,
    },
    {
      title: '请求方法',
      dataIndex: 'method',
      width: 200,
      ellipsis: true,
    },
    {
      title: '请求参数',
      dataIndex: 'params',
      ellipsis: true,
      render: (params) => params || '-',
    },
    {
      title: 'IP地址',
      dataIndex: 'ip',
      width: 130,
    },
    {
      title: '执行时长(ms)',
      dataIndex: 'execute_time',
      width: 120,
      render: (time) => time || '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (status) => (
        <Tag color={status === '1' || status === 'success' ? 'success' : 'error'}>
          {status === '1' || status === 'success' ? '成功' : '失败'}
        </Tag>
      ),
    },
    {
      title: '操作时间',
      dataIndex: 'created_at',
      width: 180,
      render: (date) => new Date(date).toLocaleString(),
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Popconfirm
          title="确定删除这条日志吗？"
          onConfirm={() => handleDelete(record.id)}
          okText="确定"
          cancelText="取消"
        >
          <Button type="text" danger icon={<DeleteOutlined />}>
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const rowSelection = {
    selectedRowKeys,
    onChange: handleSelectChange,
  };

  return (
    <Card variant="borderless" title="系统日志" extra={
      <Space size="middle">
        {selectedRowKeys.length > 0 && (
          <Popconfirm
            title={`确定删除选中的 ${selectedRowKeys.length} 条日志吗？`}
            onConfirm={handleBatchDelete}
            okText="确定"
            cancelText="取消"
          >
            <Button type="primary" danger icon={<DeleteOutlined />}>
              批量删除 ({selectedRowKeys.length})
            </Button>
          </Popconfirm>
        )}
          <Input
            placeholder="用户名"
            value={searchUsername}
            onChange={(e) => setSearchUsername(e.target.value)}
            style={{ width: 150 }}
          />
          <Input
            placeholder="操作类型"
            value={searchOperation}
            onChange={(e) => setSearchOperation(e.target.value)}
            style={{ width: 150 }}
          />
          <DatePicker.RangePicker
            value={dateRange}
            onChange={(dates) => setDateRange(dates as [Dayjs | null, Dayjs | null] | null)}
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>
            查询
          </Button>
          <Button icon={<ReloadOutlined />} onClick={handleReset}>
            重置
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
          showTotal: (total) => `共 ${total} 条`,
          total,
          onChange: handlePageChange,
        }}
      />
    </Card>
  );
}
