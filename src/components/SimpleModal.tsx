import type { ModalProps } from "antd";
import { ConfigProvider, Modal } from "antd";

interface SimpleModalProps extends ModalProps {}

export function SimpleModal(props: SimpleModalProps) {
  return (
    <ConfigProvider variant="underlined">
      <Modal {...props} />
    </ConfigProvider>
  );
}

export default SimpleModal;
