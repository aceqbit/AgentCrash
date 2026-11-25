export interface ToolInfo {
  idempotent: boolean;
  /** Probe tool the gateway may use to reconcile an uncertain call. */
  probeTool?: string;
}

/** Authoritative tool registry: the gateway never trusts a caller's claim about idempotency. */
export const TOOLS: Record<string, ToolInfo> = {
  transfer: { idempotent: true },
  create_ticket: { idempotent: true },
  get_balance: { idempotent: true },
  list_sent_emails: { idempotent: true },
  send_email: { idempotent: false, probeTool: "list_sent_emails" },
};