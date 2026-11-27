// Lists the interface's English strings, as they reach the DOM, so the Czech
// dictionary (src/app/lib/i18n/cs.json) can be checked against them.
//
//   node scripts/ui-strings.mjs            every string, as JSON
//   node scripts/ui-strings.mjs --missing  only those without a translation
//
// The interface is not written against a translation function: its strings
// are plain JSX and literals, and the dictionary is applied to the rendered
// page (src/app/lib/i18n/domTranslator.ts). This script therefore reads the
// source the way React will render it: JSX text is collapsed like React
// collapses it, and a template literal becomes a pattern with a `{n}` for
// each interpolated value.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, "..");
const ROOTS = [
    path.join(frontend, "src/app"),
    path.resolve(frontend, "../packages/ui/src"),
    path.resolve(frontend, "../packages/client/src"),
];
const DICTIONARY = path.join(frontend, "src/app/lib/i18n/cs.json");

// Attributes and object keys whose string value is shown to a person.
const TEXT_KEYS = new Set([
    "label", "placeholder", "title", "aria-label", "ariaLabel", "alt",
    "description", "tooltip", "heading", "subtitle", "message", "detail",
    "text", "hint", "helperText", "emptyText", "emptyTitle", "emptyDescription",
    "confirmLabel", "cancelLabel", "confirmText", "cancelText", "actionLabel",
    "summary", "caption", "name", "action", "fallback", "body", "note",
    "loadingLabel", "submitLabel", "error", "warning", "success", "header",
    "primaryLabel", "secondaryLabel", "buttonLabel", "tip", "help", "content",
    "displayName", "product", "group", "section", "category", "noun", "verb",
    "children", "value", "prefix", "suffix", "status", "reason", "question",
]);
// Calls whose string arguments are shown to a person.
const TEXT_CALLS = /^(toast|notify\w*|show\w*|set\w*(Error|Message|Notice|Status|Warning)|userFacingApiError|confirm|alert|Error|UserFacingError|describe\w*)$/;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rarr: "→", larr: "←", middot: "·", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", times: "×", bull: "•", copy: "©" };
const decode = (text) =>
    text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, name) => {
        if (name[0] === "#") {
            const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
            return String.fromCodePoint(code);
        }
        return ENTITIES[name] ?? whole;
    });

/** React's JSX whitespace rule: lines trimmed, blank lines dropped, joined by a space. */
function jsxText(raw) {
    const lines = raw.split(/\r\n|\n|\r/);
    const kept = [];
    lines.forEach((line, index) => {
        let value = line.replace(/\t/g, " ");
        if (index !== 0) value = value.replace(/^[ ]+/, "");
        if (index !== lines.length - 1) value = value.replace(/[ ]+$/, "");
        if (value) kept.push(value);
    });
    return decode(kept.join(" "));
}

/** Worth translating: has a word, and is not a class list, path, id or code. */
function isProse(value, { loose = false } = {}) {
    const text = value.trim();
    if (text.length < 2 || !/[A-Za-z]{2}/.test(text)) return false;
    if (/^[a-z0-9_./:#@\[\]()%!-]+$/.test(text) && !loose) return false; // identifiers, paths
    if (/^(https?:|\/|\.\/|@\/|#)/.test(text)) return false;
    if (/^[a-z]+([A-Z][a-z0-9]+)+$/.test(text)) return false; // camelCase
    if (/^[A-Z0-9_]+$/.test(text) && text.length > 4) return false; // CONSTANTS
    if (!loose && !/[A-Z]/.test(text[0]) && !/\s/.test(text)) return false;
    // Tailwind class lists and CSS.
    if (/(^|\s)(flex|grid|hidden|block|inline|absolute|relative|w-|h-|p[xytblr]?-|m[xytblr]?-|text-|bg-|border|rounded|gap-|items-|justify-|font-|shadow|opacity-|transition|hover:|focus|dark:|min-|max-|overflow|z-|top-|left-|right-|bottom-|space-|size-|shrink|grow|truncate|cursor-|select-|sr-only|animate-|translate|scale-|ring|outline|whitespace|leading-|tracking-|col-|row-|order-|aspect-|object-|fill-|stroke-|@container|group|peer)[\w\[\]:/.%-]*(\s|$)/.test(text) && !/[.?!]$/.test(text)) return false;
    return true;
}

const found = new Map(); // text -> Set(files)
function add(text, file) {
    const value = text.replace(/\s+/g, " ").trim();
    if (!value) return;
    if (!found.has(value)) found.set(value, new Set());
    found.get(value).add(path.relative(path.resolve(frontend, ".."), file));
}

function templateText(node) {
    // `Delete ${count} files` -> "Delete {1} files"
    let out = node.head.text;
    node.templateSpans.forEach((span, index) => {
        out += `{${index + 1}}${span.literal.text}`;
    });
    return out;
}

function literalText(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
        const text = templateText(node);
        // A template that is only holes and punctuation says nothing itself.
        return /[A-Za-z]{2}/.test(text.replace(/\{\d+\}/g, "")) ? text : null;
    }
    return null;
}

/** Strings an expression can evaluate to: through ?:, ||, ??, && and parentheses. */
function expressionStrings(node, out = []) {
    if (!node) return out;
    const text = literalText(node);
    if (text !== null) out.push(text);
    else if (ts.isConditionalExpression(node)) {
        expressionStrings(node.whenTrue, out);
        expressionStrings(node.whenFalse, out);
    } else if (ts.isBinaryExpression(node)) {
        const kind = node.operatorToken.kind;
        if (kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.AmpersandAmpersandToken) {
            expressionStrings(node.left, out);
            expressionStrings(node.right, out);
        }
    } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node)) {
        expressionStrings(node.expression, out);
    }
    return out;
}

function keyName(name) {
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
    if (ts.isJsxNamespacedName?.(name)) return `${name.namespace.text}:${name.name.text}`;
    return null;
}

function visit(node, file) {
    if (ts.isJsxText(node)) {
        const text = jsxText(node.text);
        if (isProse(text, { loose: true })) add(text, file);
    } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
        for (const text of expressionStrings(node.expression)) if (isProse(text, { loose: true })) add(text, file);
    } else if (ts.isJsxAttribute(node)) {
        const key = keyName(node.name);
        if (key && TEXT_KEYS.has(key) && node.initializer) {
            const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
            for (const text of expressionStrings(value)) if (isProse(text)) add(text, file);
        }
    } else if (ts.isPropertyAssignment(node)) {
        const key = keyName(node.name);
        if (key && TEXT_KEYS.has(key)) {
            for (const text of expressionStrings(node.initializer)) if (isProse(text)) add(text, file);
        }
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : "";
        if (TEXT_CALLS.test(callee)) {
            for (const argument of node.arguments ?? []) {
                for (const text of expressionStrings(argument)) if (isProse(text) && /\s/.test(text)) add(text, file);
            }
        }
    } else if (ts.isReturnStatement(node) || ts.isArrowFunction(node)) {
        // Small label helpers: `return "Current session"` / `() => "…"`.
        const value = ts.isReturnStatement(node) ? node.expression : !ts.isBlock(node.body) ? node.body : null;
        for (const text of expressionStrings(value)) if (isProse(text) && /\s/.test(text) && /^[A-Z]/.test(text)) add(text, file);
    }
    ts.forEachChild(node, (child) => visit(child, file));
}

function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!["node_modules", "__tests__", "stories", "i18n"].includes(entry.name)) walk(full);
        } else if (/\.(tsx|ts)$/.test(entry.name) && !/\.(test|stories|d)\.tsx?$/.test(entry.name)) {
            const source = ts.createSourceFile(full, fs.readFileSync(full, "utf8"), ts.ScriptTarget.Latest, true, entry.name.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
            visit(source, full);
        }
    }
}

for (const root of ROOTS) if (fs.existsSync(root)) walk(root);

const dictionary = fs.existsSync(DICTIONARY) ? JSON.parse(fs.readFileSync(DICTIONARY, "utf8")) : {};
const missingOnly = process.argv.includes("--missing");
const byArea = process.argv.includes("--areas");
const rows = [...found.entries()]
    .filter(([text]) => !missingOnly || !(text in dictionary))
    .sort(([a], [b]) => a.localeCompare(b));

if (byArea) {
    const areas = new Map();
    for (const [text, files] of rows) {
        const first = [...files][0].split("/");
        const area = first.slice(0, first[0] === "packages" ? 2 : 5).join("/");
        areas.set(area, (areas.get(area) ?? 0) + 1);
    }
    for (const [area, count] of [...areas].sort((a, b) => b[1] - a[1])) console.log(String(count).padStart(5), area);
    console.log(String(rows.length).padStart(5), "total");
} else {
    console.log(JSON.stringify(Object.fromEntries(rows.map(([text, files]) => [text, [...files]])), null, 1));
}
if (missingOnly) console.error(`${rows.length} of ${found.size} strings have no translation.`);
