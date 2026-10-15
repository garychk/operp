import { useEffect, useState } from "react";
import { useTranslation } from 'react-i18next';
import type { Key } from "react";
import {
  Button,
  Input,
  Table,
  Tag,
  Modal,
  Form,
  Select,
  Space,
  message,
  InputNumber,
  Checkbox,
  Row,
  Col,
  DatePicker,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ShoppingOutlined,
  CheckOutlined,
  PrinterOutlined,
  AppstoreOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import { SuperTable } from "../../components/SuperTable";
import dayjs from "dayjs";
import { SupaModal, buildModalNav } from "../../components/SupaModal";
import { BizAttachments } from "../../components/BizAttachments";
import { RoutingMap } from "../../components/RoutingMap";
import SimpleModal from "../../components/SimpleModal";

type Routing = Tables["erp_routing_operations_s_539dcf81_b"]["Row"];
type RoutingDetail =
  Tables["erp_routing_operation_details_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type Operation = Tables["erp_operations_s_539dcf81_b"]["Row"];

const { Option } = Select;
const routingTable = "erp_routing_operations_s_539dcf81_b";
const routingDetailTable = "erp_routing_operation_details_s_539dcf81_b";

export function RoutingOperations() {
  const { t } = useTranslation();
  const [routings, setRoutings] = useState<Routing[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [isMapModalOpen, setIsMapModalOpen] = useState(false);
  const [editingRouting, setEditingRouting] = useState<Routing | null>(null);
  const [selectedRouting, setSelectedRouting] = useState<Routing | null>(null);
  const [details, setDetails] = useState<RoutingDetail[]>([]);
  const [editingDetail, setEditingDetail] = useState<RoutingDetail | null>(
    null,
  );
  const [detailForm] = Form.useForm();
  const [form] = Form.useForm();

  useEffect(() => {
    fetchRoutings();
    fetchProducts();
    fetchOperations();
  }, []);

  const fetchOperations = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_operations_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setOperations(data || []);
    } catch (error) {
      console.error("Error fetching operations:", error);
    }
  };

  const fetchRoutings = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(routingTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setRoutings(data || []);
    } catch (error) {
      console.error("Error fetching routings:", error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const fetchProducts = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_products_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .eq("is_manufactured", true);
      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error("Error fetching products:", error);
    }
  };

  const fetchDetails = async (routingId: number) => {
    try {
      const { data, error } = await supabase
        .from("erp_routing_operation_details_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .eq("routing_id", routingId)
        .order("sequence_no");
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error("Error fetching details:", error);
      message.error(t('mrp.fetchDetailsFailed'));
    }
  };

  const handleShowMap = async (record: Routing) => {
    await fetchDetails(record.id);
    setSelectedRouting(record);
    setIsMapModalOpen(true);
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingRouting) {
        await logWithTiming(
          t("mrp.routingOperations.logUpdate"),
          "UPDATE",
          async () => {
            const { error } = await supabase
              .from(routingTable)
              .update(values)
              .eq("id", editingRouting.id);
            if (error) throw error;
          },
          { table: routingTable, recordId: editingRouting.id },
        );
        message.success(t('common.updateSuccess'));
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: routingTable,
        };
        const data = await logWithTiming(
          t("mrp.routingOperations.logCreate"),
          "INSERT",
          async () => {
            const { data, error } = await supabase
              .from(routingTable)
              .insert([values])
              .select()
              .single();
            if (error) throw error;
            logParams.recordId = data.id;
            return data;
          },
          logParams,
        );
        setSelectedRouting(data);
        message.success(t('common.createSuccess'));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingRouting(null);
      fetchRoutings();
    } catch (error) {
      console.error("Error saving routing:", error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedRouting) {
        message.error(t('mrp.routingOperations.selectRoutingFirst'));
        return;
      }

      if (editingDetail) {
        await supabase
          .from("erp_routing_operation_details_s_539dcf81_b")
          .update(values)
          .eq("id", editingDetail.id);
        message.success(t('common.updateSuccess'));
      } else {
        values.routing_id = selectedRouting.id;
        values.is_deleted = "n";

        const { error } = await supabase
          .from("erp_routing_operation_details_s_539dcf81_b")
          .insert([values]);
        if (error) throw error;
        message.success(t('common.createSuccess'));
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      fetchDetails(selectedRouting.id);
      updateRoutingTotal(selectedRouting.id);
    } catch (error) {
      console.error("Error saving detail:", error);
      message.error(t('common.saveFailed'));
    }
  };

  const updateRoutingTotal = async (routingId: number) => {
    try {
      const { data, error } = await supabase
        .from("erp_routing_operation_details_s_539dcf81_b")
        .select("standard_hours")
        .eq("is_deleted", "n")
        .eq("routing_id", routingId);
      if (error) throw error;

      const totalHours =
        data?.reduce((sum, d) => sum + (d.standard_hours || 0), 0) || 0;

      await supabase
        .from(routingTable)
        .update({ total_standard_hours: totalHours })
        .eq("id", routingId);

      fetchRoutings();
    } catch (error) {
      console.error("Error updating routing total:", error);
    }
  };

  const handleEdit = async (record: Routing) => {
    setEditingRouting(record);
    const formValues = { ...record };
    if (formValues.effective_date) {
      formValues.effective_date = dayjs(formValues.effective_date);
    }
    if (formValues.expiry_date) {
      formValues.expiry_date = dayjs(formValues.expiry_date);
    }
    form.setFieldsValue(formValues);
    setSelectedRouting(record);
    await fetchDetails(record.id);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('mrp.routingOperations.deleteConfirm'),
      onOk: async () => {
        try {
          await logWithTiming(
            t("mrp.routingOperations.logDelete"),
            "DELETE",
            async () => {
              const { error } = await supabase
                .from(routingTable)
                .update({ is_deleted: "y" })
                .eq("id", id);
              if (error) throw error;
              const { error: detailError } = await supabase
                .from(routingDetailTable)
                .update({ is_deleted: "y" })
                .eq("routing_id", id);
              if (detailError) throw detailError;
            },
            { table: routingTable, recordId: id },
          );
          message.success(t('common.deleteSuccess'));
          fetchRoutings();
        } catch (error) {
          console.error("Error deleting routing:", error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingRouting(null);
    form.setFieldsValue({
      routing_no: "",
      product_id: undefined,
      version: "1.0",
      is_default: true,
      is_active: true,
      effective_date: dayjs(new Date()),
      expiry_date: "",
      total_standard_hours: 0,
      remark: "",
    });
    setDetails([]);
    setSelectedRouting(null);
    setIsModalOpen(true);
  };

  const handleAddDetail = (e: React.MouseEvent) => { e.stopPropagation();
    setEditingDetail(null);
    detailForm.setFieldsValue({
      sequence_no: details.length + 1,
      operation_id: undefined,
      next_operation_id: undefined,
      standard_hours: 0,
      setup_hours: 0,
      labor_rate: 0,
      overhead_rate: 0,
      is_inspection_required: false,
    });
    setIsDetailModalOpen(true);
  };

  const handleEditDetail = (record: RoutingDetail) => {
    setEditingDetail(record);
    detailForm.setFieldsValue(record);
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('mrp.routingOperations.operationDeleteConfirm'),
      onOk: async () => {
        try {
          await supabase
            .from("erp_routing_operation_details_s_539dcf81_b")
            .update({ is_deleted: "y" })
            .eq("id", id);
          message.success(t('common.deleteSuccess'));
          if (selectedRouting) {
            fetchDetails(selectedRouting.id);
            updateRoutingTotal(selectedRouting.id);
          }
        } catch (error) {
          console.error("Error deleting detail:", error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const getProductName = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.name || "-";
  };

  const getOperationName = (operationId: number | null) => {
    const operation = operations.find((op) => op.id === operationId);
    return operation?.name || "-";
  };

  const filteredRoutings = routings.filter(
    (r) =>
      r.routing_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getProductName(r.product_id)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
  );

  const columns = [
    {
      title: t('mrp.routingOperations.routingNo'),
      dataIndex: "routing_no",
      key: "routing_no",
    },
    {
      title: t('mrp.routingOperations.product'),
      dataIndex: "product_id",
      key: "product_id",
      render: (productId: number) => getProductName(productId),
    },
    {
      title: t('mrp.routingOperations.version'),
      dataIndex: "version",
      key: "version",
    },
    {
      title: t('mrp.routingOperations.standardHours'),
      dataIndex: "total_standard_hours",
      key: "total_standard_hours",
      render: (hours: number) => t('mrp.hoursAmount', { hours: hours }),
    },
    {
      title: t('mrp.routingOperations.defaultLabel'),
      dataIndex: "is_default",
      key: "is_default",
      render: (isDefault: boolean) => (isDefault ? t('common.yes') : t('common.no')),
    },
    {
      title: t('common.status'),
      dataIndex: "is_active",
      key: "is_active",
      render: (isActive: boolean) => (
        <Tag color={isActive ? "success" : "default"}>
          {isActive ? t('common.enabled') : t('mrp.inactive')}
        </Tag>
      ),
    },
    {
      title: t('common.actions'),
      key: "action",
      render: (_: any, record: Routing) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            {t('common.edit')}
          </Button>
          <Button
            type="text"
            icon={<AppstoreOutlined />}
            onClick={() => handleShowMap(record)}
          >
            {t('mrp.routingOperations.map')}
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDelete(record.id)}
          >
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const detailColumns = [
    {
      title: t('mrp.routingOperations.seqNo'),
      dataIndex: "sequence_no",
      key: "sequence_no",
    },
    {
      title: t('mrp.routingOperations.operationName'),
      dataIndex: "operation_id",
      key: "operation_id",
      render: (operationId: number) => getOperationName(operationId),
    },
    {
      title: t('mrp.routingOperations.standardHoursUnit'),
      dataIndex: "standard_hours",
      key: "standard_hours",
      render: (hours: number) => hours || 0,
    },
    {
      title: t('mrp.routingOperations.setupHoursUnit'),
      dataIndex: "setup_hours",
      key: "setup_hours",
      render: (hours: number) => hours || 0,
    },
    {
      title: t('mrp.routingOperations.laborRate'),
      dataIndex: "labor_rate",
      key: "labor_rate",
      render: (rate: number) => rate || 0,
    },
    {
      title: t('mrp.routingOperations.overheadRate'),
      dataIndex: "overhead_rate",
      key: "overhead_rate",
      render: (rate: number) => rate || 0,
    },
    {
      title: t('mrp.routingOperations.inspectionRequired'),
      dataIndex: "is_inspection_required",
      key: "is_inspection_required",
      render: (isRequired: boolean) => (isRequired ? t('common.yes') : t('common.no')),
    },
    {
      title: t('common.actions'),
      key: "action",
      render: (_: any, record: RoutingDetail) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEditDetail(record)}
          >
            {t('common.edit')}
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDeleteDetail(record.id)}
          >
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const detailTotal = details.reduce(
    (acc, d) => acc + (d.standard_hours || 0),
    0,
  );

  return (
    <div>
      <SuperTable
        columns={columns}
        dataSource={filteredRoutings}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="routing-operations"
        headerTitle={t('mrp.routingOperations.title')}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t('mrp.routingOperations.add')}
            </Button>
            <Input.Search
              allowClear
              placeholder={t('mrp.routingOperations.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchRoutings}
              style={{ width: 260 }}
            />
          </Space>
        }
      />

      <Modal
        title={t('mrp.routingOperations.mapTitle')}
        open={isMapModalOpen}
        onCancel={() => setIsMapModalOpen(false)}
        footer={null}
        width={850}
      >
        <RoutingMap
          details={details}
          operations={operations}
          routingNo={selectedRouting?.routing_no || ""}
        />
      </Modal>

      <SupaModal
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingRouting(null);
          setSelectedRouting(null);
        }}
        title={
          <>
            <ShoppingOutlined />
            <span>{editingRouting ? t('mrp.routingOperations.edit') : t('mrp.routingOperations.add')}</span>
          </>
        }
        headerExtra={
          <Space>
            <Button
              type="dashed"
              color="purple"
              size="small"
              icon={<CheckOutlined />}
            >
              {t('mrp.routingOperations.approve')}
            </Button>
            <Button
              type="dashed"
              color="purple"
              size="small"
              icon={<PrinterOutlined />}
            >
              {t('mrp.routingOperations.print')}
            </Button>
          </Space>
        }
        headerPanelTitle={t('mrp.routingOperations.headerPanelTitle')}
        detailPanelTitle={t('mrp.routingOperations.detailPanelTitle')}
        historyTable={routingTable}
        historyRecordId={editingRouting?.id || selectedRouting?.id}
        navigation={buildModalNav(filteredRoutings, editingRouting?.id || selectedRouting?.id, handleEdit)}
        detailItems={[
          {
            key: "attachments",
            label: t("attachments.title"),
            disabled: !(editingRouting?.id || selectedRouting?.id),
            children: (
              <BizAttachments
                bizType="routing_operation"
                bizId={editingRouting?.id || selectedRouting?.id}
              />
            ),
          },
        ]}
        detailExtra={
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            onClick={handleAddDetail}
          >
            {t('mrp.routingOperations.addOperation')}
          </Button>
        }
        form={form}
        formEle={
          <Form
            form={form}
            layout="vertical"
            onFinish={handleSubmit}
          >
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label={t('mrp.routingOperations.routingNo')}
                  name="routing_no"
                  rules={[{ required: true, message: t('mrp.routingOperations.routingNoPrompt') }]}
                >
                  <Input
                    placeholder={t('mrp.routingOperations.routingNoPrompt')}
                    disabled={!!editingRouting}
                  />
                </Form.Item>
                <Form.Item
                  label={t('mrp.routingOperations.product')}
                  name="product_id"
                  rules={[{ required: true, message: t('mrp.routingOperations.productPrompt') }]}
                >
                  <Select placeholder={t('mrp.routingOperations.productPrompt')} disabled={!!editingRouting}>
                    {products.map((p) => (
                      <Option key={p.id} value={p.id}>
                        {p.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item label={t('mrp.routingOperations.version')} name="version" initialValue="1.0">
                  <Input placeholder={t('mrp.routingOperations.versionPrompt')} />
                </Form.Item>
                <Form.Item
                  label={t('mrp.routingOperations.standardHoursUnit')}
                  name="total_standard_hours"
                  initialValue={0}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t('mrp.routingOperations.standardHoursPrompt')}
                  />
                </Form.Item>
                <Form.Item
                  label={t('mrp.routingOperations.setDefault')}
                  name="is_default"
                  valuePropName="checked"
                  initialValue={true}
                >
                  <Checkbox />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label={t('mrp.routingOperations.effectiveDate')} name="effective_date">
                  <DatePicker />
                </Form.Item>
                <Form.Item label={t('mrp.routingOperations.expiryDate')} name="expiry_date">
                  <DatePicker />
                </Form.Item>
                <Form.Item label={t('mrp.routingOperations.remark')} name="remark">
                  <Input.TextArea rows={5} placeholder={t('mrp.routingOperations.remarkPrompt')} />
                </Form.Item>
                <Form.Item
                  label={t('common.enabled')}
                  name="is_active"
                  valuePropName="checked"
                  initialValue={true}
                >
                  <Checkbox />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        }
        tableEle={
          <Table
            columns={detailColumns}
            dataSource={details}
            rowKey="id"
            pagination={false}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={3} align="right">
                  <strong>{t('mrp.routingOperations.total')}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="left">
                  <strong>{t('mrp.hoursAmount', { hours: detailTotal })}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2}></Table.Summary.Cell>
              </Table.Summary.Row>
            )}
          />
        }
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t('common.save')}
            </Button>
          </Space>
        }
        height={'80%'}
      />

      <SimpleModal
        title={editingDetail ? t('mrp.routingOperations.editOperationDetail') : t('mrp.routingOperations.addOperationDetail')}
        open={isDetailModalOpen}
        onCancel={() => {
          setIsDetailModalOpen(false);
          detailForm.resetFields();
          setEditingDetail(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsDetailModalOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => detailForm.submit()}>
              {t('common.save')}
            </Button>
          </Space>
        }
        width={600}
        height={400}
      >
        <Form
          form={detailForm}
          layout="vertical"
          onFinish={handleDetailSubmit}
          style={{ marginRight: 16 }}
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t('mrp.routingOperations.seqNo')}
                name="sequence_no"
                rules={[{ required: true, message: t('mrp.routingOperations.seqNoPrompt') }]}
              >
                <InputNumber
                  min={1}
                  style={{ width: "100%" }}
                  placeholder={t('mrp.routingOperations.seqNoPrompt')}
                />
              </Form.Item>
              <Form.Item
                label={t('mrp.routingOperations.operationName')}
                name="operation_id"
                rules={[{ required: true, message: t('mrp.routingOperations.operationPrompt') }]}
              >
                <Select placeholder={t('mrp.routingOperations.operationPrompt')}>
                  {operations.map((op) => (
                    <Option key={op.id} value={op.id}>
                      {op.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label={t('mrp.routingOperations.nextOperation')} name="next_operation_id">
                <Select placeholder={t('mrp.routingOperations.nextOperationPrompt')} allowClear>
                  {operations.map((op) => (
                    <Option key={op.id} value={op.id}>
                      {op.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item
                label={t('mrp.routingOperations.standardHoursUnit')}
                name="standard_hours"
                initialValue={0}
              >
                <InputNumber
                  min={0}
                  step={0.1}
                  style={{ width: "100%" }}
                  placeholder={t('mrp.routingOperations.standardHoursPrompt')}
                />
              </Form.Item>
              <Form.Item
                label={t('mrp.routingOperations.setupHoursUnit')}
                name="setup_hours"
                initialValue={0}
              >
                <InputNumber
                  min={0}
                  step={0.1}
                  style={{ width: "100%" }}
                  placeholder={t('mrp.routingOperations.setupHoursPrompt')}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('mrp.routingOperations.laborRate')} name="labor_rate" initialValue={0}>
                <InputNumber
                  min={0}
                  step={0.0001}
                  precision={4}
                  style={{ width: "100%" }}
                  placeholder={t('mrp.routingOperations.laborRatePrompt')}
                />
              </Form.Item>
              <Form.Item
                label={t('mrp.routingOperations.overheadRate')}
                name="overhead_rate"
                initialValue={0}
              >
                <InputNumber
                  min={0}
                  step={0.0001}
                  precision={4}
                  style={{ width: "100%" }}
                  placeholder={t('mrp.routingOperations.overheadRatePrompt')}
                />
              </Form.Item>
              <Form.Item
                label={t('mrp.routingOperations.inspectionRequiredField')}
                name="is_inspection_required"
                valuePropName="checked"
                initialValue={false}
              >
                <Checkbox />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </SimpleModal>
    </div>
  );
}
