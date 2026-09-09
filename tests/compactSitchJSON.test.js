import {parseJavascriptObject} from '../src/Serialize';

test('compact JSON preserves metadata after quoted braces and nested arrays', () => {
    const sitch={stringified:true,isASitchFile:true,notes:'A quoted brace } and // text',
        nodes:[{text:'nested { text }'}],exportBuild:{id:'beta-file',channel:'beta',version:'2.156.0',builtAt:'2026-09-09T00:00:00Z'}};
    expect(parseJavascriptObject(JSON.stringify(sitch))).toEqual(sitch);
});

test('legacy sitch syntax still supports unquoted names, comments and single-quoted text', () => {
    expect(parseJavascriptObject("sitch = {\n// comment\nname: 'example', frames: 30,\n}"))
        .toEqual({name:'example',frames:30});
});
