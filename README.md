# Kaizen AI - Autonomous Multi-Agent Developer & Generative UI Environment

Kaizen AI is a stateful, multi-agent developer environment powered by **LangGraph**, **LangChain**, **Groq**, **Web-Tree-Sitter**, and **Express/VS Code Webview Provider**.

## Key Features

### User-Facing
- **Smart Query Routing**: Automatic fast-path for general knowledge questions ("who is roger federer?", "hello") without scanning code files.
- **Language-Aware Code Generation**: Generates clean HTML, CSS, JavaScript, Python, C++, and TypeScript matching file extensions without boilerplate.
- **Enter Key Submission**: Submit prompts with `Enter` (`Shift+Enter` for newlines).
- **Resizable Textarea**: Vertically drag prompt area from 48px up to 250px.
- **Clipboard Screenshot Paste**: Paste screenshots directly (`Ctrl+V`) with Base64 preview thumbnails & size validation (<10MB).
- **Collapsible Agent Thought Process**: Toggle internal agent timeline with inline progress status tickers.
- **Prompt History**: Navigate past prompts with `Up` and `Down` arrow keys.
- **Toast Notifications**: Non-intrusive feedback toasts for image attachments, routing, and submission status.

### Developer-Facing & Performance
- **TypeScript Strict Mode**: Zero compilation errors across workspace (`npx tsc --noEmit`).
- **Comprehensive Verification Suite**: Automated verification runner (`@test comprehensive` or `/api/test/comprehensive`).
- **Memory & V8 Optimization**: Low application heap footprint (<10 MB).

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Enter` | Submit prompt |
| `Shift + Enter` | Insert newline |
| `Up` / `Down` | Navigate prompt history |
| `Ctrl + /` | Toggle shortcuts modal |
| `Esc` | Close modals / Collapse timeline |
| `Ctrl + V` | Paste screenshot from clipboard |

## Quick Start

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Start local server (http://localhost:3000)
npm run server
```
