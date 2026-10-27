export type InboxGroup = 'decision' | 'candidate' | 'brief';

export type InboxUrgency = 'urgent' | 'normal' | 'low';

export type InboxStatus = 'open' | 'done' | 'dismissed' | 'expired';

export interface InboxRelated {
  type: string;
  id: string;
}

export interface InboxAction {
  id: string;
  label: string;
  irreversible?: boolean;
}

export interface InboxItem {
  id: string;
  group: InboxGroup;
  kind: string;
  urgency: InboxUrgency;
  title: string;
  summary: string;
  related?: InboxRelated;
  actions: InboxAction[];
  status: InboxStatus;
  createdAt: string;
  resolvedAt?: string;
  resolvedAction?: string;
}

export interface CreateInboxItemInput {
  id?: string;
  group: InboxGroup;
  kind: string;
  urgency?: InboxUrgency;
  title: string;
  summary: string;
  related?: InboxRelated;
  actions?: InboxAction[];
}
