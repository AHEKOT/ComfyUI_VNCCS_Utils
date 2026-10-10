// Keep source offsets so editing a row preserves choice modes, weights and nested syntax.
export function blockRows(source) {
    const plain = () => ({ wrapped: false, rows: [{ start: 0, end: source.length, text: source }] });
    const opening = /^\s*\{/.exec(source);
    if (!opening) return plain();
    let depth = 1, end = opening[0].length;
    for (; end < source.length; end++) {
        if (source[end] === "{") depth++;
        if (source[end] === "}" && --depth === 0) break;
    }
    if (depth || source.slice(end + 1).trim()) return plain();
    const header = /^\s*[~@!]?\s*(?:(?:\d+\s*-\s*\d*|-\s*\d+|\d+)\s*\$\$(?:[^${}]*?\$\$)?)?\s*/.exec(source.slice(opening[0].length, end))[0];
    let start = opening[0].length + header.length;
    const rows = [];
    const add = stop => {
        const raw = source.slice(start, stop);
        const prefix = /^\s*(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*::\s*)?/.exec(raw)[0].length;
        const contentStart = start + prefix;
        const contentEnd = Math.max(contentStart, stop - /\s*$/.exec(raw)[0].length);
        rows.push({ start: contentStart, end: contentEnd, text: source.slice(contentStart, contentEnd), choiceStart: start, choiceEnd: stop });
        start = stop + 1;
    };
    depth = 0;
    for (let index = start; index < end; index++) {
        if (source[index] === "{") depth++;
        else if (source[index] === "}") depth--;
        else if (source[index] === "|" && depth === 0) add(index);
    }
    add(end);
    return { wrapped: true, rows };
}

export function blockSourceMode(source, mode) {
    return source.replace(/\{(\s*)([~@!]?)/g, (match, space, marker, offset) =>
        ["$", "%"].includes(source[offset - 1]) ? match : `{${space}${mode === "cycle" ? "@" : "~"}`);
}
