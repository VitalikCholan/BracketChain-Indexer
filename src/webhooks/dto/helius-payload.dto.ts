// Helius webhook payload — kept loosely typed because the shape varies between
// "raw" and "enhanced" webhook configurations and Helius can change minor fields
// without notice. We pull what we need defensively in helius-parser.service.ts.

export interface HeliusTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  fromTokenAccount?: string;
  toTokenAccount?: string;
  mint?: string;
  tokenAmount?: number;
  rawTokenAmount?: {
    tokenAmount?: string;
    decimals?: number;
  };
}

export interface HeliusTransaction {
  signature?: string;
  slot?: number;
  timestamp?: number;
  type?: string;
  source?: string;
  description?: string;
  transactionError?: unknown;

  // Logs may live in any of these locations depending on webhook type.
  meta?: { logMessages?: string[] };
  logs?: string[];
  logMessages?: string[];

  tokenTransfers?: HeliusTokenTransfer[];
  // Anchor-decoded events when Helius can decode the IDL.
  events?: Record<string, unknown>;
}

export type HeliusWebhookBody = HeliusTransaction[];
