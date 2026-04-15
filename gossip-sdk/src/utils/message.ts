import { MessageType } from '../db/db.js';

/*Message that add a new post in the discussion */
export const POST_MESSAGE_TYPES = [
  MessageType.TEXT,
  MessageType.IMAGE,
  MessageType.FILE,
  MessageType.AUDIO,
  MessageType.VIDEO,
];
