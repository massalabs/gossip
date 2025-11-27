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
   * Check if service worker is available and ready
   * @returns Promise resolving to service worker controller if available
   */
  private async getServiceWorkerController(): Promise<ServiceWorker | null> {
    if (!('serviceWorker' in navigator)) {
      return null;
    }

    try {
      // Wait for service worker to be ready
      await navigator.serviceWorker.ready;
      return navigator.serviceWorker.controller;
    } catch {
      return null;
    }
  }

  /**
   * Send notification via service worker if available, otherwise show directly
   * @param title - Notification title
   * @param body - Notification body
   * @param tag - Notification tag for grouping
   * @param autoCloseMs - Auto-close timeout in milliseconds
   * @param onClick - Optional click handler (only used in fallback mode)
   * @param requireInteraction - Whether notification requires user interaction
   * @param data - Additional notification data (must include url for navigation)
   */
  private async sendNotificationViaServiceWorker(
    title: string,
    body: string,
    tag: string,
    autoCloseMs: number,
    onClick?: () => void,
    requireInteraction: boolean = false,
    data?: Record<string, unknown>
  ): Promise<void> {
    const controller = await this.getServiceWorkerController();

    if (controller) {
      // Send notification request to service worker
      // Service worker handles navigation via data.url in notificationclick event
      controller.postMessage({
        type: 'SEND_NOTIFICATION',
        payload: {
          title,
          body,
          tag,
          requireInteraction,
          autoCloseMs,
          data: {
            ...data,
            url: (data?.url as string) || '/discussions',
          },
        },
      });
    } else {
      // Fallback to direct notification if service worker not available
      await this.showNotificationInternal(
        title,
        body,
        tag,
        autoCloseMs,
        onClick,
        requireInteraction
      );
    }
  }

  /**
   * Internal helper to show a notification with common logic
   * @param title - Notification title
   * @param body - Notification body
   * @param tag - Notification tag for grouping
   * @param autoCloseMs - Auto-close timeout in milliseconds
   * @param onClick - Optional click handler
   * @param requireInteraction - Whether notification requires user interaction (default: false)
   */
  private async showNotificationInternal(
    title: string,
    body: string,
    tag: string,
    autoCloseMs: number,
    onClick?: () => void,
    requireInteraction: boolean = false
  ): Promise<void> {
    const notification = new Notification(title, {
      body,
      icon: '/favicon/favicon-96x96.png',
      badge: '/favicon/favicon-96x96.png',
      tag,
      requireInteraction,
      silent: false,
    });

    // Handle notification click
    notification.onclick = () => {
      window.focus();
      if (onClick) {
        onClick();
      }
      notification.close();
    };

    // Auto-close after specified time
    setTimeout(() => {
      notification.close();
    }, autoCloseMs);
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

      await this.sendNotificationViaServiceWorker(
        title,
        body,
        `gossip-discussion-${contactName}`,
        3000,
        contactUserId
          ? () => {
              window.location.href = `/discussion/${contactUserId}`;
            }
          : undefined,
        false,
        {
          type: 'discussion',
          url: contactUserId ? `/discussion/${contactUserId}` : '/discussions',
          contactUserId,
        }
      );
    } catch (error) {
      console.error('Failed to show discussion notification:', error);
    }
  }

  /**
   * Show a notification for a new discussion
   * @param announcementMessage - Optional message about the new discussion
   */
  async showNewDiscussionNotification(
    announcementMessage?: string
  ): Promise<void> {
    if (!this.canShowNotification()) {
      return;
    }

    try {
      const title = 'New contact request';
      const body = announcementMessage || 'User wants to start a conversation';

      await this.sendNotificationViaServiceWorker(
        title,
        body,
        'gossip-new-contact-request',
        10000,
        () => {
          window.location.href = '/discussions';
        },
        true, // requireInteraction for new discussions
        {
          type: 'new-contact-request',
          url: '/discussions',
        }
      );
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
   * Clear all notifications with Gossip tags
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
