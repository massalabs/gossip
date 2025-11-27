/**
 * Notification Service
 *
 * Handles browser notifications for new messages.
 * Shows generic notifications without revealing message content.
 * Supports user preference management for enabling/disabling notifications.
 */

const NOTIFICATION_ENABLED_KEY = 'gossip-notifications-enabled';

export interface NotificationPermission {
  granted: boolean;
  denied: boolean;
  default: boolean;
}

export interface NotificationPreferences {
  enabled: boolean;
  permission: NotificationPermission;
}

export class NotificationService {
  private static instance: NotificationService;
  private permission: NotificationPermission = {
    granted: false,
    denied: false,
    default: true,
  };
  private enabled: boolean = true;

  private constructor() {
    this.updatePermissionStatus();
    this.loadPreferences();
  }

  static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  /**
   * Load notification preferences from localStorage
   */
  private loadPreferences(): void {
    try {
      const stored = localStorage.getItem(NOTIFICATION_ENABLED_KEY);
      if (stored !== null) {
        this.enabled = stored === 'true';
      }
    } catch {
      // localStorage not available, use default
      this.enabled = true;
    }
  }

  /**
   * Save notification preferences to localStorage
   */
  private savePreferences(): void {
    try {
      localStorage.setItem(NOTIFICATION_ENABLED_KEY, String(this.enabled));
    } catch {
      // localStorage not available, ignore
    }
  }

  /**
   * Check if notifications are allowed (permission granted AND user enabled)
   */
  private canShowNotification(): boolean {
    return this.permission.granted && this.enabled;
  }

  /**
   * Request notification permission from the user
   * @returns Promise resolving to permission status
   */
  async requestPermission(): Promise<NotificationPermission> {
    if (!('Notification' in window)) {
      console.warn('This browser does not support notifications');
      return this.permission;
    }

    try {
      await Notification.requestPermission();
      this.updatePermissionStatus();
      return this.permission;
    } catch (error) {
      console.error('Failed to request notification permission:', error);
      return this.permission;
    }
  }

  /**
   * Show a generic notification for new messages
   * @param messageCount - Number of new messages (optional)
   */
  async showNewMessagesNotification(messageCount?: number): Promise<void> {
    if (!this.canShowNotification()) {
      return;
    }

    try {
      const title = 'Gossip Messenger';
      const body = messageCount
        ? `You have ${messageCount} new message${messageCount > 1 ? 's' : ''}`
        : 'You have new messages';

      const notification = new Notification(title, {
        body,
        icon: '/favicon/favicon-96x96.png',
        badge: '/favicon/favicon-96x96.png',
        tag: 'gossip-new-messages',
        requireInteraction: false,
        silent: false,
      });

      // Handle notification click
      notification.onclick = () => {
        window.focus();
        notification.close();
      };

      // Auto-close after 5 seconds
      setTimeout(() => {
        notification.close();
      }, 5000);
    } catch (error) {
      console.error('Failed to show notification:', error);
    }
  }

  /**
   * Show a notification for a specific discussion (when app is open)
   * @param contactName - Name of the contact
   * @param messagePreview - Preview of the message (optional)
   * @param contactUserId - User ID of the contact (optional, for navigation)
   */
  async showDiscussionNotification(
    contactName: string,
    messagePreview?: string,
    contactUserId?: string
  ): Promise<void> {
    if (!this.canShowNotification()) {
      return;
    }

    try {
      const title = `New message from ${contactName}`;
      const body = messagePreview || 'Tap to view';

      const notification = new Notification(title, {
        body,
        icon: '/favicon/favicon-96x96.png',
        badge: '/favicon/favicon-96x96.png',
        tag: `gossip-discussion-${contactName}`,
        requireInteraction: false,
        silent: false,
        data: contactUserId
          ? { contactUserId, url: `/discussion/${contactUserId}` }
          : undefined,
      });

      // Handle notification click
      notification.onclick = () => {
        window.focus();
        // Navigate to discussion if contactUserId is available
        if (contactUserId) {
          window.location.href = `/discussion/${contactUserId}`;
        }
        notification.close();
      };

      // Auto-close after 3 seconds
      setTimeout(() => {
        notification.close();
      }, 3000);
    } catch (error) {
      console.error('Failed to show discussion notification:', error);
    }
  }

  /**
   * Show a notification for a new discussion
   * @param contactName - Name of the contact who started the discussion
   */
  async showNewDiscussionNotification(contactName: string): Promise<void> {
    if (!this.canShowNotification()) {
      return;
    }

    try {
      const title = 'New Discussion';
      const body = `${contactName} wants to start a conversation`;

      const notification = new Notification(title, {
        body,
        icon: '/favicon/favicon-96x96.png',
        badge: '/favicon/favicon-96x96.png',
        tag: `gossip-new-discussion-${contactName}`,
        requireInteraction: true,
        silent: false,
        data: { url: '/discussions' },
      });

      // Handle notification click
      notification.onclick = () => {
        window.focus();
        window.location.href = '/discussions';
        notification.close();
      };

      // Auto-close after 10 seconds (longer for new discussions)
      setTimeout(() => {
        notification.close();
      }, 10000);
    } catch (error) {
      console.error('Failed to show new discussion notification:', error);
    }
  }

  /**
   * Check if notifications are supported
   * @returns True if notifications are supported
   */
  isSupported(): boolean {
    return 'Notification' in window;
  }

  /**
   * Get current permission status
   * @returns Current permission status
   */
  getPermissionStatus(): NotificationPermission {
    this.updatePermissionStatus();
    return { ...this.permission };
  }

  /**
   * Get full notification preferences
   * @returns Notification preferences including enabled state and permission
   */
  getPreferences(): NotificationPreferences {
    this.updatePermissionStatus();
    return {
      enabled: this.enabled,
      permission: { ...this.permission },
    };
  }

  /**
   * Check if notifications are enabled by the user
   * @returns True if user has enabled notifications
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Enable or disable notifications
   * @param enabled - Whether to enable notifications
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.savePreferences();
  }

  /**
   * Toggle notification enabled state
   * @returns The new enabled state
   */
  toggleEnabled(): boolean {
    this.enabled = !this.enabled;
    this.savePreferences();
    return this.enabled;
  }

  /**
   * Update internal permission status based on browser state
   */
  private updatePermissionStatus(): void {
    if (!('Notification' in window)) {
      this.permission = {
        granted: false,
        denied: true,
        default: false,
      };
      return;
    }

    switch (Notification.permission) {
      case 'granted':
        this.permission = {
          granted: true,
          denied: false,
          default: false,
        };
        break;
      case 'denied':
        this.permission = {
          granted: false,
          denied: true,
          default: false,
        };
        break;
      default:
        this.permission = {
          granted: false,
          denied: false,
          default: true,
        };
        break;
    }
  }

  /**
   * Clear all notifications with Echo tags
   */
  async clearAllNotifications(): Promise<void> {
    if ('serviceWorker' in navigator) {
      try {
        const registration = await navigator.serviceWorker.ready;
        const notifications = await registration.getNotifications();
        notifications.forEach(notification => {
          notification.close();
        });
      } catch (error) {
        console.error('Failed to clear notifications:', error);
      }
    }
  }
}

// Export singleton instance
export const notificationService = NotificationService.getInstance();
