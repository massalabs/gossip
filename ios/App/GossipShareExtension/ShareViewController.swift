//
//  ShareViewController.swift
//  GossipShareExtension
//
//  Created by Pierre Seznec on 15/12/2025.
//

import UIKit
import Social
import MobileCoreServices

class ShareViewController: SLComposeServiceViewController {

    override func isContentValid() -> Bool {
        // Always allow posting; we don't validate minimal length here
        return true
    }

    override func didSelectPost() {
        guard let extensionItem = extensionContext?.inputItems.first as? NSExtensionItem else {
            self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
            return
        }

        // Handle text/URL sharing
        if let itemProvider = extensionItem.attachments?.first {
            if itemProvider.hasItemConformingToTypeIdentifier(kUTTypeText as String) {
                itemProvider.loadItem(forTypeIdentifier: kUTTypeText as String, options: nil) { (item, error) in
                    if let error = error {
                        NSLog("GossipShareExtension: Failed to load shared text: \(error.localizedDescription)")
                    } else if let text = item as? String {
                        self.handleSharedText(text)
                    }
                    self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
                }
            } else if itemProvider.hasItemConformingToTypeIdentifier(kUTTypeURL as String) {
                itemProvider.loadItem(forTypeIdentifier: kUTTypeURL as String, options: nil) { (item, error) in
                    if let error = error {
                        NSLog("GossipShareExtension: Failed to load shared URL: \(error.localizedDescription)")
                    } else if let url = item as? URL {
                        self.handleSharedText(url.absoluteString)
                    }
                    self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
                }
            } else {
                self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
            }
        } else {
            self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
        }
    }

    private func handleSharedText(_ text: String) {
        // Optional: store shared text in App Group UserDefaults
        if let userDefaults = UserDefaults(suiteName: "group.net.massa.gossip") {
            userDefaults.set(text, forKey: "sharedText")
            userDefaults.synchronize()
        }

        // Open the main app with gossip:// URL scheme; JS layer handles gossip://share
        let encodedText = text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let gossipUrl = "gossip://share?text=\(encodedText)"

        guard let url = URL(string: gossipUrl) else { return }

        // Use NSExtensionContext to open the URL in the containing app
        self.extensionContext?.open(url, completionHandler: nil)
    }

    override func configurationItems() -> [Any]! {
        return []
    }
}
