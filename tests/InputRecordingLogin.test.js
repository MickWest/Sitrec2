/** @jest-environment jsdom */
jest.mock('../src/InputRecording', () => ({InputRecorder: jest.fn().mockImplementation(options => ({
    userID: options.userID, active: true, start: jest.fn(), stop: jest.fn(),
}))}));
jest.mock('../src/configUtils', () => ({isServerless: false, SITREC_SERVER: '/sitrecServer/'}));
jest.mock('../src/envUtils', () => ({getEnvBool: () => false}));
jest.mock('../src/Globals', () => ({Globals: {}, withTestUser: url => url}));
jest.mock('../src/par', () => ({par: {}}));

import {Globals} from '../src/Globals';
import {InputRecorder} from '../src/InputRecording';
import {initUILogging} from '../src/UILogging';

test('recording follows server login permission independently of the aggregate counter', () => {
    Globals.userData = {userID: 42, inputRecording: false};
    initUILogging();
    expect(InputRecorder).not.toHaveBeenCalled();
    Globals.userData = {userID: 42, inputRecording: true, inputRecordingUserID: 1};
    window.dispatchEvent(new Event('sitrec-login-change'));
    expect(InputRecorder).toHaveBeenCalledTimes(1);
    expect(InputRecorder).toHaveBeenCalledWith(expect.objectContaining({userID: 1}));
    const recorder = InputRecorder.mock.results[0].value;
    expect(recorder.start).toHaveBeenCalledTimes(1);
    initUILogging();
    expect(InputRecorder).toHaveBeenCalledTimes(1);
    Globals.userData = {userID: 0, inputRecording: false};
    window.dispatchEvent(new Event('sitrec-login-change'));
    expect(recorder.stop).toHaveBeenCalledWith(true);
});
