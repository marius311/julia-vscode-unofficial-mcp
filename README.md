# Julia VSCode MCP (unofficial)

Companion extension for [Julia for VS Code](https://marketplace.visualstudio.com/items?itemName=julialang.language-julia) that exposes Julia REPL tools to AI coding agents via [MCP](https://modelcontextprotocol.io/) (Model Context Protocol).

This lets the Claude Code extension, Codex extension, non-VSCode CLI agents, any and other MCP-compatible tools use the integrated Julia REPL in VS Code.

This extension is likely to be superceded by something more official in the Julia extension and/or VSCode and/or Claude/Codex in the future, but its not clear when or how, so for now enjoy this.

## Important notes

As of Apr 12, 2026, you need to be on the pre-release version of Julia for VS Code, which includes the necessary tool endpoints.

If you're using Copilot Chat, you don't need this extension at all, that already works on that pre-release version. This is only for other agents/harnesses.

Currently, Julia for VS Code does _not_ report stdout/stderr from the REPL back to the agent, so the agent will only see the return value. 

## Setup

Install the extension, then run once in a terminal:

**Claude Code:**
```bash
claude mcp add -s user julia-vscode-unofficial-mcp -- ~/.julia-vscode/mcp-bridge.js
```

**Codex:**
```bash
codex mcp add julia-vscode-unofficial-mcp -- ~/.julia-vscode/mcp-bridge.js
```

These commands can also be shown in VSCode by running "Julia MCP: Show Setup Command"

## Usage

The agent should automatically use the REPL when appropriate, nothing else is needed. If it's not doing so, run `/mcp` or ask it to list its tools and ensure Julia is present there. 

The working directory of the agent needs to be the same as the VSCode workspace directory for the agent to find the right window to send commands to. This happens automatically for Claude/Codex VSCode extensions in that window; if you're running from `claude`/`codex` CLI, launch them from the appropriate folder. 

## How it works

The extension reads tool definitions from the official Julia extension's `package.json` and exposes them via an HTTP MCP server on localhost. A stdio bridge script (`~/.julia-vscode/mcp-bridge.js`) translates between the MCP stdio protocol used by Claude/Codex and the HTTP server. Lock files keyed by workspace path handle multiple VS Code windows.