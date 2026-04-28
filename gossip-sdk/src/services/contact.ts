/**
 * Contact Service
 *
 * Wraps standalone contact utility functions with session context.
 * Created during openSession().
 */

import type { Contact } from '../db/index.js';
import type { UserPublicKeys } from '../wasm/bindings.js';
import type { SessionModule } from '../wasm/session.js';
import type { AuthService } from './auth.js';
import {
  addContact,
  updateContactName,
  deleteContact,
  type AddContactResult,
  type UpdateContactNameResult,
  type DeleteContactResult,
} from '../utils/contacts.js';
import { Queries } from '../db/queries/index.js';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter.js';

export class ContactService {
  private session: SessionModule;
  private queries: Queries;
  private authService: AuthService;
  private eventEmitter: SdkEventEmitter;

  constructor(
    session: SessionModule,
    queries: Queries,
    authService: AuthService,
    eventEmitter: SdkEventEmitter
  ) {
    this.session = session;
    this.queries = queries;
    this.authService = authService;
    this.eventEmitter = eventEmitter;
  }

  private get owner(): string {
    return this.session.userIdEncoded;
  }

  async list(): Promise<Contact[]> {
    return this.queries.contacts.getByOwner(this.owner);
  }

  async get(contactUserId: string): Promise<Contact | null> {
    return (
      (await this.queries.contacts.getByOwnerAndUser(
        this.owner,
        contactUserId
      )) ?? null
    );
  }

  async add(
    userId: string,
    name: string,
    publicKeys?: UserPublicKeys
  ): Promise<AddContactResult> {
    const pubKeys =
      publicKeys ?? (await this.authService.fetchPublicKeyByUserId(userId));
    return addContact(this.owner, userId, name, pubKeys, this.queries);
  }

  async updateName(
    contactUserId: string,
    newName: string
  ): Promise<UpdateContactNameResult> {
    return updateContactName(this.owner, contactUserId, newName, this.queries);
  }

  async delete(contactUserId: string): Promise<DeleteContactResult> {
    const result = await deleteContact(
      this.owner,
      contactUserId,
      this.session,
      this.queries
    );
    if (result.success) {
      this.eventEmitter.emit(SdkEventType.CONTACT_DELETED, { contactUserId });
    }
    return result;
  }
}
