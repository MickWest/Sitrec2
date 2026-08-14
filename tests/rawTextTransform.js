// Jest counterpart to the webpack `asset/source` rule in webpack.common.js.
//
// The AI assistant's system prompt lives in sitrecServer/chatbotSystemPrompt.txt and is
// imported as a plain string by src/CDirectLLMClient.js. Webpack inlines it via
// `type: 'asset/source'`; Jest has no equivalent, so this transformer does the same job:
// turn the file's bytes into a module whose default export is the text.
//
// Using a real transformer rather than a moduleNameMapper stub is deliberate — it lets
// the tests assert against the actual shipped prompt (so a malformed @@SECTION file
// fails the suite instead of silently producing an assistant with no instructions).
module.exports = {
    process(sourceText) {
        return {code: `module.exports = ${JSON.stringify(sourceText)};`};
    },
};
