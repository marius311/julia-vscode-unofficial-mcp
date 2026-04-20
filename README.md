# Julia VSCode MCP (unofficial)

Companion extension for [Julia for VS Code](https://marketplace.visualstudio.com/items?itemName=julialang.language-julia) that exposes Julia REPL tools to AI coding agents via [MCP](https://modelcontextprotocol.io/) (Model Context Protocol).

This lets the Claude Code extension, Codex extension, non-VSCode CLI agents, any and other MCP-compatible tools use the integrated Julia REPL in VS Code.

This extension is likely to be superceded by something more official in the Julia extension and/or VSCode and/or Claude/Codex in the future, but its not clear when or how, so for now enjoy this.

## Important notes

You need Julia for VS Code version 1.209.2 or later, which includes the necessary tool endpoints.

Currently, Julia for VS Code does _not_ report stdout/stderr from the REPL back to the agent, so the agent will only see the return value. 

This may not currently work reliably with the Codex VS Code extension due to upstream MCP issues; see [openai/codex#6465](https://github.com/openai/codex/issues/6465) and [openai/codex#15508](https://github.com/openai/codex/issues/15508). It works fine with the Codex CLI. 

This extension runs an HTTP server on a random localhost port to listen for requests. Session authentication is handled by lock files in `~/.julia-vscode/mcp-*.lock` which are only readable by your user, but an attacker who had gained only read access to those files could escalate to code execution in the REPL via this MCP.

## Setup

Install the extension, then run the one-time command for your platform and agent from below in a terminal. 

These commands can also be shown in VSCode by running "Julia MCP: Show Setup Command" — the platform-appropriate path is copied automatically.

### macOS / Linux

- **Claude Code:**
  ```bash
  claude mcp add -s user julia-vscode-unofficial-mcp -- ~/.julia-vscode/mcp-bridge.js
  ```
- **Codex:**
  ```bash
  codex mcp add julia-vscode-unofficial-mcp -- ~/.julia-vscode/mcp-bridge.js
  ```

### Windows

(Windows is untested, feedback welcome!)

- **Claude Code:**
  ```
  claude mcp add -s user julia-vscode-unofficial-mcp -- %USERPROFILE%\.julia-vscode\mcp-bridge.cmd
  ```
- **Codex:**
  ```
  codex mcp add julia-vscode-unofficial-mcp -- %USERPROFILE%\.julia-vscode\mcp-bridge.cmd
  ```


## Usage

The agent should automatically use the REPL when appropriate, nothing else is needed. If it's not doing so, run `/mcp` or ask it to list its tools and ensure Julia is present there. 

The working directory of the agent needs to be the same as the VSCode workspace directory for the agent to find the right window to send commands to. This happens automatically for Claude/Codex VSCode extensions in that window; if you're running from `claude`/`codex` CLI, launch them from the appropriate folder. 

## How it works

The extension reads tool definitions from the official Julia extension's `package.json` and exposes them via an HTTP MCP server on localhost. A stdio bridge script (`~/.julia-vscode/mcp-bridge.js`) translates between the MCP stdio protocol used by Claude/Codex and the HTTP server. Lock files keyed by workspace path handle multiple VS Code windows, and also hold a per-session shared secret that the bridge must present on every request, so only processes that can read the lock file can talk to the REPL.