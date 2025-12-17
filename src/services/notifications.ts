/**
 * Notification Service
 *
 * Handles notifications for new messages.
 * - Uses native notifications via Capacitor LocalNotifications when running in a native shell.
 * - Falls back to browser / PWA notifications (service worker + Notification API) on web.
 * Shows generic notifications without revealing message content.
 * Supports user preference management for enabling/disabling notifications.
 */

import { Capacitor } from '@capacitor/core';
import {
  LocalNotifications,
  type PermissionStatus as LocalNotificationPermissionStatus,
} from '@capacitor/local-notifications';

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
  private nativePermissionInitialized = false;

  private constructor() {
    // Initialize permission state based on platform
    if (this.isNativePlatform()) {
      // Fire-and-forget async initialization for native platforms
      void this.initNativePermissionStatus();
    } else {
      this.updatePermissionStatus();
    }
    this.loadPreferences();
  }

  static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  /**
   * Detect if we are running inside a Capacitor native shell (iOS / Android).
   */
  private isNativePlatform(): boolean {
    return Capacitor.isNativePlatform();
  }

  /**
   * Initialize native notification permission status using LocalNotifications.
   * This is async and is best-effort; errors are logged and the default state is kept.
   */
  private async initNativePermissionStatus(): Promise<void> {
    if (!this.isNativePlatform() || this.nativePermissionInitialized) {
      return;
    }

    try {
      const status: LocalNotificationPermissionStatus =
        await LocalNotifications.checkPermissions();

      this.permission = {
        granted: status.display === 'granted',
        denied: status.display === 'denied',
        default:
          status.display === 'prompt' ||
          status.display === 'prompt-with-rationale',
      };

      this.nativePermissionInitialized = true;
    } catch (error) {
      console.error(
        'Failed to initialize native notification permission status:',
        error
      );
    }
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
  private async sendNotification(
    title: string,
    body: string,
    tag: string,
    autoCloseMs: number,
    onClick?: () => void,
    requireInteraction: boolean = false,
    data?: Record<string, unknown>
  ): Promise<void> {
    // On native platforms, prefer using Capacitor LocalNotifications.
    // Service workers are not available in native WebViews, so this path would be a no-op.
    if (this.isNativePlatform()) {
      await this.showNativeNotification(
        title,
        body,
        tag,
        autoCloseMs,
        onClick,
        data,
        requireInteraction
      );
      return;
    }

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
   * Show a native notification using Capacitor LocalNotifications.
   * Falls back to the browser Notification flow if anything fails.
   */
  private async showNativeNotification(
    title: string,
    body: string,
    tag: string,
    autoCloseMs: number,
    onClick: (() => void) | undefined,
    data?: Record<string, unknown>,
    requireInteraction: boolean = false
  ): Promise<void> {
    // Extra safety: only attempt on native platforms
    if (!this.isNativePlatform()) {
      return;
    }

    try {
      // Ensure we have permission for native notifications
      let status: LocalNotificationPermissionStatus =
        await LocalNotifications.checkPermissions();

      if (
        status.display === 'prompt' ||
        status.display === 'prompt-with-rationale'
      ) {
        status = await LocalNotifications.requestPermissions();
      }

      if (status.display !== 'granted') {
        // Permission not granted, do not attempt to show native notification
        return;
      }

      // Keep ID within Java int bounds (max 2,147,483,647)
      const id = Date.now() % 2147483647;

      await LocalNotifications.schedule({
        notifications: [
          {
            id,
            title,
            body,
            // Use extra to pass metadata for potential future handling
            extra: {
              ...data,
              tag,
              requireInteraction,
            },
            // schedule: {
            //   allowWhileIdle: true,
            // },
          },
        ],
      });
    } catch (error) {
      // If anything goes wrong, log and fall back to browser-based notification
      console.error(
        'Failed to show native notification, falling back to web notification:',
        error
      );

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
    // Native (Capacitor) path: use LocalNotifications permission model
    if (this.isNativePlatform()) {
      try {
        let status: LocalNotificationPermissionStatus =
          await LocalNotifications.checkPermissions();

        if (
          status.display === 'prompt' ||
          status.display === 'prompt-with-rationale'
        ) {
          status = await LocalNotifications.requestPermissions();
        }

        this.permission = {
          granted: status.display === 'granted',
          denied: status.display === 'denied',
          default:
            status.display === 'prompt' ||
            status.display === 'prompt-with-rationale',
        };

        return this.permission;
      } catch (error) {
        console.error(
          'Failed to request native notification permission:',
          error
        );
        return this.permission;
      }
    }

    // Web / PWA path: use browser Notification API
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

      await this.sendNotification(
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

      await this.sendNotification(
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
    // Support notifications on web (Notification API) and native (Capacitor)
    return this.isNativePlatform() || 'Notification' in window;
  }

  /**
   * Get current permission status
   * @returns Current permission status
   */
  getPermissionStatus(): NotificationPermission {
    if (this.isNativePlatform()) {
      // Kick off async sync with native permission state; return last known state.
      void this.initNativePermissionStatus();
    } else {
      this.updatePermissionStatus();
    }
    return { ...this.permission };
  }

  /**
   * Get full notification preferences
   * @returns Notification preferences including enabled state and permission
   */
  getPreferences(): NotificationPreferences {
    if (this.isNativePlatform()) {
      // Kick off async sync with native permission state; return last known state.
      void this.initNativePermissionStatus();
    } else {
      this.updatePermissionStatus();
    }
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
    // On native platforms, permission is tracked via LocalNotifications
    // and updated in requestPermission(). Avoid overwriting it here.
    if (this.isNativePlatform()) {
      return;
    }

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
