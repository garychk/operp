import { useState, useEffect } from 'react';
import { Table, Button, Modal, Form, Input, Select, Space, Popconfirm, message, Avatar, Tag, Card, Upload,Row,Col } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { RcFile } from 'antd/es/upload/interface';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';

interface User {
  id: number;
  username: string;
  real_name: string;
  email: string;
  phone: string;
  avatar_url: string;
  status: string;
  last_login_at: string;
  created_at: string;
}

interface AvatarUploadRequest {
  file: string | Blob | RcFile;
  onError?: (error: Error) => void;
  onSuccess?: (body: unknown, file?: RcFile) => void;
}

const AVATAR_BUCKET = 'avatars';

export function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [form] = Form.useForm();
  const avatarUrl = Form.useWatch('avatar_url', form);

  const getUserStorageFolder = (username: string) => {
    const normalized = username
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    return normalized || 'user-avatar';
  };

  const beforeAvatarUpload = (file: RcFile) => {
    if (!file.type.startsWith('image/')) {
      message.error('只能上传图片文件');
      return Upload.LIST_IGNORE;
    }

    if (file.size > 2 * 1024 * 1024) {
      message.error('头像大小不能超过 2MB');
      return Upload.LIST_IGNORE;
    }

    return true;
  };

  const handleAvatarUpload = async (options: AvatarUploadRequest) => {
    const { file, onError, onSuccess } = options;
    const username = form.getFieldValue('username');

    if (!username) {
      message.warning('请先填写用户名');
      onError?.(new Error('请先填写用户名'));
      return;
    }

    try {
      setAvatarUploading(true);
      const uploadFile = file as RcFile;
      const userFolder = getUserStorageFolder(username);
      const fileExt = uploadFile.name.split('.').pop() || 'png';
      const filePath = `${userFolder}/avatar-${Date.now()}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from(AVATAR_BUCKET)
        .upload(filePath, uploadFile, {
          cacheControl: '3600',
          upsert: true,
          contentType: uploadFile.type,
        });

      if (uploadError) {
        throw uploadError;
      }

      const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(filePath);
      form.setFieldValue('avatar_url', data.publicUrl);
      message.success('头像上传成功');
      onSuccess?.(data, uploadFile);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '头像上传失败';
      message.error(errorMessage);
      onError?.(error instanceof Error ? error : new Error(errorMessage));
    } finally {
      setAvatarUploading(false);
    }
  };

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('sys_users')
        .select('*')
        .eq('is_deleted', 'n')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      setUsers(data || []);
    } catch (error) {
      message.error('获取用户列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleAdd = () => {
    setEditingUser(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (record: User) => {
    setEditingUser(record);
    form.setFieldsValue(record);
    setModalVisible(true);
  };

  const handleDelete = async (id: number) => {
    try {
      await logWithTiming('删除用户', 'DELETE', async () => {
        const { error } = await supabase
          .from('sys_users')
          .update({ is_deleted: 'y' })
          .eq('id', id);
        if (error) throw error;
      });
      message.success('删除成功');
      fetchUsers();
    } catch (error) {
      message.error('删除失败');
    }
  };

  const handleSave = async (values: any) => {
    try {
      if (editingUser) {
        await logWithTiming('更新用户', 'UPDATE', async () => {
          const { error } = await supabase
            .from('sys_users')
            .update(values)
            .eq('id', editingUser.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
          email: values.email,
          password: 'admin123',
        });

        if (signUpError) {
          message.error('创建Auth用户失败: ' + signUpError.message);
          return;
        }

        await logWithTiming('创建用户', 'INSERT', async () => {
          const { error } = await supabase
            .from('sys_users')
            .insert([{ 
              ...values, 
              auth_id: signUpData.user?.id,
              password_hash: '$2a$10$using_supabase_auth' 
            }]);
          if (error) throw error;
        });
        message.success('创建成功！默认密码: admin123');
      }
      setModalVisible(false);
      fetchUsers();
    } catch (error) {
      message.error('保存失败');
    }
  };

  const columns: ColumnsType<User> = [
    {
      title: '头像',
      dataIndex: 'avatar_url',
      width: 80,
      render: (url) => <Avatar src={url} size="large" />,
    },
    {
      title: '用户名',
      dataIndex: 'username',
      width: 120,
    },
    {
      title: '真实姓名',
      dataIndex: 'real_name',
      width: 120,
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      width: 200,
    },
    {
      title: '手机号',
      dataIndex: 'phone',
      width: 120,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status) => (
        <Tag color={status === '1' ? 'success' : 'error'}>
          {status === '1' ? '启用' : '禁用'}
        </Tag>
      ),
    },
    {
      title: '最后登录',
      dataIndex: 'last_login_at',
      width: 180,
      render: (date) => date ? new Date(date).toLocaleString() : '-',
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      width: 180,
      render: (date) => new Date(date).toLocaleString(),
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 200,
      render: (_, record) => (
        <Space>
          <Button type="primary" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Popconfirm title="确定删除吗？" onConfirm={() => handleDelete(record.id)}>
            <Button danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card variant="borderless" title="用户管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增用户</Button>}>      
      
      <Table
        columns={columns}
        dataSource={users}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1200 }}
      />
      <Modal
        title={editingUser ? '编辑用户' : '新增用户'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Row gutter={16}>
            <Col span={18}>
              <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
                <Input disabled={!!editingUser} />
              </Form.Item>
              <Form.Item name="real_name" label="真实姓名" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email' }]}>
                <Input />
              </Form.Item>
              <Form.Item name="phone" label="手机号" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="status" label="状态" initialValue="1">
                <Select>
                  <Select.Option value="1">启用</Select.Option>
                  <Select.Option value="0">禁用</Select.Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="头像">
                <Space direction="vertical" size="small">
                  <Upload
                    accept="image/*"
                    listType="picture-card"
                    maxCount={1}
                    showUploadList={false}
                    beforeUpload={beforeAvatarUpload}
                    customRequest={handleAvatarUpload}
                  >
                    {avatarUrl ? (
                      <Avatar src={avatarUrl} shape="square" size={86} />
                    ) : (
                      <div>
                        <PlusOutlined />
                        <div style={{ marginTop: 8 }}>
                          {avatarUploading ? '上传中' : '上传头像'}
                        </div>
                      </div>
                    )}
                  </Upload>
                  {avatarUrl && (
                    <Button type="link" danger size="small" onClick={() => form.setFieldValue('avatar_url', '')}>
                      移除头像
                    </Button>
                  )}
                </Space>
              </Form.Item>
              <Form.Item name="avatar_url" hidden>
                <Input />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </Card>
  );
}
