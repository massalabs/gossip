# Gossip - Secure Messaging App

Gossip is a privacy-first, secure messaging application built with React, TypeScript, and Vite. It provides end-to-end encrypted communication with local data storage, ensuring your conversations remain private and secure.

## Features

- 🔐 **Privacy First**: All messages are encrypted and stored locally on your device
- 💬 **Secure Messaging**: End-to-end encryption for all communications
- 📱 **Progressive Web App**: Install as a native app on any device
- 🏠 **Local Storage**: Your data never leaves your device
- 👤 **User Profiles**: Create and manage your secure identity
- 🎨 **Modern UI**: Clean, responsive interface built with Tailwind CSS

## Tech Stack

- **Frontend**: React 19 + TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS
- **State Management**: Zustand
- **Database**: Dexie (IndexedDB wrapper)
- **PWA**: Vite PWA Plugin
- **Blockchain**: Massa Web3 SDK

## Getting Started

### Prerequisites

- Node.js (version specified in `.nvmrc`)
- npm or yarn

### Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd Gossip
```

2. Install dependencies:

```bash
npm install
```

3. Start the development server:

```bash
npm run dev
```

4. Open your browser and navigate to `http://localhost:5173`

### Building for Production

```bash
npm run build
```

The built files will be in the `dist` directory, ready for deployment.

## Project Structure

```
src/
├── components/          # React components
│   ├── ErrorBoundary.tsx
│   ├── DiscussionList.tsx
│   ├── OnboardingFlow.tsx
│   └── AccountCreation.tsx
├── stores/             # State management
│   └── accountStore.tsx
├── db.ts              # Database schema and operations
├── App.tsx            # Main application component
└── main.tsx           # Application entry point
```

## Database Schema

Gossip uses Dexie (IndexedDB) for local data storage with the following entities:

- **UserProfile**: User account information and blockchain credentials
- **Contacts**: Contact list with usernames and public keys
- **Messages**: Encrypted message storage with metadata
- **Conversations**: Chat thread management
- **Settings**: Application preferences

## Development

### Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run lint` - Run ESLint

### Code Style

This project uses ESLint with TypeScript support. The configuration can be found in `eslint.config.js`.

## iOS Native App Development

Gossip can be built as a native iOS app using Capacitor. This allows you to distribute the app through the App Store and provides native iOS features and performance.

### Prerequisites for iOS Development

- **Xcode**: Download from the Mac App Store (requires macOS)
- **iOS Simulator**: Included with Xcode
- **CocoaPods**: Install with `sudo gem install cocoapods`
- **Apple Developer Account**: Required for App Store distribution

### iOS Development Setup

1. **Install Capacitor CLI** (if not already installed):

```bash
npm install -g @capacitor/cli
```

2. **Add iOS Platform** (already done):

```bash
npm run cap:sync:ios
```

3. **Open Xcode Project**:

```bash
npm run cap:open:ios
```

### Development Workflow

#### Method 1: Live Development (Recommended)

1. Start the development server:

```bash
npm run dev
```

2. In a new terminal, sync changes to iOS:

```bash
npm run cap:sync:ios
```

3. Open iOS Simulator from Xcode (Cmd + Shift + 2) or run:

```bash
npm run cap:run:ios
```

#### Method 2: Production Build Testing

1. Build the web app:

```bash
npm run build
```

2. Sync to iOS:

```bash
npm run cap:sync:ios
```

3. Open in Xcode:

```bash
npm run cap:open:ios
```

4. Run on simulator or device from Xcode

### Capacitor Commands

| Command                 | Description                               |
| ----------------------- | ----------------------------------------- |
| `npm run cap:sync:ios`  | Build web assets and sync to iOS project  |
| `npm run cap:open:ios`  | Open iOS project in Xcode                 |
| `npm run cap:run:ios`   | Build, sync, and run on iOS simulator     |
| `npm run cap:build:ios` | Build web assets and sync to iOS          |
| `npm run cap:copy:ios`  | Copy web assets to iOS without rebuilding |

### iOS-Specific Configuration

The app is configured in `capacitor.config.ts` with iOS-specific settings:

- **App ID**: `net.massa.gossip`
- **App Name**: `Gossip`
- **Scheme**: `Gossip`
- **Background Color**: Black (`#000000`)
- **Content Inset**: Automatic
- **Scroll Enabled**: True

### Testing on iOS

#### Simulator Testing

1. Open Xcode project: `npm run cap:open:ios`
2. Select a simulator device from the dropdown
3. Click the play button (▶️) or press Cmd + R
4. The app will launch in the iOS Simulator

#### Device Testing

1. Connect an iOS device to your Mac
2. Trust the device when prompted
3. In Xcode, select your device from the dropdown
4. Click play to build and run on device

#### Debug Mode

- Use Safari's Web Inspector: Safari → Develop → [Your Device] → [App Name]
- Console logs and debugging work the same as web development

### App Store Preparation

#### Before Submission

1. **Update App Information**:
   - Open `ios/App/App/Info.plist`
   - Update app name, version, and bundle ID

2. **Generate App Icons**:
   - Icons are automatically generated from `assets/icon.svg`
   - Custom icons can be placed in `ios/App/App/Assets.xcassets/AppIcon.appiconset/`

3. **Configure Signing**:
   - In Xcode: Select target → Signing & Capabilities
   - Choose your development team
   - Enable required capabilities (if any)

4. **Build for App Store**:
   - In Xcode: Product → Archive
   - Upload to App Store Connect via Xcode Organizer

#### Common Issues & Solutions

**CocoaPods Issues**:

```bash
cd ios/App
pod install
```

**Build Errors**:

- Clean build folder: Cmd + Shift + K in Xcode
- Clean derived data: Xcode → Settings → Locations → Derived Data → Delete

**Simulator Not Launching**:

- Restart Xcode
- Reset simulator: Simulator → Device → Erase All Content and Settings

**Plugin Issues**:

- Re-sync plugins: `npm run cap:sync:ios`
- Update pods: `cd ios/App && pod update`

### Native Features

The app uses these Capacitor plugins:

- **@capacitor/status-bar**: Controls status bar appearance
- **@aparajita/capacitor-biometric-auth**: Biometric authentication support

### Performance Tips

- Test on actual devices for accurate performance metrics
- Monitor memory usage in Xcode Instruments
- Use Safari Web Inspector for performance profiling
- Consider using `CapacitorHttp` for native HTTP requests when needed

### Troubleshooting

**App not loading in simulator**:

1. Check that web server is running (`npm run dev`)
2. Re-sync: `npm run cap:sync:ios`
3. Clean and rebuild in Xcode

**Blank screen on device**:

1. Check device logs in Xcode console
2. Verify network permissions
3. Test with a simple HTML page to isolate issues

**Build failures**:

1. Update Xcode to latest version
2. Clear derived data
3. Reinstall pods: `cd ios/App && pod deintegrate && pod install`

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting
5. Submit a pull request

## Security

Gossip prioritizes user privacy and security:

- All data is stored locally on your device
- Messages are encrypted before storage
- No data is transmitted to external servers
- Built with modern security best practices

## Roadmap

- [ ] Real-time messaging implementation
- [ ] Contact discovery and management
- [ ] File sharing capabilities
- [ ] Voice and video calling
- [ ] Group messaging
- [ ] Message backup and restore
