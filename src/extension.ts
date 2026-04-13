import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'
import { JuliaMcpServer } from './mcpServer'

const MCP_DIR = path.join(os.homedir(), '.julia-vscode')
const BRIDGE_PATH = path.join(MCP_DIR, 'mcp-bridge.js')

// Standalone Node.js script: reads MCP JSON-RPC from stdin, discovers the
// Julia MCP server port from lock files, forwards to HTTP, writes to stdout.
const BRIDGE_SCRIPT = `'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const os = require('os');

const MCP_DIR = path.join(os.homedir(), '.julia-vscode');

function findPort() {
    const cwd = process.cwd();
    let files;
    try { files = fs.readdirSync(MCP_DIR).filter(f => f.startsWith('mcp-') && f.endsWith('.lock')); }
    catch { return null; }

    let bestPort = null, bestLen = 0;
    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(MCP_DIR, file), 'utf-8'));
            if (data.workspace && cwd.startsWith(data.workspace) && data.workspace.length > bestLen) {
                bestPort = data.port;
                bestLen = data.workspace.length;
            }
        } catch {}
    }
    return bestPort;
}

function post(port, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1', port, path: '/mcp', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data || null));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
    const port = findPort();
    if (!port) {
        const parsed = JSON.parse(line);
        if (parsed.id != null) {
            process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: parsed.id,
                error: { code: -32000, message: 'Julia VS Code MCP server not running for this workspace' }
            }) + '\\n');
        }
        return;
    }
    try {
        const response = await post(port, line);
        if (response) { process.stdout.write(response + '\\n'); }
    } catch (err) {
        const parsed = JSON.parse(line);
        if (parsed.id != null) {
            process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: parsed.id,
                error: { code: -32000, message: 'Connection to Julia MCP server failed: ' + err.message }
            }) + '\\n');
        }
    }
});
`

function workspaceHash(): string | null {
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) { return null }
    return crypto.createHash('sha256').update(folder.uri.fsPath).digest('hex').slice(0, 12)
}

function lockFilePath(): string | null {
    const hash = workspaceHash()
    if (!hash) { return null }
    return path.join(MCP_DIR, `mcp-${hash}.lock`)
}

let mcpServer: JuliaMcpServer | null = null
let lockFile: string | null = null

export async function activate(context: vscode.ExtensionContext) {
    // Get julia-vscode extension
    const juliaExt = vscode.extensions.getExtension('julialang.language-julia')
    if (!juliaExt) {
        console.warn('[julia-vscode-unofficial-mcp] julialang.language-julia not found')
        return
    }

    // Read tool definitions from julia-vscode's package.json
    const lmTools: Array<{
        name: string
        modelDescription: string
        inputSchema: Record<string, unknown>
    }> = juliaExt.packageJSON?.contributes?.languageModelTools ?? []

    const mcpTools = lmTools.map(t => ({
        name: t.name,
        description: t.modelDescription,
        inputSchema: t.inputSchema,
    }))

    // Activate julia-vscode and get its API
    const juliaApi = await juliaExt.activate()
    if (!juliaApi?.executeInREPL) {
        console.warn('[julia-vscode-unofficial-mcp] julia-vscode API does not export executeInREPL')
        return
    }

    // Start MCP server
    try {
        mcpServer = new JuliaMcpServer(juliaApi, mcpTools)
        await mcpServer.start()
        context.subscriptions.push(mcpServer)

        const url = mcpServer.getUrl()
        console.log(`[julia-vscode-unofficial-mcp] MCP server started at ${url}`)

        // Install bridge script and write lock file
        installBridge()
        writeLockFile()

        // Command to show setup instructions
        context.subscriptions.push(
            vscode.commands.registerCommand('julia-vscode-unofficial-mcp.showSetup', async () => {
                const choice = await vscode.window.showInformationMessage(
                    `Julia MCP Server: ${url}`,
                    'Copy Claude Setup',
                    'Copy Codex Setup',
                    'Copy URL'
                )
                if (choice === 'Copy Claude Setup') {
                    await vscode.env.clipboard.writeText(`claude mcp add -s user julia-vscode-unofficial-mcp -- ${BRIDGE_PATH}`)
                    vscode.window.showInformationMessage('Claude setup command copied. Paste in a terminal (one-time setup).')
                } else if (choice === 'Copy Codex Setup') {
                    await vscode.env.clipboard.writeText(`codex mcp add julia-vscode-unofficial-mcp -- ${BRIDGE_PATH}`)
                    vscode.window.showInformationMessage('Codex setup command copied. Paste in a terminal (one-time setup).')
                } else if (choice === 'Copy URL') {
                    await vscode.env.clipboard.writeText(url)
                    vscode.window.showInformationMessage('MCP URL copied.')
                }
            })
        )
    } catch (err) {
        console.warn('[julia-vscode-unofficial-mcp] Failed to start MCP server:', err)
    }
}

function installBridge() {
    try {
        fs.mkdirSync(MCP_DIR, { recursive: true })
        const shebang = `#!${process.execPath}\n`
        fs.writeFileSync(BRIDGE_PATH, shebang + BRIDGE_SCRIPT, { mode: 0o755 })
    } catch (err) {
        console.warn('[julia-vscode-unofficial-mcp] Failed to install bridge script:', err)
    }
}

function writeLockFile() {
    lockFile = lockFilePath()
    if (!lockFile || !mcpServer) { return }
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    try {
        fs.writeFileSync(lockFile, JSON.stringify({
            port: mcpServer.getPort(),
            pid: process.pid,
            workspace
        }) + '\n')
        console.log(`[julia-vscode-unofficial-mcp] Lock file: ${lockFile}`)
    } catch (err) {
        console.warn('[julia-vscode-unofficial-mcp] Failed to write lock file:', err)
    }
}

function removeLockFile() {
    if (lockFile && fs.existsSync(lockFile)) {
        try { fs.unlinkSync(lockFile) } catch {}
    }
}

export function deactivate() {
    removeLockFile()
}
