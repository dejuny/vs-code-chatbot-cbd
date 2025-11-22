# VS Code Extension + Backend Integration Guide

AI-powered, workspace-aware VS Code extension plus an Express backend powered by Gemini 2.5 Flash.

## What’s Inside
- `frontend/ai-chatbot-extension/`: VS Code extension (webview UI in `resources/webviewClient.js`, TypeScript compiled to `out/`).
- `backend/`: Node/Express API that receives workspace files and prompts, builds directory trees, and calls Gemini for answers.

## 🚀 Quick Start

### Option A: use the hosted backend (default)
1. Install extension deps: `cd frontend/ai-chatbot-extension && npm install && npm run compile`.
2. Open the folder in VS Code and press `F5` to launch an Extension Development Host (or run `code --extensionDevelopmentPath <path-to-ai-chatbot-extension>`).
3. Open the **AI Assistant** view in the Activity Bar or run `AI Chatbot: Open AI Chat` from the command palette. The extension sends requests to the hosted backend at `https://4xwuxxqbqj.execute-api.us-east-1.amazonaws.com/` by default.

### Option B: run the backend locally
1. `cd backend && npm install` (Node 18+).
2. `cp .env.example .env` and set `GEMINI_API_KEY=your_key`.
3. `npm start` (listens on `http://localhost:3001`).
4. In VS Code settings, set `ai-chatbot.backendUrl` to `http://localhost:3001` (or add to `settings.json`).

## 🔧 Extension Configuration
- `ai-chatbot.backendUrl`: Backend API base URL. Default is the hosted API Gateway endpoint (`https://4xwuxxqbqj.execute-api.us-east-1.amazonaws.com/`); change to `http://localhost:3001` for local dev.
- `ai-chatbot.apiKey`, `ai-chatbot.model`, `ai-chatbot.enableRepositoryAnalysis`: Present in `package.json` for future use; current flows rely on the backend for AI calls.
- Chat history is persisted in VS Code global state and reloaded when the panel opens.

## 💬 Using the AI Chatbot
- Open via Activity Bar (**AI Assistant**) or command palette (`AI Chatbot: Open AI Chat` or `Open AI Chat in Editor`).
- Select text and run **Open AI Chat in Editor** to prefill the prompt with the selection.
- Click file references like `[src/app.ts:12]` in responses to jump to the file/line.

## 📤 How It Works
1. The webview asks for workspace context (up to 50 files) and reads file contents with `vscode.workspace.fs.readFile`, skipping `node_modules`.
2. Files must be text-like and <= 50 KB. Supported extensions include code/config/docs/web assets (see list below).
3. The extension posts `{ files, prompt }` to the backend `/upload`.
4. The backend builds a directory tree + previews, calls Gemini (`gemini-2.5-flash`) when `GEMINI_API_KEY` is set, and returns AI text with citations.
5. The webview renders the response with clickable file links and stores chat history.

## 📁 File Support
- Code: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.java`, `.cpp`, `.c`, `.h`, `.hpp`, `.cs`, `.php`, `.rb`, `.go`, `.rs`, `.swift`, `.kt`, `.scala`
- Web/Docs/Config: `.json`, `.yaml`, `.yml`, `.md`, `.txt`, `.html`, `.css`, `.scss`, `.vue`, `.svelte`, `.astro`, `.config`, `.env`, `.xml`
- Other text: `.gitignore`, `.dockerfile`, `.dockerignore`, files without extensions

## 🧪 Testing

### Backend (Jest)
- Prereq: Node 18+, `GEMINI_API_KEY` for live Gemini tests.
- Install: `cd backend && npm install`.
- Unit tests: `npm test`
- API integration (requires `npm start` in another terminal): `npm run test:integration`
- Gemini integration (requires API key): `npm run test:llm-integration`
- All tests: `npm run test:all`

### Extension (Mocha + ts-node)
- Prereq: `cd frontend/ai-chatbot-extension && npm install`.
- Stubbed backend integration: `npx mocha tests/frontend-backend.integration.spec.ts --config .mocharc.json`
- Cloud integration against deployed backend: `BACKEND_URL=https://4xwuxxqbqj.execute-api.us-east-1.amazonaws.com npx mocha tests/cloud-remote.integration.spec.ts --config .mocharc.json` (or `npm run test:integration:cloud`).
- Unit-style helpers: `npx mocha tests/fileHelper.spec.ts --config .mocharc.json`

## 🌐 Cloud vs. Local
- Default: extension points at the deployed API Gateway URL (no local server needed).
- Local dev: run the backend yourself and set `ai-chatbot.backendUrl` to `http://localhost:3001`.

## 🔍 Debugging
- Extension logs: VS Code Developer Tools console (messages prefixed `[AI Chatbot]`).
- Backend logs: terminal running `npm start` (shows request metadata and Gemini status).
- Health check: `curl http://localhost:3001/health`

## ☁️ Deployment Notes
- The deployed backend URL above is already wired into the extension defaults.
- GitHub Actions:
  - `.github/workflows/run-integration-tests.yml` runs stub + cloud Mocha suites on push/PR.
  - `.github/workflows/deploy-extension.yml` builds and publishes the extension to the Marketplace (requires `VSCE_PAT` secret).
- To publish manually: `cd frontend/ai-chatbot-extension && npm install && npm run compile && npx vsce package --out dist/ai-chatbot-extension.vsix && VSCE_PAT=... npx vsce publish --pat "$VSCE_PAT"`.

## 📞 Support Checklist
- Backend returns errors about Gemini: ensure `GEMINI_API_KEY` is set or use the hosted backend.
- Empty responses / missing files: verify the workspace has text files under 50 KB and that `node_modules` is not the only content.
- Navigation failures: make sure the file paths in responses exist in the current workspace.
