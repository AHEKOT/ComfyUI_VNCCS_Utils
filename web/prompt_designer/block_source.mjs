// Keep source offsets so editing a row preserves choice modes, weights and nested syntax.
export function blockRows(source) {
    const plain = () => ({ wrapped: false, rows: [{ start: 0, end: source.length, text: source }] });
    const headerPattern = /^\s*[~@!]?\s*(?:(?:\d+\s*-\s*\d*|-\s*\d+|\d+)\s*\$\$(?:[^${}]*?\$\$)?)?\s*/;
    const weightPattern = /^\s*(?:(?:[+-]?(?:\d+\.\d*|\.\d+)|\d+)::\s*)?/;
    const syntax = source.split("");
    let tokenStart = true;
    // Comments hide delimiters; bound separators and literal slash text retain their bytes.
    for (let index = 0; index < source.length; index++) {
        const weight = tokenStart && weightPattern.exec(source.slice(index))[0];
        if (weight) { index += weight.length - 1; continue; }
        if (source[index] === "{") { index += headerPattern.exec(source.slice(index + 1))[0].length; tokenStart = true; }
        else if (source[index] === "#" || (tokenStart && source.startsWith("//", index))) {
            const newline = source.indexOf("\n", index), end = newline < 0 ? source.length : newline;
            syntax.fill(" ", index, end); index = end - 1;
            tokenStart = true;
        } else if (tokenStart && source.startsWith("/*", index) && source.indexOf("*/", index + 2) >= 0) {
            const end = source.indexOf("*/", index + 2) + 2;
            syntax.fill(" ", index, end); index = end - 1;
        } else if (!tokenStart || !/\s/.test(source[index])) tokenStart = ["}", "|"].includes(source[index]);
    }
    const structure = syntax.join("");
    const opening = /^\s*\{/.exec(structure);
    if (!opening) return plain();
    let depth = 1, end = opening[0].length;
    for (; end < source.length; end++) {
        if (structure[end] === "{") depth++;
        if (structure[end] === "}" && --depth === 0) break;
    }
    if (depth || structure.slice(end + 1).trim()) return plain();
    const header = headerPattern.exec(structure.slice(opening[0].length, end))[0];
    let start = opening[0].length + header.length;
    const rows = [];
    const add = stop => {
        const raw = source.slice(start, stop);
        const prefix = weightPattern.exec(raw)[0].length;
        const contentStart = start + prefix;
        const contentEnd = Math.max(contentStart, stop - /\s*$/.exec(raw)[0].length);
        rows.push({ start: contentStart, end: contentEnd, text: source.slice(contentStart, contentEnd), choiceStart: start, choiceEnd: stop });
        start = stop + 1;
    };
    depth = 0;
    for (let index = start; index < end; index++) {
        if (structure[index] === "{") depth++;
        else if (structure[index] === "}") depth--;
        else if (structure[index] === "|" && depth === 0) add(index);
    }
    add(end);
    return { wrapped: true, rows };
}

export function blockSourceMode(source, mode) {
    return source.replace(/\{(\s*)([~@!]?)/g, (match, space, marker, offset) =>
        ["$", "%"].includes(source[offset - 1]) ? match : `{${space}${mode === "cycle" ? "@" : "~"}`);
}
