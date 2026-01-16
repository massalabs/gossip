/**
 * Service Instances
 *
 * Creates and exports service instances for use throughout the app.
 * Services are instantiated with their required dependencies.
 */

import {
  MessageService,
  AnnouncementService,
  DiscussionService,
  RefreshService,
  AuthService,
  db,
  createMessageProtocol,
} from 'gossip-sdk';

// Create message protocol instance
const messageProtocol = createMessageProtocol();

// Create service instances with dependencies
export const authService = new AuthService(db, messageProtocol);
export const announcementService = new AnnouncementService(db, messageProtocol);
export const messageService = new MessageService(db, messageProtocol);
export const discussionService = new DiscussionService(db, announcementService);
export const refreshService = new RefreshService(db, messageService);

// Re-export classes for direct instantiation if needed
export {
  MessageService,
  AnnouncementService,
  DiscussionService,
  RefreshService,
  AuthService,
};
