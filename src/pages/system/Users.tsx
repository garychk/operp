import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Button, Form, Input, Select, Space, Popconfirm, message, Avatar, Tag, Card, Upload,Row,Col } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { RcFile } from 'antd/es/upload/interface';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import SimpleModal from '../../components/SimpleModal';
import { useAuth } from '../../contexts/AuthContext';

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
  tenant_id?: number | null;
}

interface Role {
  id: number;
  role_code: string;
  role_name: string;
  status: string;
}

interface Tenant {
  id: number;
  code: string;
  name: string;
  status: string;
}

interface AvatarUploadRequest {
  file: string | Blob | RcFile;
  onError?: (error: Error) => void;
  onSuccess?: (body: unknown, file?: RcFile) => void;
}

const AVATAR_BUCKET = 'avatars';

export function Users() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  // 后台开通模式：租户由 super_admin 建，普通管理员只能往自己所属租户里加人
  const currentTenantId = currentUser?.tenantId ?? null;
  const canPickTenant = Boolean(currentUser?.isSuperAdmin);
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
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
      message.error(t('users.onlyImagesAllowed'));
      return Upload.LIST_IGNORE;
    }

    if (file.size > 2 * 1024 * 1024) {
      message.error(t('users.avatarSizeLimit'));
      return Upload.LIST_IGNORE;
    }

    return true;
  };

  const handleAvatarUpload = async (options: AvatarUploadRequest) => {
    const { file, onError, onSuccess } = options;
    const username = form.getFieldValue('username');

    if (!username) {
      message.warning(t('users.enterUsernameFirst'));
      onError?.(new Error(t('users.enterUsernameFirst')));
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
      message.success(t('users.avatarUploadSuccess'));
      onSuccess?.(data, uploadFile);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t('users.avatarUploadFailed');
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
      message.error(t('users.fetchUsersFailed'));
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
      message.error(t('users.fetchRolesFailed'));
    }
  };

  const fetchTenants = async () => {
    try {
      // RLS 已按租户收口：超管看到全部，普通管理员只看到自己所属的那条
      const { data, error } = await supabase
        .from('sys_tenants')
        .select('id, code, name, status')
        .eq('is_deleted', 'n')
        .order('id', { ascending: true });

      if (error) throw error;
      setTenants(data || []);
    } catch (error) {
      message.error(t('users.fetchTenantsFailed'));
    }
  };

  useEffect(() => {
    fetchUsers();
    fetchRoles();
    fetchTenants();
  }, []);

  const handleAdd = () => {
    setEditingUser(null);
    form.resetFields();
    // 默认落到当前管理员所属租户，超管可以在下拉里改成别的租户
    form.setFieldsValue({ tenant_id: currentTenantId });
    setModalVisible(true);
  };

  const handleEdit = (record: User) => {
    setEditingUser(record);
    form.setFieldsValue(record);
    setModalVisible(true);
  };

  const handleDelete = async (id: number) => {
    try {
      await logWithTiming(t('users.logDeleteUser'), 'DELETE', async () => {
        const { error } = await supabase
          .from('sys_users')
          .update({ is_deleted: 'y' })
          .eq('id', id);
        if (error) throw error;
      });
      message.success(t('common.deleteSuccess'));
      fetchUsers();
    } catch (error) {
      message.error(t('common.deleteFailed'));
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
      message.error(t('users.authAccountNotBound'));
      return;
    }
    try {
      setResetLoading(true);
      // Reset password via Edge Function (service_role) to avoid the browser-side "not_admin" error
      await logWithTiming(t('users.logResetPassword'), 'UPDATE', async () => {
        const { data, error } = await supabase.functions.invoke(
          'reset-user-password',
          {
            body: { userId: authId, password: values.password },
          },
        );
        if (error) throw error;
        if (data && data.success === false) {
          throw new Error(data.error || t('users.resetPasswordFailed'));
        }
      });
      message.success(t('users.passwordResetSuccess', { username: resettingUser.username }));
      setResetModalVisible(false);
      resetForm.resetFields();
      setResettingUser(null);
    } catch (error: any) {
      const msg = error?.message || t('users.resetPasswordFailed');
      message.error(msg);
    } finally {
      setResetLoading(false);
    }
  };

  const handleSave = async (values: any) => {
    try {
      // password 只用于创建登录账号，不是 sys_users 的列，必须剔掉再写库
      const { role_ids = [], password, ...userValues } = values;
      let savedUserId = editingUser?.id;

      if (editingUser) {
        await logWithTiming(t('users.logUpdateUser'), 'UPDATE', async () => {
          const { error } = await supabase
            .from('sys_users')
            .update(userValues)
            .eq('id', editingUser.id);
          if (error) throw error;
        });
        message.success(t('common.updateSuccess'));
      } else {
        // 首选 Edge Function：service_role 建 auth 账号，不会把当前管理员的会话顶掉，
        // 也能明确识别「邮箱已注册」。浏览器端 signUp 做不到第二点 ——
        // 邮箱重复时它返回一个混淆的假 user，建出的账号永远登不上且无报错。
        let createdViaFunction = false;

        try {
          const { data, error } = await supabase.functions.invoke(
            'create-tenant-user',
            {
              body: {
                email: values.email,
                password,
                username: values.username,
                real_name: values.real_name,
                phone: values.phone,
                status: values.status ?? '1',
                role_ids: Array.isArray(role_ids) ? role_ids : [],
                tenant_id: userValues.tenant_id ?? currentTenantId,
              },
            },
          );

          // 函数没部署 / 网关不可用时才回退，其它错误一律直接反馈给用户
          const fnMissing =
            !!error &&
            /not found|404|FunctionsRelay|Failed to send a request|fetch/i.test(
              String(error.message || ''),
            );

          if (!error && data && data.success === true) {
            savedUserId = data.userId as number;
            createdViaFunction = true;

            await logWithTiming(t('users.logCreateUser'), 'INSERT', async () => {
              /* Edge Function 已完成落库，这里只补一条审计日志 */
            });

            if (data.partial) {
              message.warning(String(data.warning || t('users.createFailed')));
            }
          } else if (!fnMissing) {
            message.error(
              String(data?.error || error?.message || t('users.createFailed')),
            );
            return;
          }
        } catch (fnError) {
          console.warn(
            '[Users] create-tenant-user unavailable, falling back to browser signUp',
            fnError,
          );
        }

        if (!createdViaFunction) {
          const { data: currentSessionData } = await supabase.auth.getSession();
          const currentSession = currentSessionData.session;

          const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
            email: values.email,
            password,
          });

          if (signUpError) {
            message.error(`${t('users.createAuthUserFailed')}: ${signUpError.message}`);
            return;
          }

          // 邮箱已注册时 Supabase 会返回一个 identities 为空的混淆 user，
          // 拿它的 id 建档案 = 建出一个登不上的账号，必须拦掉
          if (
            signUpData.user &&
            Array.isArray(signUpData.user.identities) &&
            signUpData.user.identities.length === 0
          ) {
            message.error(t('users.emailAlreadyRegistered'));
            return;
          }

          await logWithTiming(t('users.logCreateUser'), 'INSERT', async () => {
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
              message.warning(t('users.sessionRestoreFailed'));
            }
          }
        }

        message.success(
          createdViaFunction
            ? t('users.createSuccess')
            : t('users.createSuccessWithPassword', { password }),
        );
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
      message.error(t('common.saveFailed'));
    }
  };
const columns: ColumnsType<User> = [
    {
      title: t('users.avatar'),
      dataIndex: 'avatar_url',
      width: 80,
      render: (url) => <Avatar src={url} size="large" />,
    },
    {
      title: t('users.username'),
      dataIndex: 'username',
      width: 120,
      ellipsis: true,
    },
    {
      title: t('users.realName'),
      dataIndex: 'real_name',
      width: 120,
    },
    {
      title: t('users.email'),
      dataIndex: 'email',
      width: 200,
    },
    {
      title: t('users.phone'),
      dataIndex: 'phone',
      width: 120,
    },
    {
      title: t('users.role'),
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
      title: t('users.tenant'),
      dataIndex: 'tenant_id',
      width: 140,
      ellipsis: true,
      render: (tenantId: number | null | undefined) => {
        const tenant = tenants.find((item) => item.id === tenantId);
        return tenant ? `${tenant.name}（${tenant.code}）` : '-';
      },
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 100,
      render: (status) => (
        <Tag color={status === '1' ? 'success' : 'error'}>
          {status === '1' ? t('common.enabled') : t('common.disabled')}
        </Tag>
      ),
    },
    {
      title: t('users.lastLogin'),
      dataIndex: 'last_login_at',
      width: 180,
      render: (date) => date ? new Date(date).toLocaleString() : '-',
    },
    {
      title: t('users.createdAt'),
      dataIndex: 'created_at',
      width: 180,
      render: (date) => new Date(date).toLocaleString(),
    },
    {
      title: t('common.actions'),
      key: 'action',
      fixed: 'right',
      width: 320,
      render: (_, record) => (
        <Space>
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)} />          
          <Popconfirm title={t('users.deleteConfirm')} onConfirm={() => handleDelete(record.id)}>
            <Button type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
          <Button type="text"  onClick={() => handleResetPassword(record)}>
            {t('users.resetPassword')}
          </Button>
        </Space>
      ),
    },
  ];
  return (
    <Card className='mainContent' variant="borderless" title={t('users.title')} extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('users.addUser')}</Button>}>      
      
      <Table
        columns={columns}
        dataSource={users}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1200 }}
      />
      <SimpleModal
        title={editingUser ? t('users.editUser') : t('users.addUser')}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Row gutter={16}>
            <Col span={18}>
              <Form.Item name="username" label={t('users.username')} rules={[{ required: true }]}>
                <Input disabled={!!editingUser} />
              </Form.Item>
              <Form.Item name="real_name" label={t('users.realName')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="email" label={t('users.email')} rules={[{ required: true, type: 'email' }]}>
                <Input />
              </Form.Item>
              {!editingUser && (
                <Form.Item
                  name="password"
                  label={t('users.password')}
                  rules={[
                    { required: true, message: t('users.passwordRequired') },
                    { min: 6, message: t('users.passwordTooShort') },
                  ]}
                >
                  <Input.Password
                    placeholder={t('users.passwordPlaceholder')}
                    autoComplete="new-password"
                  />
                </Form.Item>
              )}
              <Form.Item name="phone" label={t('users.phone')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="role_ids" label={t('users.role')}>
                <Select
                  mode="multiple"
                  allowClear
                  placeholder={t('users.selectRolePlaceholder')}
                  options={roles.map((role) => ({
                    label: role.role_name,
                    value: role.id,
                  }))}
                />
              </Form.Item>
              <Form.Item
                name="tenant_id"
                label={t('users.tenant')}
                rules={[{ required: true, message: t('users.selectTenantRequired') }]}
              >
                <Select
                  disabled={!canPickTenant}
                  placeholder={t('users.selectTenantPlaceholder')}
                  options={tenants.map((tenant) => ({
                    label: `${tenant.name}（${tenant.code}）`,
                    value: tenant.id,
                  }))}
                />
              </Form.Item>
              <Form.Item name="status" label={t('common.status')} initialValue="1">
                <Select>
                  <Select.Option value="1">{t('common.enabled')}</Select.Option>
                  <Select.Option value="0">{t('common.disabled')}</Select.Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label={t('users.avatar')}>
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
                          {avatarUploading ? t('users.uploading') : t('users.uploadAvatar')}
                        </div>
                      </div>
                    )}
                  </Upload>
                  {avatarUrl && (
                    <Button type="link" danger size="small" onClick={() => form.setFieldValue('avatar_url', '')}>
                      {t('users.removeAvatar')}
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
      </SimpleModal>
      <SimpleModal
        title={`${t('users.resetPassword')} - ${resettingUser?.username || ''}`}
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
            label={t('users.newPassword')}
            rules={[
              { required: true, message: t('users.enterNewPassword') },
              { min: 6, message: t('users.passwordMinLength') },
            ]}
          >
            <Input.Password placeholder={t('users.enterNewPassword')} autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label={t('users.confirmPassword')}
            dependencies={['password']}
            rules={[
              { required: true, message: t('users.reEnterNewPassword') },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error(t('users.passwordMismatch')));
                },
              }),
            ]}
          >
            <Input.Password placeholder={t('users.reEnterNewPassword')} autoComplete="new-password" />
          </Form.Item>
        </Form>
      </SimpleModal>
    </Card>
  );
}
