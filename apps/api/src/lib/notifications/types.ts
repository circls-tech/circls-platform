export interface ProviderSendInput {
  recipient: string;
  templateKey: string;
  payload: Record<string, unknown>;
}

export interface ProviderSendResult {
  providerMessageId?: string | undefined;
}
