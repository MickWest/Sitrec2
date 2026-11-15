jest.mock('../src/Globals', () => ({NodeMan: {get: jest.fn()}}));
jest.mock('../src/GoTo', () => ({applyGoToString: jest.fn()}));
jest.mock('../src/showError', () => ({showChoice: jest.fn(), showPrompt: jest.fn()}));

import {NodeMan} from '../src/Globals';
import {applyGoToString} from '../src/GoTo';
import {showChoice, showPrompt} from '../src/showError';
import {showGoToDialog} from '../src/GoToDialog';

beforeEach(() => jest.resetAllMocks());

test('continuing in chat submits the failed request immediately', async () => {
    const chat = {setVisible: jest.fn(), setInputTextAndFocus: jest.fn(), submitMessage: jest.fn()};
    NodeMan.get.mockReturnValue(chat);
    showPrompt.mockResolvedValue('  Bingley and show satellites  ');
    applyGoToString.mockResolvedValue(false);
    showChoice.mockResolvedValue('chat');
    await showGoToDialog();
    expect(showChoice.mock.calls[0][1].options[0]).toEqual(expect.objectContaining({label: 'Continue in Chat', primary: true}));
    expect(chat.setVisible).toHaveBeenCalledWith(true);
    expect(chat.setInputTextAndFocus).toHaveBeenCalledWith('');
    expect(chat.submitMessage).toHaveBeenCalledTimes(1);
    expect(chat.submitMessage).toHaveBeenCalledWith('Bingley and show satellites');
});

test('cancelling a failed request does not submit it to chat', async () => {
    const chat = {setVisible: jest.fn(), submitMessage: jest.fn()};
    NodeMan.get.mockReturnValue(chat);
    showPrompt.mockResolvedValue('unknown');
    showChoice.mockResolvedValue('cancel');
    await showGoToDialog();
    expect(chat.setVisible).not.toHaveBeenCalled();
    expect(chat.submitMessage).not.toHaveBeenCalled();
});

test('editing a failed request preserves its text', async () => {
    showPrompt.mockResolvedValueOnce('misspelled').mockResolvedValueOnce('Bingley');
    applyGoToString.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    showChoice.mockResolvedValue('edit');
    await showGoToDialog();
    expect(showPrompt.mock.calls[1][1].defaultValue).toBe('misspelled');
    expect(applyGoToString).toHaveBeenLastCalledWith('Bingley');
});

test('builds without chat still offer edit and cancel', async () => {
    showPrompt.mockResolvedValue('unknown');
    showChoice.mockResolvedValue('cancel');
    await showGoToDialog();
    expect(showChoice.mock.calls[0][1].options.map(o => o.value)).toEqual(['edit', 'cancel']);
});

test('successful navigation does not offer chat', async () => {
    showPrompt.mockResolvedValue('Bingley, 10AM');
    applyGoToString.mockResolvedValue(true);
    await showGoToDialog();
    expect(showChoice).not.toHaveBeenCalled();
});
