// A static, section-level inverted index. Builds read only registered public guides.
// No server endpoint, crawler, external service, or runtime filesystem scan is needed.
const fs = require('fs');
const path = require('path');
const {performance} = require('perf_hooks');
const MarkdownIt = require('markdown-it');
const {parseSync} = require('@babel/core');
const {addHeadingIds, stripTags} = require('./docHeadings');
const {searchTerms} = require('../src/documentation/SearchTerms.cjs');

const INDEX_ASSET = 'docs/search-index.json';

function registeredFiles(root) {
    const registry = path.join(root, 'src/docsRegistry.js');
    const ast = parseSync(fs.readFileSync(registry, 'utf8'), {babelrc: false, configFile: false});
    const declaration = ast.program.body.flatMap(node => node.declaration?.declarations || [])
        .find(node => node.id.name === 'helpDocs');
    if (declaration?.init?.type !== 'ArrayExpression') throw new Error('Documentation registry must list its guides');
    return declaration.init.elements.map(entry => {
        const property = entry?.properties?.find(item => item.key?.name === 'file');
        const file = property?.value?.value;
        if (property?.value?.type !== 'StringLiteral' || !/^(README|docs\/[A-Za-z0-9_-]+)$/.test(file)) {
            throw new Error('Documentation registry contains an invalid file');
        }
        return file;
    });
}

function buildDocumentationIndex(root = path.resolve(__dirname, '..')) {
    const started = performance.now();
    const md = new MarkdownIt();
    const plain = html => md.utils.unescapeAll(stripTags(html
        .replace(/<\/(?:p|li|tr|pre|h[1-6])>/g, ' '))).replace(/\s+/g, ' ').trim();
    const documents = [], sections = [], postings = Object.create(null);
    const files = registeredFiles(root);
    for (const file of files) {
        let markdown = fs.readFileSync(path.join(root, file + '.md'), 'utf8');
        let previous;
        do {
            previous = markdown;
            markdown = markdown.replace(/<!--[\s\S]*?-->/g, '');
        } while (markdown !== previous);
        const html = addHeadingIds(md.render(markdown));
        const headings = [...html.matchAll(/<h([1-6])(?: id="([^"]*)")?>([\s\S]*?)<\/h\1>/g)];
        const title = plain(headings.find(h => h[1] === '1')?.[3] || file.split('/').at(-1));
        const document = documents.length;
        documents.push({file, title});
        const hierarchy = [];
        const addSection = (heading, anchor, text) => {
            if (!heading && !text) return;
            const id = sections.length;
            sections.push({document, heading, anchor, text});
            for (const term of searchTerms(`${title} ${heading} ${text}`)) {
                (postings[term] ??= []).push(id);
            }
        };
        addSection('', '', plain(html.slice(0, headings[0]?.index ?? html.length)));
        headings.forEach((h, i) => {
            const level = Number(h[1]);
            hierarchy.length = level - 1;
            hierarchy[level - 1] = plain(h[3]);
            const heading = hierarchy.slice(1).filter(Boolean).join(' › ');
            const text = plain(html.slice(h.index + h[0].length, headings[i + 1]?.index ?? html.length));
            addSection(heading, h[2] || '', text);
        });
    }
    const index = {version: 1, documents, sections, postings};
    const json = JSON.stringify(index);
    return {index, json, files: ['src/docsRegistry.js', ...files.map(file => file + '.md')],
        elapsedMs: performance.now() - started, bytes: Buffer.byteLength(json)};
}

function describeBuild(result) {
    return `Documentation search: ${result.index.documents.length} pages, ${result.index.sections.length} sections, `
        + `${(result.bytes / 1024).toFixed(0)} KiB, ${result.elapsedMs.toFixed(0)} ms`;
}

class DocumentationIndexPlugin {
    apply(compiler) {
        compiler.hooks.thisCompilation.tap('DocumentationIndexPlugin', compilation => {
            compilation.hooks.processAssets.tap({name: 'DocumentationIndexPlugin',
                stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL}, () => {
                const result = buildDocumentationIndex(compiler.context);
                for (const file of result.files) compilation.fileDependencies.add(path.join(compiler.context, file));
                compilation.emitAsset(INDEX_ASSET, new compiler.webpack.sources.RawSource(result.json));
                console.log(describeBuild(result));
            });
        });
    }
}

if (require.main === module) {
    const result = buildDocumentationIndex();
    const destination = process.argv[2];
    if (destination && destination !== '--check') {
        fs.mkdirSync(path.dirname(path.resolve(destination)), {recursive: true});
        fs.writeFileSync(destination, result.json);
    }
    console.log(describeBuild(result));
}

module.exports = {buildDocumentationIndex, registeredFiles, DocumentationIndexPlugin, INDEX_ASSET};
