import * as http from 'http'
import * as vscode from 'vscode'

const MCP_PROTOCOL_VERSION = '2025-03-26'
const SERVER_NAME = 'julia-vscode-unofficial-mcp'
const SERVER_VERSION = '0.1.0'

const SERVER_INSTRUCTIONS = `You have access to a Julia REPL running in VS Code. Use the run-julia-code tool for nearly all Julia execution. Use the shell julia command only when a true command-line invocation is required, such as running a script as a process or reproducing CLI-specific behavior.

The REPL session is persistent. Variables, methods, loaded packages, and other state may already exist from earlier in the conversation or from the user's own work. Before assuming setup is needed, probe the session state when relevant.

If you execute code that comes from a file, keep that file synchronized with the code you actually ran.

Standard output and standard error are not returned so you can't use print statements or expect to see debug outputs from user code. You will only receive the final result of the execution.

You can display plots to the user by evaluating any plotting backend's plot command (e.g. \`Plots.plot(...)\`) in the REPL. Only save plots to a file if the user asks. 

If execution fails, use the returned error and stack trace to debug and retry.

Use restart-julia-repl if the session gets into a bad state.`

interface McpToolDef {
    name: string
    description: string
    inputSchema: Record<string, unknown>
}

// Map MCP tool names to their VS Code command handlers.
// `run-julia-code` is special — it uses the extension API's executeInREPL.
// All others delegate to VS Code commands.
const TOOL_COMMANDS: Record<string, string> = {
    'restart-julia-repl': 'language-julia.restartREPL',
    'stop-julia-repl': 'language-julia.stopREPL',
    'interrupt-julia-execution': 'language-julia.interrupt',
    'change-julia-environment': 'language-julia.activateHere',
}

const TOOL_MESSAGES: Record<string, string> = {
    'restart-julia-repl': 'Julia REPL has been restarted.',
    'stop-julia-repl': 'Julia REPL has been stopped.',
    'interrupt-julia-execution': 'Julia execution has been interrupted.',
    'change-julia-environment': 'Julia environment changed.',
}

type ToolResult = { content: Array<{ type: string, text: string }>, isError?: boolean }

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => resolve(Buffer.concat(chunks).toString()))
        req.on('error', reject)
    })
}

export class JuliaMcpServer implements vscode.Disposable {
    private server: http.Server | null = null
    private port = 0
    private tools: McpToolDef[]
    private juliaApi: { executeInREPL: Function }

    constructor(juliaApi: { executeInREPL: Function }, tools: McpToolDef[]) {
        this.juliaApi = juliaApi
        this.tools = tools
    }

    private async handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        if (name === 'run-julia-code') {
            const code = args.code as string
            if (!code) {
                return { content: [{ type: 'text', text: 'Error: code parameter is required' }], isError: true }
            }
            const result = await this.juliaApi.executeInREPL(code, {
                showCodeInREPL: true,
                showResultInREPL: true,
                showErrorInREPL: true,
            })
            if (result.stackframe) {
                return { content: [{ type: 'text', text: `Error:\n${result.all}` }], isError: true }
            }
            return { content: [{ type: 'text', text: result.all || '# No output' }] }
        }

        if (name === 'change-julia-environment') {
            const envPath = args.envPath as string
            if (!envPath) {
                return { content: [{ type: 'text', text: 'Error: envPath parameter is required' }], isError: true }
            }
            await vscode.commands.executeCommand(TOOL_COMMANDS[name], vscode.Uri.parse(envPath))
            return { content: [{ type: 'text', text: `Julia environment changed to: ${envPath}` }] }
        }

        const command = TOOL_COMMANDS[name]
        if (command) {
            await vscode.commands.executeCommand(command)
            return { content: [{ type: 'text', text: TOOL_MESSAGES[name] }] }
        }

        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }

    private handleJsonRpc(request: { jsonrpc: string, method: string, params?: unknown, id?: number | string }): Promise<unknown> | unknown {
        switch (request.method) {
        case 'initialize':
            return {
                jsonrpc: '2.0',
                id: request.id,
                result: {
                    protocolVersion: MCP_PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
                    instructions: SERVER_INSTRUCTIONS
                }
            }
        case 'ping':
            return { jsonrpc: '2.0', id: request.id, result: {} }
        case 'tools/list':
            return { jsonrpc: '2.0', id: request.id, result: { tools: this.tools } }
        case 'tools/call': {
            const params = request.params as { name: string, arguments?: Record<string, unknown> }
            return this.handleToolCall(params.name, params.arguments || {}).then(
                result => ({ jsonrpc: '2.0', id: request.id, result }),
                err => ({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true } })
            )
        }
        default:
            if (request.id === undefined || request.id === null) {
                return null // notification
            }
            return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } }
        }
    }

    async start(): Promise<number> {
        this.server = http.createServer(async (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS')
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id')

            if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
            if (req.method === 'GET' && req.url === '/mcp') { res.writeHead(405); res.end(); return }
            if (req.method === 'DELETE' && req.url === '/mcp') { res.writeHead(200); res.end(); return }
            if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(404); res.end(); return }

            try {
                const body = await readBody(req)
                const parsed = JSON.parse(body)

                // Handle JSON-RPC batch
                if (Array.isArray(parsed)) {
                    const responses: unknown[] = []
                    for (const request of parsed) {
                        const response = await this.handleJsonRpc(request)
                        if (response !== null) { responses.push(response) }
                    }
                    if (responses.length === 0) { res.writeHead(202); res.end() }
                    else {
                        res.writeHead(200, { 'Content-Type': 'application/json' })
                        res.end(JSON.stringify(responses.length === 1 ? responses[0] : responses))
                    }
                    return
                }

                const response = await this.handleJsonRpc(parsed)
                if (response === null) { res.writeHead(202); res.end() }
                else {
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify(response))
                }
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
            }
        })

        return new Promise<number>((resolve, reject) => {
            this.server!.listen(0, '127.0.0.1', () => {
                const addr = this.server!.address()
                if (addr && typeof addr !== 'string') {
                    this.port = addr.port
                    resolve(this.port)
                } else {
                    reject(new Error('Failed to get server port'))
                }
            })
            this.server!.on('error', reject)
        })
    }

    getUrl(): string { return `http://127.0.0.1:${this.port}/mcp` }
    getPort(): number { return this.port }

    dispose() {
        if (this.server) { this.server.close(); this.server = null }
    }
}
