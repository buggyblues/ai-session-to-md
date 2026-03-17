# React 重构实施指南

## 📦 Phase 1: 项目初始化

### Step 1: 创建项目目录

```bash
cd /Users/ryanbzhou/Developer/vibe-coding/freedom/ai-session-to-md
mkdir -p frontend-react/src/{components/{Sidebar,SessionView,Layout,shared},hooks,utils,types,stores}
cd frontend-react
```

### Step 2: 初始化 npm 项目

```bash
npm init -y
```

### Step 3: 安装依赖

```bash
# 核心依赖
npm install react@^18.3.1 react-dom@^18.3.1 react-router-dom@^6.26.2

# 状态管理和数据获取
npm install zustand@^4.5.5 @tanstack/react-query@^5.56.2

# Markdown 和语法高亮
npm install react-markdown@^9.0.1 react-syntax-highlighter@^15.5.0

# UI 工具
npm install sonner@^1.5.0 clsx@^2.1.1

# 开发依赖
npm install -D vite@^5.4.6 @vitejs/plugin-react-swc@^3.7.0 typescript@^5.5.4
npm install -D @types/react@^18.3.5 @types/react-dom@^18.3.0 @types/react-syntax-highlighter@^15.5.13
npm install -D tailwindcss@^3.4.11 postcss@^8.4.47 autoprefixer@^10.4.20
npm install -D eslint@^8.57.1 @typescript-eslint/eslint-plugin@^7.18.0 @typescript-eslint/parser@^7.18.0
npm install -D eslint-plugin-react-hooks@^4.6.2 eslint-plugin-react-refresh@^0.4.12
```

### Step 4: 初始化 Tailwind

```bash
npx tailwindcss init -p
```

## 📁 项目结构

```
frontend-react/
├── public/
│   └── favicon.ico
├── src/
│   ├── components/
│   │   ├── Sidebar/
│   │   │   ├── Sidebar.tsx
│   │   │   ├── SessionList.tsx
│   │   │   ├── SessionItem.tsx
│   │   │   ├── AgentTabs.tsx
│   │   │   └── SearchBar.tsx
│   │   ├── SessionView/
│   │   │   ├── SessionView.tsx
│   │   │   ├── SessionHeader.tsx
│   │   │   ├── MessageList.tsx
│   │   │   ├── Message.tsx
│   │   │   ├── ToolCallList.tsx
│   │   │   └── ToolCall.tsx
│   │   ├── Layout/
│   │   │   ├── Layout.tsx
│   │   │   └── MobileMenu.tsx
│   │   └── shared/
│   │       ├── LoadingSpinner.tsx
│   │       ├── EmptyState.tsx
│   │       └── ErrorBoundary.tsx
│   ├── hooks/
│   │   ├── useSessions.ts
│   │   ├── useSession.ts
│   │   ├── useSearch.ts
│   │   ├── useExport.ts
│   │   └── useResponsive.ts
│   ├── stores/
│   │   └── sessionStore.ts
│   ├── utils/
│   │   ├── api.ts
│   │   ├── formatters.ts
│   │   ├── constants.ts
│   │   └── cn.ts
│   ├── types/
│   │   └── session.ts
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── index.html
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
└── .eslintrc.cjs
```

## 📝 配置文件内容

详见下方各文件的完整代码...
