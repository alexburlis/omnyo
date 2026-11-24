import { useCallback, useState } from "react";

const MODAL_HOST_SELECTOR = '[role="dialog"], [role="alertdialog"]';

export function usePickerModal(modal?: boolean): {
  modal: boolean;
  modalHostRef: (element: HTMLElement | null) => void;
} {
  const [insideDialog, setInsideDialog] = useState(false);

  const modalHostRef = useCallback((element: HTMLElement | null) => {
    if (element === null) return;
    setInsideDialog(element.closest(MODAL_HOST_SELECTOR) !== null);
  }, []);

  return { modal: modal ?? insideDialog, modalHostRef };
}
