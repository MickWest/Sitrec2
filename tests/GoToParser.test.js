import {parseGoToString} from '../src/GoToParser';

test.each([
    ['Bingley, 10AM', 'Bingley', '10AM'],
    ['Saturday, August 30, 2025, at 8:09 PM, South Korea', 'South Korea', 'Saturday, August 30, 2025, at 8:09 PM'],
    ['go to Bingley, 10AM', 'Bingley', '10AM'],
    ['London at noon tomorrow', 'London', 'noon tomorrow'],
    ['Paris tomorrow at noon', 'Paris', 'tomorrow at noon'],
    ['New York, NY, tomorrow at 10am', 'New York, NY', 'tomorrow at 10am'],
    ['Bingley, Jan 6, 2027, 10am', 'Bingley', 'Jan 6, 2027, 10am'],
    ['51.8, -1.8, 300, 10am', '51.8, -1.8, 300', '10am'],
    ['Bingley, 10am UTC', 'Bingley', '10am UTC'],
    ['Bingley jun 10, 6PM', 'Bingley', 'jun 10, 6PM'],
    ['Bingley jun 10 6PM', 'Bingley', 'jun 10 6PM'],
    ['Bingely jun 10, 6PM', 'Bingely', 'jun 10, 6PM'],
    ['Bingley 6PM jun 10', 'Bingley', '6PM jun 10'],
    ['go to New York June 10 2027 6PM', 'New York', 'June 10 2027 6PM'],
    ['New York 10 June 2027 at 6PM', 'New York', '10 June 2027 at 6PM'],
    ['Bingley 10AM', 'Bingley', '10AM'],
    ['51.8 -1.8 Jun 10 6PM', '51.8 -1.8', 'Jun 10 6PM'],
    ['12PM Bingley', 'Bingley', '12PM'],
    ['Bingley 12PM', 'Bingley', '12PM'],
    ['12PM, Bingley', 'Bingley', '12PM'],
    ['June 10 6PM Bingley', 'Bingley', 'June 10 6PM'],
    ['June 10 Bingley 6PM', 'Bingley', 'June 10, 6PM'],
    ['6PM Bingley June 10', 'Bingley', '6PM, June 10'],
    ['June 10, New York, 6PM', 'New York', 'June 10, 6PM'],
    ['tomorrow New York noon', 'New York', 'tomorrow, noon'],
    ['12PM UTC 51.8, -1.8', '51.8, -1.8', '12PM UTC'],
    ['Bingley sunset', 'Bingley', 'sunset'],
    ['sunrise Bingley', 'Bingley', 'sunrise'],
    ['June 10 Bingley moonset', 'Bingley', 'June 10, moonset'],
    ['moonrise Bingley June 10', 'Bingley', 'moonrise, June 10'],
    ['Bingley tomorrow at dusk', 'Bingley', 'tomorrow at dusk'],
    ['tomorrow Bingley morning', 'Bingley', 'tomorrow, morning'],
    ['Bingley an hour after sunset', 'Bingley', 'an hour after sunset'],
    ['an hour after sunset Bingley', 'Bingley', 'an hour after sunset'],
    ['June 10 Bingley an hour after sunset', 'Bingley', 'June 10, an hour after sunset'],
    ['half an hour before moonrise Bingley June 10', 'Bingley', 'half an hour before moonrise, June 10'],
    ['Bingley June 10 1 hour 30 minutes after sunset', 'Bingley', 'June 10 1 hour 30 minutes after sunset'],
])('dialog and chat both split %s', (text, location, time) => {
    for (const chat of [false, true]) {
        expect(parseGoToString(text, {chat})).toEqual({kind: 'location', location, time});
    }
});

test.each(['New York, NY', 'Area 51', '1600 Pennsylvania Avenue', 'North Bend', 'West Hollywood', 'June Lake', 'Mayfield'])('keeps the whole place name %s', text => {
    expect(parseGoToString(text)).toEqual({kind: 'location', location: text});
});

test.each(['Bingley, 25:00', 'go to London and set fov to 60', 'go back', 'why is the sky blue', 'Bingley, tomorrow at 25:00',
    '12PM Bingley 6PM', 'June 10 Bingley July 12', 'now Bingley tomorrow',
    'before sunset', 'Bingley two parsecs before sunset', 'an hour after',
    'Bingley an hour after sunset 6PM'])('does not partly execute %s', text => {
    expect(parseGoToString(text)).toBeNull();
});

test('bare numbers remain chat replies, explicit frames navigate', () => {
    expect(parseGoToString('2')).toEqual({kind: 'frame', frame: 2});
    expect(parseGoToString('2', {chat: true, allowBarePlace: true})).toBeNull();
    expect(parseGoToString('go to frame 2', {chat: true})).toEqual({kind: 'frame', frame: 2});
});

test('date and coordinate commas are not mistaken for multiple commands', () => {
    expect(parseGoToString('Jan 6, 2027')).toEqual({kind: 'time', time: 'Jan 6, 2027'});
    expect(parseGoToString('40, -74, 300')).toEqual({kind: 'location', location: '40, -74, 300', coordinates: expect.objectContaining({lat: 40, lon: -74, alt: 300})});
});

test.each(['yesterday', 'tomorrow', 'now', 'time to 10AM', 'set time to 10AM', 'set time 2',
    'Sunset', 'Sunrise', 'Moonset', 'moonrise', 'morning', 'evening', 'night', 'dusk', 'dawn'])('chat and dialog share time grammar: %s', text => {
    expect(parseGoToString(text, {chat: true})).toEqual(parseGoToString(text));
    expect(parseGoToString(text).kind).toBe('time');
});
