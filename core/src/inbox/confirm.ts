import crypto from 'node:crypto';

export interface ConfirmationTokenData {
  itemId: string;
  actionId: string;
  expiresAt: number;
}

export class ConfirmTokenManager {
  private tokens = new Map<string, ConfirmationTokenData>();
  private ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  issueToken(itemId: string, actionId: string): string {
    const token = crypto.randomUUID();
    const expiresAt = Date.now() + this.ttlMs;
    this.tokens.set(token, { itemId, actionId, expiresAt });
    return token;
  }

  verifyAndConsumeToken(token: string, itemId: string, actionId: string): boolean {
    const data = this.tokens.get(token);
    if (!data) {
      return false;
    }

    // 单次使用：无论校验成功与否或是否过期，消费后立即删除 token
    this.tokens.delete(token);

    if (Date.now() > data.expiresAt) {
      return false;
    }

    if (data.itemId !== itemId || data.actionId !== actionId) {
      return false;
    }

    return true;
  }
}
