/**
 * stderr-only structured logger.
 *
 * **stdout is the MCP JSON-RPC channel.** A stray `console.log` there is not a
 * cosmetic problem — it corrupts the framing and the host drops the connection.
 * Every diagnostic in this package goes through here, and here writes to
 * `process.stderr`, always.
 *
 * `AXTAR_LOG_LEVEL` (`debug` · `info` · `warn` · `error`) sets the floor;
 * default `info`.
 */
const levelOrder = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};
function activeLevel() {
    const env = (process.env.AXTAR_LOG_LEVEL ?? 'info').toLowerCase();
    if (env === 'debug' || env === 'info' || env === 'warn' || env === 'error') {
        return env;
    }
    return 'info';
}
function emit(level, message, fields) {
    if (levelOrder[level] < levelOrder[activeLevel()]) {
        return;
    }
    const prefix = `axtar[${level}]`;
    if (fields && Object.keys(fields).length > 0) {
        process.stderr.write(`${prefix} ${message} ${JSON.stringify(fields)}\n`);
        return;
    }
    process.stderr.write(`${prefix} ${message}\n`);
}
export const log = {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
};
//# sourceMappingURL=log.js.map