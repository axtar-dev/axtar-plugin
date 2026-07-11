/**
 * Claude Code hook stdin payload — only the fields we read.
 *
 * Validated leniently: the host sends more than we use, so this Zod schema
 * uses `.passthrough()` and we narrow per-tool inside `assemble.ts`.
 */
import { z } from 'zod';
export const HookInputSchema = z
    .object({
    session_id: z.string().min(1),
    tool_name: z.string().min(1),
    tool_input: z.record(z.unknown()),
    cwd: z.string().optional(),
})
    .passthrough();
export const EditToolInputSchema = z
    .object({
    file_path: z.string().min(1),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
})
    .passthrough();
export const WriteToolInputSchema = z
    .object({
    file_path: z.string().min(1),
    content: z.string(),
})
    .passthrough();
//# sourceMappingURL=hook-input.js.map