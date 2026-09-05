import fs from 'fs';
import path from 'path';
import {spawnSync} from 'child_process';
import {buildSystemPrompt, buildSystemPromptParts} from '../src/CDirectLLMClient';

const serverDir = path.resolve(__dirname, '../sitrecServer');
const phpAvailable = spawnSync('php', ['-v']).status === 0;

// Execute the real prompt parser and assembly without the authenticated endpoint
// bootstrap or any provider calls. This catches a missing scope substitution on PHP.
(phpAvailable ? test : test.skip)('server prompt stays focused and matches the default browser prompt', () => {
    const source = fs.readFileSync(path.join(serverDir, 'chatbot.php'), 'utf8');
    const start = source.indexOf('function failPromptConfig(');
    const end = source.indexOf('// A capped response', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const assembly = source.slice(start, end).replaceAll('__DIR__', JSON.stringify(serverDir));
    const args = {
        simDateTime: '2026-09-05T12:00:00Z',
        menuSummary: {view: ['Camera Pos', 'FOV']},
        availableDocs: {WhatsNew: 'Recent changes'},
    };
    const input = JSON.stringify({...args, sitrecFocused: false, byokSitrecFocused: false});
    const php = `$input = json_decode(base64_decode('${Buffer.from(input).toString('base64')}'), true);
        $simDateTime = $input['simDateTime'];
        $menuSummary = $input['menuSummary'];
        $availableDocs = $input['availableDocs'];
        ${assembly}
        echo json_encode(['prompt' => $systemPrompt, 'parts' => $systemParts]);`;
    const result = spawnSync('php', ['-r', php], {encoding: 'utf8'});
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.prompt).toBe(buildSystemPrompt(args));
    const parts = buildSystemPromptParts(args);
    expect(parsed.parts).toEqual({static: parts.staticPart, menu: parts.menuPart, volatile: parts.volatilePart});
    expect(parsed.prompt).toContain('Do not discuss anything unrelated to Sitrec');
    expect(parsed.prompt).not.toContain('You can discuss any topic');
    expect(parsed.prompt).not.toContain('{{topicScope}}');
});
