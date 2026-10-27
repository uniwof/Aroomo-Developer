import { ConfirmTokenManager } from './confirm.js';
import {
  InboxActionNotFoundError,
  InboxConflictError,
  InboxNotFoundError,
  InMemoryInboxStore,
  type InboxStore,
} from './store.js';
import type { CreateInboxItemInput, InboxGroup, InboxItem } from './types.js';

export class InboxInvalidTokenError extends Error {
  constructor(message = 'Invalid or expired confirmation token') {
    super(message);
    this.name = 'InboxInvalidTokenError';
  }
}

export type ExecuteActionResult =
  | { needsConfirm: true; confirmToken: string }
  | { success: true; item: InboxItem };

export class InboxService {
  private store: InboxStore;
  private tokenManager: ConfirmTokenManager;

  constructor(store?: InboxStore, tokenManager?: ConfirmTokenManager) {
    this.store = store ?? new InMemoryInboxStore();
    this.tokenManager = tokenManager ?? new ConfirmTokenManager();
  }

  async createInboxItem(input: CreateInboxItemInput): Promise<InboxItem> {
    return this.store.create(input);
  }

  async getItem(id: string): Promise<InboxItem | null> {
    return this.store.findById(id);
  }

  async listItems(options?: { group?: InboxGroup }): Promise<InboxItem[]> {
    return this.store.list(options);
  }

  async getUnreadCount(): Promise<number> {
    return this.store.getUnreadCount();
  }

  async executeAction(
    id: string,
    actionId: string,
    confirmToken?: string,
  ): Promise<ExecuteActionResult> {
    const item = await this.store.findById(id);
    if (!item) {
      throw new InboxNotFoundError(`Inbox item with id ${id} not found`);
    }

    if (item.status !== 'open') {
      throw new InboxConflictError(`Inbox item ${id} is already ${item.status}`);
    }

    const action = item.actions.find((a) => a.id === actionId);
    if (!action) {
      throw new InboxActionNotFoundError(`Action ${actionId} not found on item ${id}`);
    }

    if (action.irreversible) {
      if (!confirmToken) {
        const token = this.tokenManager.issueToken(id, actionId);
        return { needsConfirm: true, confirmToken: token };
      }

      const valid = this.tokenManager.verifyAndConsumeToken(confirmToken, id, actionId);
      if (!valid) {
        throw new InboxInvalidTokenError('Invalid, expired, or replayed confirmToken');
      }
    }

    const updated = await this.store.executeAction(id, actionId);
    return { success: true, item: updated };
  }

  async dismissItem(id: string): Promise<InboxItem> {
    return this.store.dismiss(id);
  }

  async batchDismissItems(options?: { ids?: string[]; group?: InboxGroup }): Promise<number> {
    return this.store.batchDismiss(options);
  }
}

// 默认单例服务，供内部模块直接调用 createInboxItem
export const defaultInboxService = new InboxService();

export function createInboxItem(input: CreateInboxItemInput): Promise<InboxItem> {
  return defaultInboxService.createInboxItem(input);
}
