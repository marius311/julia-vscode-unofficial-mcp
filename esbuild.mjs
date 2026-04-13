import * as esbuild from 'esbuild'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outdir: 'dist',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
})

if (watch) {
    await ctx.watch()
    console.log('[watch] build started')
} else {
    await ctx.rebuild()
    await ctx.dispose()
}
