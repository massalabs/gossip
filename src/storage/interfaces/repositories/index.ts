/**
 * Repository interfaces - contracts for data access
 */

export type { IRepository, IBulkRepository } from './IRepository';
export type { IContactRepository } from './IContactRepository';
export type { IMessageRepository } from './IMessageRepository';
export type { IDiscussionRepository } from './IDiscussionRepository';
export type { IUserProfileRepository } from './IUserProfileRepository';
export type {
  IPendingMessageRepository,
  IPendingAnnouncementRepository,
  IActiveSeekerRepository,
} from './IPendingRepository';
