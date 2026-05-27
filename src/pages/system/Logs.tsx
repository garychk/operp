import { useState, useEffect } from 'react';
import { Table, Card, DatePicker, Input, Button, Space, Tag, message } from 'antd';
import { SearchOutlined, ReloadOutlined } from '@ant-design/icons';
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
  const [searchUsername, setSearchUsername] = useState('');
  const [searchOperation, setSearchOperation] = useState('');
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      let query = supabase
        .from('sys_logs')
        .select('*')
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
      
      const { data, error } = await query.limit(500);
      
      if (error) throw error;
      setLogs(data || []);
    } catch (error) {
      message.error('获取日志列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, []);

  const handleSearch = () => {
    fetchLogs();
  };

  const handleReset = () => {
    setSearchUsername('');
    setSearchOperation('');
    setDateRange(null);
    fetchLogs();
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
  ];

  return (
    <Card variant="borderless" title="系统日志" extra={
      <Space size="middle">
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
        scroll={{ x: 1400, y: 680 }}
        pagination={{
          pageSize: 20,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 条`,
        }}
      />
    </Card>
  );
}
