import { useState, useEffect } from 'react';
import { Table, Button, Modal, Form, Input, Select, Space, Popconfirm, message, Avatar, Tag, Card, Upload,Row,Col } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, KeyOutlined } from '@ant-design/icons';
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
  auth_id?: string;
  roles?: Role[];
  role_ids?: number[];
}

interface Role {
  id: number;
  role_code: string;
  role_name: string;
  status: string;
}

interface AvatarUploadRequest {
  file: string | Blob | RcFile;
  onError?: (error: Error) => void;
  onSuccess?: (body: unknown, file?: RcFile) => void;
}

const AVATAR_BUCKET = 'avatars';

export function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [form] = Form.useForm();
  const avatarUrl = Form.useWatch('avatar_url', form);
  const [resetModalVisible, setResetModalVisible] = useState(false);
  const [resettingUser, setResettingUser] = useState<User | null>(null);
  const [resetForm] = Form.useForm();
  const [resetLoading, setResetLoading] = useState(false);

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
      const { data: userRows, error } = await supabase
        .from('sys_users')
        .select('*')
        .eq('is_deleted', 'n')
        .order('created_at', { ascending: false });
      
      if (error) throw error;

      const users = userRows || [];
      const userIds = users.map((user) => user.id);
      let userRoleMap = new Map<number, Role[]>();

      if (userIds.length > 0) {
        const { data: userRoleRows, error: userRolesError } = await supabase
          .from('sys_user_roles')
          .select('user_id, role_id, sys_roles(id, role_code, role_name, status)')
          .in('user_id', userIds)
          .eq('is_deleted', 'n');

        if (userRolesError) throw userRolesError;

        userRoleMap = (userRoleRows || []).reduce((map, row: any) => {
          const role = Array.isArray(row.sys_roles) ? row.sys_roles[0] : row.sys_roles;
          if (role) {
            const currentRoles = map.get(row.user_id) || [];
            currentRoles.push(role);
            map.set(row.user_id, currentRoles);
          }
          return map;
        }, new Map<number, Role[]>());
      }

      setUsers(users.map((user) => {
        const userRoles = userRoleMap.get(user.id) || [];
        return {
          ...user,
          roles: userRoles,
          role_ids: userRoles.map((role) => role.id),
        };
      }));
    } catch (error) {
      message.error('获取用户列表失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchRoles = async () => {
    try {
      const { data, error } = await supabase
        .from('sys_roles')
        .select('id, role_code, role_name, status')
        .eq('is_deleted', 'n')
        .eq('status', '1')
        .order('sort_order', { ascending: true });

      if (error) throw error;
      setRoles(data || []);
    } catch (error) {
      message.error('获取角色列表失败');
    }
  };

  useEffect(() => {
    fetchUsers();
    fetchRoles();
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

  const handleResetPassword = (record: User) => {
    setResettingUser(record);
    resetForm.resetFields();
    setResetModalVisible(true);
  };

  const handleResetSubmit = async (values: any) => {
    if (!resettingUser) return;
    const authId = resettingUser.auth_id;
    if (!authId) {
      message.error('该用户未绑定 Auth 账号，无法重置密码');
      return;
    }
    try {
      setResetLoading(true);
      // 通过 Edge Function（service_role）重置密码，避免浏览器端 not_admin 报错
      await logWithTiming('重置用户密码', 'UPDATE', async () => {
        const { data, error } = await supabase.functions.invoke(
          'reset-user-password',
          {
            body: { userId: authId, password: values.password },
          },
        );
        if (error) throw error;
        if (data && data.success === false) {
          throw new Error(data.error || '重置密码失败');
        }
      });
      message.success(`已重置 ${resettingUser.username} 的密码`);
      setResetModalVisible(false);
      resetForm.resetFields();
      setResettingUser(null);
    } catch (error: any) {
      const msg = error?.message || '重置密码失败';
      message.error(msg);
    } finally {
      setResetLoading(false);
    }
  };

  const handleSave = async (values: any) => {
    try {
      const { role_ids = [], ...userValues } = values;
      let savedUserId = editingUser?.id;

      if (editingUser) {
        await logWithTiming('更新用户', 'UPDATE', async () => {
          const { error } = await supabase
            .from('sys_users')
            .update(userValues)
            .eq('id', editingUser.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        const { data: currentSessionData } = await supabase.auth.getSession();
        const currentSession = currentSessionData.session;

        const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
          email: values.email,
          password: 'admin123',
        });

        if (signUpError) {
          message.error('创建Auth用户失败: ' + signUpError.message);
          return;
        }

        await logWithTiming('创建用户', 'INSERT', async () => {
          const { data: insertedUser, error } = await supabase
            .from('sys_users')
            .insert([{ 
              ...userValues, 
              auth_id: signUpData.user?.id,
              password_hash: '$2a$10$using_supabase_auth' 
            }])
            .select('id')
            .single();
          if (error) throw error;
          savedUserId = insertedUser.id;
        });

        if (currentSession) {
          const { error: restoreSessionError } = await supabase.auth.setSession({
            access_token: currentSession.access_token,
            refresh_token: currentSession.refresh_token,
          });

          if (restoreSessionError) {
            message.warning('用户已创建，但恢复当前登录会话失败，请刷新页面重新登录');
          }
        }

        message.success('创建成功！默认密码: admin123');
      }

      if (savedUserId) {
        const selectedRoleIds = Array.isArray(role_ids) ? role_ids : [];
        const selectedRoleIdSet = new Set<number>(selectedRoleIds);

        const { data: existingRoleRows, error: fetchRoleError } = await supabase
          .from('sys_user_roles')
          .select('id, role_id, is_deleted')
          .eq('user_id', savedUserId);

        if (fetchRoleError) throw fetchRoleError;

        const existingRoles = existingRoleRows || [];
        const existingRoleIdSet = new Set(existingRoles.map((row) => row.role_id));
        const rolesToDisable = existingRoles
          .filter((row) => row.is_deleted === 'n' && !selectedRoleIdSet.has(row.role_id))
          .map((row) => row.id);
        const rolesToRestore = existingRoles
          .filter((row) => row.is_deleted !== 'n' && selectedRoleIdSet.has(row.role_id))
          .map((row) => row.id);
        const rolesToInsert = selectedRoleIds
          .filter((roleId: number) => !existingRoleIdSet.has(roleId))
          .map((roleId: number) => ({
            user_id: savedUserId,
            role_id: roleId,
            is_deleted: 'n',
          }));

        if (rolesToDisable.length > 0) {
          const { error: disableRoleError } = await supabase
            .from('sys_user_roles')
            .delete()
            .in('id', rolesToDisable);

          if (disableRoleError) throw disableRoleError;
        }

        if (rolesToRestore.length > 0) {
          const { error: restoreRoleError } = await supabase
            .from('sys_user_roles')
            .update({ is_deleted: 'n' })
            .in('id', rolesToRestore);

          if (restoreRoleError) throw restoreRoleError;
        }

        if (rolesToInsert.length > 0) {
          const { error: insertRoleError } = await supabase
            .from('sys_user_roles')
            .insert(rolesToInsert);

          if (insertRoleError) throw insertRoleError;
        }
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
      ellipsis: true,
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
      title: '角色',
      dataIndex: 'roles',
      render: (userRoles: Role[] = []) => (
        <Space size={[0, 4]} wrap>
          {userRoles.length > 0 ? userRoles.map((role) => (
            <Tag key={role.id} color="blue">{role.role_name}</Tag>
          )) : '-'}
        </Space>
      ),
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
      width: 320,
      render: (_, record) => (
        <Space>
          <Button type="primary" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Button icon={<KeyOutlined />} onClick={() => handleResetPassword(record)}>
            重置密码
          </Button>
          <Popconfirm title="确定删除吗？" onConfirm={() => handleDelete(record.id)}>
            <Button danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];
  return (
    <Card className='mainContent' variant="borderless" title="用户管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增用户</Button>}>      
      
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
              <Form.Item name="role_ids" label="角色">
                <Select
                  mode="multiple"
                  allowClear
                  placeholder="请选择角色"
                  options={roles.map((role) => ({
                    label: role.role_name,
                    value: role.id,
                  }))}
                />
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
      <Modal
        title={`重置密码 - ${resettingUser?.username || ''}`}
        open={resetModalVisible}
        onCancel={() => {
          setResetModalVisible(false);
          resetForm.resetFields();
          setResettingUser(null);
        }}
        onOk={() => resetForm.submit()}
        confirmLoading={resetLoading}
        width={420}
        destroyOnHidden
      >
        <Form form={resetForm} layout="vertical" onFinish={handleResetSubmit}>
          <Form.Item
            name="password"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 6, message: '密码至少 6 位' },
            ]}
          >
            <Input.Password placeholder="请输入新密码" autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认密码"
            dependencies={['password']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('两次输入的密码不一致'));
                },
              }),
            ]}
          >
            <Input.Password placeholder="请再次输入新密码" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
