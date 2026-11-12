/** @jest-environment jsdom */
// The Notes of a sitch template are its instructions. "##name" starts a section,
// and the "intro" section shows in a box when a sitch opens from the template.
import {
    dismissTemplateIntro,
    INTRO_FADE_MS,
    parseTemplateSections,
    removeTemplateIntro,
    showTemplateIntro,
    templateIntroText,
} from '../src/SitchTemplateInstructions';

const TEMPLATE = {name: 'Video Viewer', userID: 1};
const introBox = () => document.querySelector('[data-template-intro]');

beforeEach(() => {
    jest.useFakeTimers();
});
afterEach(() => {
    removeTemplateIntro();
    document.body.innerHTML = '';
    jest.useRealTimers();
});

describe('the sections of the Notes', () => {
    test('a section goes from its ##name to the next ##', () => {
        const sections = parseTemplateSections('##intro\nDrop a video here.\nThen press Play.\n##tips\nUse the timeline.');

        expect(sections).toEqual({intro: 'Drop a video here.\nThen press Play.', tips: 'Use the timeline.'});
    });

    test('the last section goes to the end of the Notes', () => {
        expect(parseTemplateSections('##intro\nLine 1\n\nLine 3\n')).toEqual({intro: 'Line 1\n\nLine 3'});
    });

    test('text before the first ## is in no section', () => {
        expect(parseTemplateSections('Source: a forum post.\n\n##intro\nHello')).toEqual({intro: 'Hello'});
    });

    test('Notes with no ## have no sections', () => {
        expect(parseTemplateSections('Only notes, with a # and a link https://example.test/#part')).toEqual({});
        expect(parseTemplateSections('')).toEqual({});
        expect(parseTemplateSections(undefined)).toEqual({});
    });

    test('the text can start on the line of the name', () => {
        expect(parseTemplateSections('##intro Drop a video here. ##tips More.')).toEqual({intro: 'Drop a video here.', tips: 'More.'});
    });

    test('a name is not case-sensitive, and can have spaces before it', () => {
        expect(parseTemplateSections('##Intro\nOne\n## Tips\nTwo')).toEqual({intro: 'One', tips: 'Two'});
    });

    test('a ## with no name ends the section and starts none', () => {
        expect(parseTemplateSections('##intro\nShown\n##\nNot in a section')).toEqual({intro: 'Shown'});
    });

    test('for a name that is there two times, the first one is used', () => {
        expect(parseTemplateSections('##intro\nFirst\n##intro\nSecond')).toEqual({intro: 'First'});
    });

    test('Windows line ends are text like the others', () => {
        expect(parseTemplateSections('##intro\r\nLine 1\r\nLine 2\r\n##tips\r\nT')).toEqual({intro: 'Line 1\r\nLine 2', tips: 'T'});
    });
});

describe('which sitch shows the intro', () => {
    test('a sitch that opened from a template shows the intro section', () => {
        expect(templateIntroText(TEMPLATE, 'Notes\n##intro\nDrop a video here.')).toBe('Drop a video here.');
    });

    test('the same Notes in a sitch that did not open from a template show no intro', () => {
        expect(templateIntroText(undefined, '##intro\nDrop a video here.')).toBe('');
        expect(templateIntroText(null, '##intro\nDrop a video here.')).toBe('');
    });

    test('a template with no intro section, or with an empty one, shows no intro', () => {
        expect(templateIntroText(TEMPLATE, '##tips\nOnly tips')).toBe('');
        expect(templateIntroText(TEMPLATE, '##intro\n\n##tips\nOnly tips')).toBe('');
        expect(templateIntroText(TEMPLATE, undefined)).toBe('');
    });
});

describe('the intro box', () => {
    test('shows the text, and keeps the line breaks', () => {
        const box = showTemplateIntro('Line 1\nLine 2');

        expect(introBox()).toBe(box);
        expect(box.textContent).toBe('Line 1\nLine 2');
        expect(box.style.whiteSpace).toBe('pre-wrap');
        expect(box.style.opacity).toBe('1');
    });

    test('shows the Notes as text, never as HTML', () => {
        const box = showTemplateIntro('<img src=x onerror="window.bad = 1"><b>bold</b>');

        expect(box.children.length).toBe(0);
        expect(box.textContent).toBe('<img src=x onerror="window.bad = 1"><b>bold</b>');
    });

    test('does not take the click or the drop: they go to what is below', () => {
        expect(showTemplateIntro('Hello').style.pointerEvents).toBe('none');
    });

    test('an empty text shows no box', () => {
        expect(showTemplateIntro('')).toBeNull();
        expect(introBox()).toBeNull();
    });

    test('fades out and goes away when the user clicks on something', () => {
        const box = showTemplateIntro('Hello');
        const target = document.body.appendChild(document.createElement('button'));

        target.dispatchEvent(new Event('pointerdown', {bubbles: true}));

        expect(box.style.opacity).toBe('0');
        expect(introBox()).toBe(box);          // still there while it fades
        jest.advanceTimersByTime(INTRO_FADE_MS);
        expect(introBox()).toBeNull();
    });

    test('fades out when the user drops a file, also if a handler stops the event', () => {
        const box = showTemplateIntro('Hello');
        const dropZone = document.body.appendChild(document.createElement('div'));
        dropZone.addEventListener('drop', event => event.stopPropagation());

        dropZone.dispatchEvent(new Event('drop', {bubbles: true}));

        expect(box.style.opacity).toBe('0');
        jest.advanceTimersByTime(INTRO_FADE_MS);
        expect(introBox()).toBeNull();
    });

    test('a key press or a mouse move does not make it go away', () => {
        const box = showTemplateIntro('Hello');

        document.body.dispatchEvent(new Event('keydown', {bubbles: true}));
        document.body.dispatchEvent(new Event('pointermove', {bubbles: true}));
        document.body.dispatchEvent(new Event('dragover', {bubbles: true}));

        expect(box.style.opacity).toBe('1');
        expect(introBox()).toBe(box);
    });

    test('a new intro replaces the one that shows', () => {
        showTemplateIntro('First');
        showTemplateIntro('Second');

        expect(document.querySelectorAll('[data-template-intro]').length).toBe(1);
        expect(introBox().textContent).toBe('Second');
    });

    test('a click after the box is gone does nothing', () => {
        showTemplateIntro('Hello');
        dismissTemplateIntro();
        jest.advanceTimersByTime(INTRO_FADE_MS);

        expect(() => document.body.dispatchEvent(new Event('pointerdown', {bubbles: true}))).not.toThrow();
        expect(introBox()).toBeNull();
    });

    test('a change of sitch removes the box at once', () => {
        showTemplateIntro('Hello');

        removeTemplateIntro();

        expect(introBox()).toBeNull();
    });

    test('a box that is fading does not stop the box of the next template', () => {
        showTemplateIntro('First');
        dismissTemplateIntro();
        const second = showTemplateIntro('Second');
        jest.advanceTimersByTime(INTRO_FADE_MS);

        // The timer of the first box removes the first box only.
        expect(introBox()).toBe(second);
        expect(second.style.opacity).toBe('1');
    });
});
