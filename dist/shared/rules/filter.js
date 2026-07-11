/**
 * Plugin-side rule pre-filter (D-020). Mirrors the gitignore-glob semantics
 * implemented in `engine/src/axtar_engine/detection/router.py::_glob_to_regex`
 * exactly. Drift between the two implementations is a silent correctness bug.
 *
 * Semantics:
 *   - `**\/` matches any (possibly empty) path prefix
 *   - `\/**` at end matches any path suffix
 *   - `**`  standalone matches anything (including `/`)
 *   - `*`   matches anything except `/`
 *   - `?`   matches one character except `/`
 *   - everything else is escaped literal
 */
const EXT_TO_LANGUAGE = {
    '.java': 'java',
};
export function languageForPath(filePath) {
    const dot = filePath.lastIndexOf('.');
    if (dot < 0)
        return undefined;
    const ext = filePath.slice(dot).toLowerCase();
    return EXT_TO_LANGUAGE[ext];
}
export function matchesAnyGlob(filePath, globs) {
    if (globs.length === 0)
        return true;
    return globs.some((g) => globToRegex(g).test(filePath));
}
const regexCache = new Map();
export function globToRegex(pattern) {
    const cached = regexCache.get(pattern);
    if (cached)
        return cached;
    const out = [];
    let i = 0;
    const n = pattern.length;
    while (i < n) {
        if (pattern.startsWith('**/', i)) {
            out.push('(?:.*/)?');
            i += 3;
        }
        else if (pattern.startsWith('/**', i) && i + 3 === n) {
            out.push('(?:/.*)?');
            i += 3;
        }
        else if (pattern.startsWith('**', i)) {
            out.push('.*');
            i += 2;
        }
        else {
            const ch = pattern[i];
            if (ch === '*') {
                out.push('[^/]*');
            }
            else if (ch === '?') {
                out.push('[^/]');
            }
            else {
                out.push(escapeRegex(ch));
            }
            i += 1;
        }
    }
    const compiled = new RegExp(`^${out.join('')}$`);
    regexCache.set(pattern, compiled);
    return compiled;
}
function escapeRegex(ch) {
    return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function filterRules(rules, filePath, options) {
    const language = languageForPath(filePath);
    const out = [];
    for (const rule of rules) {
        const isGateRule = options.gateAltitudes !== undefined && options.gateAltitudes.has(rule.altitude);
        if (!isGateRule) {
            if (!options.severities.has(rule.severity))
                continue;
        }
        if (language !== undefined && rule.language !== language)
            continue;
        if (!matchesAnyGlob(filePath, rule.paths))
            continue;
        out.push(rule);
    }
    return out;
}
//# sourceMappingURL=filter.js.map