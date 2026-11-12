"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { ShieldQuestion } from "lucide-react";
import { Toaster } from "sonner";

const ConfirmContext = createContext<(message: string) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmContext);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const confirm = useCallback((text: string) => {
    if (resolver.current) return Promise.resolve(false);
    trigger.current = document.activeElement as HTMLElement | null;
    setMessage(text);
    return new Promise<boolean>(resolve => { resolver.current = resolve; });
  }, []);
  const finish = (answer: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setMessage(null);
    resolve?.(answer);
  };
  useEffect(() => () => { resolver.current?.(false); }, []);
  return <ConfirmContext.Provider value={confirm}>
    {children}
    <Toaster position="top-right" closeButton richColors toastOptions={{ className: "app-notification" }} />
    <AlertDialog.Root open={message !== null} onOpenChange={open => { if (!open) finish(false); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay" />
        <AlertDialog.Content className="confirm-dialog" onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}>
          <ShieldQuestion className="dialog-icon" size={28} aria-hidden="true" />
          <AlertDialog.Title>Confirm action</AlertDialog.Title>
          <AlertDialog.Description>{message}</AlertDialog.Description>
          <div className="dialog-actions">
            <AlertDialog.Cancel asChild><button type="button" onClick={() => finish(false)}>Cancel</button></AlertDialog.Cancel>
            <AlertDialog.Action asChild><button type="button" className="primary" onClick={() => finish(true)}>Confirm</button></AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  </ConfirmContext.Provider>;
}
